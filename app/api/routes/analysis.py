import json
import xml.etree.ElementTree as ET
import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...models.entities import (
    Citation,
    CitationCheck,
    Document,
    QualityEvaluation,
    SimilarityReport,
    User,
    WritingAnalysis,
)
from ...schemas.common import (
    CitationVerifyRequest,
    QualityEvaluateRequest,
    SimilarityAnalyzeRequest,
    WritingAnalyzeRequest,
)
from ...services.citation_service import (
    evaluate_claim_support,
    lookup_citation_registries,
    parse_reference_lines,
    reconcile_citations_and_references,
)
from ...services.quality_audit_service import evaluate_research_quality_with_llm
from ...services.similarity_service import BUILTIN_CORPUS, analyze_text_similarity
from ...services.writing_service import analyze_writing_patterns
from ..deps import get_current_user, record_activity

router = APIRouter(tags=["Similarity, Stylometrics, Citations & Quality"])


def _resolve_text_source(db: Session, user_id: str, document_id: str | None, fallback_text: str | None, fallback_title: str):
    if document_id:
        doc = db.query(Document).filter(Document.id == document_id, Document.user_id == user_id).first()
        if not doc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
        return doc, doc.raw_text, doc.title
    if not fallback_text or not fallback_text.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide either documentId or text.")
    return None, fallback_text, fallback_title


async def _fetch_arxiv_corpus_samples(query_text: str) -> list[dict]:
    keywords = " ".join(query_text.split()[:6])
    if not keywords:
        return []
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(
                "https://export.arxiv.org/api/query",
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc, text, title = _resolve_text_source(db, current_user.id, payload.documentId, payload.text, payload.title)
    workspace_docs = [
        {"id": d.id, "title": d.title, "authors": current_user.name, "year": str(d.created_at.year), "url": "", "source": "Workspace Document", "text": d.raw_text}
        for d in db.query(Document).filter(Document.user_id == current_user.id).all()
        if doc is None or d.id != doc.id
    ]
    arxiv_docs = await _fetch_arxiv_corpus_samples(text) if payload.queryArxiv else []
    corpus = BUILTIN_CORPUS + workspace_docs + arxiv_docs
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
    return {"id": record.id, **result}


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
    return {"id": record.id, **result}


@router.post("/citations/verify")
async def verify_citations(
    payload: CitationVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    doc = None
    refs: list[str] = []
    full_text = ""
    title = "Ad-hoc Citation Audit"

    if payload.documentId:
        doc = db.query(Document).filter(Document.id == payload.documentId, Document.user_id == current_user.id).first()
        if not doc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
        refs = json.loads(doc.references_json or "[]")
        full_text = doc.raw_text
        title = doc.title
    elif payload.referencesText:
        refs = parse_reference_lines(payload.referencesText)
        full_text = payload.referencesText
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide documentId or referencesText.")

    checked = [await lookup_citation_registries(r, mailto=settings.CONTACT_MAILTO, claim_context=payload.claimText or "") for r in refs[:25]]
    reconciliation = reconcile_citations_and_references(full_text, refs)
    claim_check = (
        evaluate_claim_support(payload.claimText, payload.sourceTitle or "")
        if payload.claimText
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

    summary = {
        "totalReferences": len(checked),
        "totalChecked": len(checked),
        "verifiedCount": sum(1 for c in checked if c["status"] == "Verified"),
        "needsReviewCount": sum(1 for c in checked if c["status"] == "Needs review"),
        "unverifiedCount": sum(1 for c in checked if c["status"] == "Unverified"),
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
    return {"id": record.id, "citations": checked, "summary": summary, "claimRelevance": claim_check}


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
    return {"id": record.id, **result}
