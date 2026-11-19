import asyncio
import json
import re
import xml.etree.ElementTree as ET
import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...core.security import validate_outbound_https_url
from ...models.entities import (
    AnalysisJob,
    Citation,
    CitationCheck,
    Document,
    QualityEvaluation,
    SimilarityReport,
    User,
    WritingAnalysis,
)
from ...schemas.common import (
    CitationBibtexExportRequest,
    CitationBibtexVerifyRequest,
    CitationVerifyRequest,
    QualityEvaluateRequest,
    SimilarityAnalyzeRequest,
    WritingAnalyzeRequest,
)
from ...services.citation_service import (
    evaluate_claim_support,
    export_bibtex_collection,
    extract_reference_identifiers,
    lookup_citation_registries,
    parse_reference_lines,
    reconcile_citations_and_references,
    title_similarity,
    verify_bibtex_entries,
)
from ...services.quality_audit_service import evaluate_research_quality_with_llm
from ...services.similarity_service import (
    BUILTIN_CORPUS,
    analyze_text_similarity,
    query_pgvector_similar_chunks,
)
from ...services.writing_service import analyze_writing_patterns
from ...worker import dispatch_analysis_job
from ..deps import get_current_user, get_owned_or_404, record_activity

router = APIRouter(tags=["Similarity, Stylometrics, Citations & Quality"])

ALLOWED_ARXIV_HOSTS = {"export.arxiv.org"}


def _resolve_text_source(db: Session, user_id: str, document_id: str | None, fallback_text: str | None, fallback_title: str):
    if document_id:
        doc = get_owned_or_404(db, Document, document_id, user_id, "Document not found.")
        return doc, doc.raw_text, doc.title
    if not fallback_text or not fallback_text.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide either documentId or text.")
    return None, fallback_text, fallback_title


def _format_citation_for_ui(idx: int, c: dict, full_text: str = "") -> dict:
    raw_ref = c.get("raw") or c.get("rawReference") or ""
    ident = extract_reference_identifiers(raw_ref)
    matched_title = c.get("matchedTitle") or ""
    guessed = ident.get("guessedTitle") or raw_ref
    t_score = round(title_similarity(guessed, matched_title), 3) if matched_title and guessed else (1.0 if matched_title else 0.0)
    authors = c.get("authors") or []
    venue = c.get("venue")
    registry = c.get("registry") or "None"
    claim_eval = c.get("claimEvaluation") or {}
    flags: list[str] = []
    if c.get("yearMatch") is False and matched_title:
        flags.append(f"Year mismatch: reference lists {ident.get('year')}, registry reports {c.get('year')}.")
    if c.get("status") == "Unverified":
        flags.append(c.get("detailedStatus") or "No matching record confirmed across scholarly registries.")

    cited_in_text = True
    idx_match = re.match(r"^\[(\d+)\]", raw_ref.strip())
    if full_text.strip() and idx_match:
        idx_num = idx_match.group(1)
        body_only = re.split(r"\nreferences\b", full_text, flags=re.IGNORECASE)[0]
        cited_in_text = bool(re.search(rf"\[(?:[^\]]*,\s*)?{re.escape(idx_num)}(?:\s*,[^\]]*)?\]", body_only))
        if not cited_in_text:
            flags.append(f"Reference [{idx_num}] appears in bibliography but is not cited in manuscript body.")

    author_matched = None
    if authors and raw_ref:
        first_surname = authors[0].split()[-1].lower()
        author_matched = first_surname in raw_ref.lower() if len(first_surname) >= 2 else None

    cred_note = f"{registry} indexed ({venue})" if venue else (f"{registry} record matched" if matched_title else "Not indexed in queried open registries")

    verified_meta = (
        {
            "title": matched_title,
            "authors": authors,
            "year": int(c["year"]) if str(c.get("year") or "").isdigit() else c.get("year"),
            "venue": venue,
            "doi": c.get("doi"),
            "url": c.get("url") or "",
            "volume": c.get("volume"),
            "issue": c.get("issue"),
            "pages": c.get("pages"),
            "publisher": c.get("publisher"),
            "isbn": c.get("isbn"),
            "entryType": c.get("entryType") or "misc",
            "credibilityNote": cred_note,
        }
        if matched_title
        else None
    )

    return {
        **c,
        "id": f"cit_{idx + 1}",
        "rawReference": raw_ref,
        "bibliographicStatus": c.get("detailedStatus") or ("Bibliographic metadata verified" if matched_title else "Verification unavailable"),
        "claimSupportStatus": claim_eval.get("claimStatus") or ("Source retrieved" if c.get("sourceRetrieved") else "Evidence insufficient"),
        "matchedProvider": registry,
        "titleMatchScore": t_score,
        "yearMatched": c.get("yearMatch") if matched_title else None,
        "authorMatched": author_matched,
        "verifiedMetadata": verified_meta,
        "formattedIEEE": c.get("ieeeFormatted") or raw_ref,
        "formattedAPA": c.get("apaFormatted") or raw_ref,
        "flags": flags,
        "citedInText": cited_in_text,
    }


async def _fetch_arxiv_corpus_samples(query_text: str) -> list[dict]:
    keywords = " ".join(query_text.split()[:6])
    if not keywords:
        return []
    try:
        target_url = validate_outbound_https_url("https://export.arxiv.org/api/query", ALLOWED_ARXIV_HOSTS)
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(
                target_url,
                params={"search_query": f"all:{keywords}", "start": 0, "max_results": 3},
            )
            if r.status_code != 200:
                return []
            root = ET.fromstring(r.text)
            ns = {"a": "http://www.w3.org/2005/Atom"}
            items = []
            for entry in root.findall("a:entry", ns):
                title = (entry.findtext("a:title", "", ns) or "").strip()
                summary = (entry.findtext("a:summary", "", ns) or "").strip()
                authors = ", ".join((a.findtext("a:name", "", ns) or "") for a in entry.findall("a:author", ns)[:3])
                year = (entry.findtext("a:published", "", ns) or "")[:4]
                entry_id = entry.findtext("a:id", "", ns) or ""
                if title and summary:
                    items.append({
                        "id": entry_id or title,
                        "title": title,
                        "authors": authors,
                        "year": year,
                        "url": entry_id,
                        "source": "arXiv Live Abstract",
                        "text": summary,
                    })
            return items
    except Exception:
        return []


@router.post("/similarity/analyze")
async def analyze_similarity(
    payload: SimilarityAnalyzeRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc, text, title = _resolve_text_source(db, current_user.id, payload.documentId, payload.text, payload.title)

    if payload.asyncJob:
        job = AnalysisJob(
            user_id=current_user.id,
            job_type="similarity_analyze",
            target_id=doc.id if doc else None,
            status="queued",
            progress=5,
            payload_json=json.dumps({"text": text[:40000], "title": title, "queryArxiv": payload.queryArxiv}),
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        dispatch_mode = dispatch_analysis_job(job.id, background_tasks)
        return {"jobId": job.id, "id": job.id, "status": job.status, "dispatch": dispatch_mode}

    pg_chunks = query_pgvector_similar_chunks(db, current_user.id, text, exclude_document_id=doc.id if doc else None, limit=8)
    pg_doc_ids = {c["id"] for c in pg_chunks}

    workspace_docs = [
        {"id": d.id, "title": d.title, "authors": current_user.name, "year": str(d.created_at.year), "url": "", "source": "Workspace Document", "text": d.raw_text}
        for d in db.query(Document).filter(Document.user_id == current_user.id).all()
        if (doc is None or d.id != doc.id) and d.id not in pg_doc_ids
    ]
    arxiv_docs = await _fetch_arxiv_corpus_samples(text) if payload.queryArxiv else []
    corpus = BUILTIN_CORPUS + pg_chunks + workspace_docs + arxiv_docs
    result = analyze_text_similarity(text, corpus, arxiv_count=len(arxiv_docs))

    record = SimilarityReport(
        user_id=current_user.id,
        document_id=doc.id if doc else None,
        title=title,
        overall_similarity=result["overallSimilarityPercent"],
        corpus_coverage=result["corpusCoverage"]["limitationNotice"],
        results_json=json.dumps(result),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    record_activity(db, current_user.id, "Similarity Engine", "Ran Similarity Analysis", title)
    return {"id": record.id, "reportId": record.id, "title": title, "result": result, **result}


@router.post("/writing-analysis/analyze")
def analyze_writing(
    payload: WritingAnalyzeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc, text, title = _resolve_text_source(db, current_user.id, payload.documentId, payload.text, payload.title)
    result = analyze_writing_patterns(text)

    record = WritingAnalysis(
        user_id=current_user.id,
        document_id=doc.id if doc else None,
        title=title,
        metrics_json=json.dumps(result["metrics"]),
        observations_json=json.dumps(result["observations"]),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    record_activity(db, current_user.id, "Writing Analyzer", "Analyzed Stylometrics", title)
    return {"id": record.id, "analysisId": record.id, "title": title, "analysis": result, **result}


@router.post("/citations/verify")
async def verify_citations(
    payload: CitationVerifyRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    doc = None
    refs: list[str] = []
    full_text = ""
    title = "Ad-hoc Citation Audit"

    if payload.documentId:
        doc = get_owned_or_404(db, Document, payload.documentId, current_user.id, "Document not found.")
        refs = json.loads(doc.references_json or "[]")
        full_text = doc.raw_text
        title = doc.title
    elif payload.referencesText:
        refs = parse_reference_lines(payload.referencesText)
        full_text = payload.referencesText
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide documentId or referencesText.")

    if not refs:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No references found to verify. Paste bibliography lines or select a document with references.",
        )

    if payload.asyncJob:
        job = AnalysisJob(
            user_id=current_user.id,
            job_type="citations_verify",
            target_id=doc.id if doc else None,
            status="queued",
            progress=5,
            payload_json=json.dumps({
                "referencesText": payload.referencesText or "",
                "claimText": payload.claimText or "",
                "sourceTitle": payload.sourceTitle or "",
                "title": title,
            }),
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        dispatch_mode = dispatch_analysis_job(job.id, background_tasks)
        return {"jobId": job.id, "id": job.id, "status": job.status, "dispatch": dispatch_mode}

    sem = asyncio.Semaphore(5)

    async def _bounded_lookup(ref_line: str):
        async with sem:
            return await lookup_citation_registries(ref_line, mailto=settings.CONTACT_MAILTO, claim_context=payload.claimText or "")

    checked_raw = await asyncio.gather(*[_bounded_lookup(r) for r in refs[:25]])
    checked = [_format_citation_for_ui(idx, item, full_text) for idx, item in enumerate(checked_raw)]
    reconciliation = reconcile_citations_and_references(full_text, refs)
    claim_eval = (
        evaluate_claim_support(payload.claimText, payload.sourceTitle or "")
        if payload.claimText
        else None
    )
    claim_check_ui = (
        {
            "overlapScore": claim_eval.get("overlapScore", 0.0),
            "sharedConcepts": claim_eval.get("sharedTerms", []),
            "claimSupportStatus": claim_eval.get("claimStatus", "Evidence insufficient"),
            "assessment": claim_eval.get("explanation", ""),
        }
        if claim_eval
        else None
    )

    for c in checked:
        db.add(
            Citation(
                user_id=current_user.id,
                document_id=doc.id if doc else None,
                raw_reference=c["raw"],
                doi=c.get("doi") or "",
                title=c.get("matchedTitle") or "",
                authors=", ".join(c.get("authors") or [])[:500],
                year=str(c.get("year") or ""),
                venue=str(c.get("venue") or ""),
                url=str(c.get("url") or ""),
                verification_status=c.get("detailedStatus", "Verification unavailable"),
                claim_support_status=(c.get("claimEvaluation") or {}).get("claimStatus", "Evidence insufficient"),
                source_provider=c.get("registry", "None"),
                details_json=json.dumps(c),
            )
        )

    dup_labels = [f"[{d['indexB']}] (matches [{d['indexA']}])" for d in reconciliation.get("duplicateReferences", [])]
    summary = {
        "totalReferences": len(checked),
        "totalChecked": len(checked),
        "verifiedCount": sum(1 for c in checked if c["status"] == "Verified"),
        "needsReviewCount": sum(1 for c in checked if c["status"] == "Needs review"),
        "unverifiedCount": sum(1 for c in checked if c["status"] == "Unverified"),
        "orphanedInTextCitations": [f"[{i}]" for i in reconciliation.get("missingFromBibliography", [])],
        "uncitedReferences": [f"[{i}]" for i in reconciliation.get("unusedReferences", [])],
        "duplicateReferences": dup_labels,
        "reconciliation": reconciliation,
    }

    record = CitationCheck(
        user_id=current_user.id,
        document_id=doc.id if doc else None,
        title=title,
        citations_json=json.dumps(checked),
        summary_json=json.dumps(summary),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    record_activity(db, current_user.id, "Citation Engine", "Verified References", title)
    return {
        "id": record.id,
        "checkId": record.id,
        "title": title,
        "audit": {"citations": checked, "summary": summary},
        "claimCheck": claim_check_ui,
        "citations": checked,
        "summary": summary,
        "claimRelevance": claim_eval,
    }


@router.post("/citations/export-bibtex")
def export_citations_bibtex(
    payload: CitationBibtexExportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items: list[dict] = []
    if payload.citations:
        items = [
            c if isinstance(c, dict) else {"id": f"ref_{idx + 1}", "rawReference": str(c), "status": "Unverified"}
            for idx, c in enumerate(payload.citations)
        ]
    elif payload.documentId:
        doc = get_owned_or_404(db, Document, payload.documentId, current_user.id, "Document not found.")
        persisted = (
            db.query(Citation)
            .filter(Citation.document_id == doc.id, Citation.user_id == current_user.id)
            .order_by(Citation.created_at.desc())
            .all()
        )
        if persisted:
            seen_raw: set[str] = set()
            for row in persisted:
                if row.raw_reference in seen_raw:
                    continue
                seen_raw.add(row.raw_reference)
                try:
                    detail = json.loads(row.details_json or "{}")
                except Exception:
                    detail = {}
                if detail:
                    items.append(detail)
                else:
                    items.append({
                        "id": row.id,
                        "rawReference": row.raw_reference,
                        "matchedTitle": row.title,
                        "authors": [a.strip() for a in row.authors.split(",") if a.strip()],
                        "year": row.year,
                        "venue": row.venue,
                        "doi": row.doi,
                        "url": row.url,
                        "status": "Verified" if "verified" in row.verification_status.lower() else "Unverified",
                    })
        else:
            raw_refs = json.loads(doc.references_json or "[]")
            items = [
                {"id": f"ref_{idx + 1}", "rawReference": str(r), "status": "Unverified"}
                for idx, r in enumerate(raw_refs)
            ]
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide citations or documentId.")

    return export_bibtex_collection(items, include_unverified=payload.includeUnverified)


@router.post("/citations/verify-bibtex")
async def verify_citations_bibtex(
    payload: CitationBibtexVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    result = await verify_bibtex_entries(
        payload.bibtexText,
        mailto=settings.CONTACT_MAILTO,
        include_unverified=payload.includeUnverified,
    )
    if result["summary"]["totalEntries"] == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid BibTeX entries (@type{key, ...}) could be parsed from the provided input.",
        )

    for entry in result["entries"]:
        db.add(
            Citation(
                user_id=current_user.id,
                document_id=None,
                raw_reference=entry["rawReference"],
                doi=entry.get("doi") or "",
                title=entry.get("matchedTitle") or entry["declared"].get("title") or "",
                authors=", ".join(entry.get("authors") or [])[:500],
                year=str(entry.get("year") or ""),
                venue=str(entry.get("venue") or ""),
                url=str(entry.get("url") or ""),
                verification_status=entry.get("bibliographicStatus", "Verification unavailable"),
                claim_support_status="Source retrieved" if entry.get("verifiedMetadata") else "Evidence insufficient",
                source_provider=entry.get("matchedProvider", "None"),
                details_json=json.dumps(entry),
            )
        )

    rec = CitationCheck(
        user_id=current_user.id,
        document_id=None,
        title="BibTeX Cross-Reference Verification",
        citations_json=json.dumps(result["entries"]),
        summary_json=json.dumps(result["summary"]),
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    record_activity(
        db,
        current_user.id,
        "Citation Engine",
        f"Verified {result['summary']['verifiedCount']}/{result['summary']['totalEntries']} BibTeX entries",
        "BibTeX Audit",
    )
    return {"checkId": rec.id, **result}


@router.post("/research-quality/evaluate")
async def evaluate_quality(
    payload: QualityEvaluateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    doc, text, title = _resolve_text_source(db, current_user.id, payload.documentId, payload.text, payload.title)
    result = await evaluate_research_quality_with_llm(
        text,
        title=title,
        gemini_api_key=settings.GEMINI_API_KEY if payload.includeLlmCritique else "",
        gemini_model=settings.GEMINI_MODEL,
    )

    record = QualityEvaluation(
        user_id=current_user.id,
        document_id=doc.id if doc else None,
        title=title,
        dimensions_json=json.dumps(result["dimensions"]),
        recommendations_json=json.dumps(result["recommendations"]),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    record_activity(db, current_user.id, "Quality Evaluator", "Evaluated Methodology Rubric", title)
    return {"id": record.id, "evaluationId": record.id, "title": title, "evaluation": result, **result}


