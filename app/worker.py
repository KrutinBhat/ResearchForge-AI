import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .core.config import get_settings
from .core.database import SessionLocal
from .models.entities import (
    AnalysisJob,
    Citation,
    CitationCheck,
    Document,
    RefinementJob,
    SimilarityReport,
)
from .services.citation_service import (
    evaluate_claim_support,
    lookup_citation_registries,
    parse_reference_lines,
    reconcile_citations_and_references,
)
from .services.generator_refinement_service import refine_sections_academic
from .services.similarity_service import (
    BUILTIN_CORPUS,
    analyze_text_similarity,
    query_pgvector_similar_chunks,
)

settings = get_settings()

try:
    from celery import Celery

    broker = settings.CELERY_BROKER_URL or settings.REDIS_URL or ""
    backend = settings.CELERY_RESULT_BACKEND or settings.REDIS_URL or ""
    if broker:
        celery_app = Celery("researchforge", broker=broker, backend=backend or "rpc://")
        celery_app.conf.task_soft_time_limit = settings.JOB_TIMEOUT_SECONDS
        celery_app.conf.task_time_limit = settings.JOB_TIMEOUT_SECONDS + 30
        celery_app.conf.task_acks_late = True
        celery_app.conf.worker_prefetch_multiplier = 1
    else:
        celery_app = None
except Exception:
    celery_app = None


def is_celery_configured() -> bool:
    return celery_app is not None and bool(settings.CELERY_BROKER_URL or settings.REDIS_URL)


def check_redis_health() -> Optional[bool]:
    url = settings.REDIS_URL or settings.CELERY_BROKER_URL
    if not url:
        return None
    try:
        import redis

        client = redis.from_url(url, socket_connect_timeout=1.5, socket_timeout=1.5)
        return bool(client.ping())
    except Exception:
        return False


def dispatch_refinement_job(job_id: str, background_tasks: Any = None) -> str:
    if is_celery_configured() and celery_app is not None:
        celery_app.send_task("researchforge.run_refinement_job", args=[job_id])
        return "celery"
    if background_tasks is not None:
        background_tasks.add_task(execute_refinement_job_sync, job_id)
        return "background"
    return "inline"


def dispatch_analysis_job(job_id: str, background_tasks: Any = None) -> str:
    if is_celery_configured() and celery_app is not None:
        celery_app.send_task("researchforge.run_analysis_job", args=[job_id])
        return "celery"
    if background_tasks is not None:
        background_tasks.add_task(execute_analysis_job_sync, job_id)
        return "background"
    return "inline"


def recover_interrupted_jobs() -> int:
    """Safely re-queue or fail stale in-flight jobs left from a hard crash within retry bounds."""
    db = SessionLocal()
    recovered = 0
    try:
        stale_ref = (
            db.query(RefinementJob)
            .filter(RefinementJob.status.in_(["queued", "processing"]), RefinementJob.cancelled.is_(False))
            .all()
        )
        for job in stale_ref:
            if job.status == "processing":
                if job.retries < settings.JOB_MAX_RETRIES:
                    job.retries += 1
                    job.status = "queued"
                    job.progress = 5
                    job.error_message = "Recovered after worker restart; re-queued automatically."
                    if is_celery_configured() and celery_app is not None:
                        celery_app.send_task("researchforge.run_refinement_job", args=[job.id])
                else:
                    job.status = "failed"
                    job.error_message = "Worker restarted repeatedly and exceeded retry budget. Click Retry to resume."
                recovered += 1

        stale_ana = (
            db.query(AnalysisJob)
            .filter(AnalysisJob.status.in_(["queued", "processing"]), AnalysisJob.cancelled.is_(False))
            .all()
        )
        for job in stale_ana:
            if job.status == "processing":
                if job.retries < settings.JOB_MAX_RETRIES:
                    job.retries += 1
                    job.status = "queued"
                    job.progress = 5
                    job.error_message = "Recovered after worker restart; re-queued automatically."
                    if is_celery_configured() and celery_app is not None:
                        celery_app.send_task("researchforge.run_analysis_job", args=[job.id])
                else:
                    job.status = "failed"
                    job.error_message = "Worker restarted repeatedly and exceeded retry budget. Click Retry to resume."
                recovered += 1

        if recovered:
            db.commit()
    finally:
        db.close()
    return recovered


def _extract_refinement_payload(job: RefinementJob) -> Dict[str, Any]:
    try:
        data = json.loads(job.payload_json or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def execute_refinement_job_sync(
    job_id: str,
    section_ids: Optional[List[str]] = None,
    preserve_terms: Optional[str] = None,
    engine_mode: Optional[str] = None,
    paragraph_index: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        job = db.query(RefinementJob).filter(RefinementJob.id == job_id).first()
        if not job:
            return {"status": "missing"}
        if job.cancelled or job.status == "cancelled":
            job.status = "cancelled"
            db.commit()
            return {"status": "cancelled"}
        if job.status in {"completed", "approved"}:
            return {"status": job.status, "jobId": job.id, "idempotent": True}
        if job.status == "processing":
            return {"status": "processing", "jobId": job.id, "idempotent": True}

        stored = _extract_refinement_payload(job)
        eff_section_ids = section_ids if section_ids is not None else stored.get("sectionIds")
        eff_preserve = preserve_terms if preserve_terms is not None else str(stored.get("preserveTerms") or "")
        eff_engine = engine_mode or str(stored.get("engineMode") or "gemini")
        eff_para_idx = paragraph_index if paragraph_index is not None else stored.get("paragraphIndex")
        eff_para_text = (stored.get("paragraphText") or "").strip()

        doc = db.query(Document).filter(Document.id == job.document_id).first()
        if not doc:
            job.status = "failed"
            job.error_message = "Target manuscript no longer exists."
            db.commit()
            return {"status": "failed"}

        job.status = "processing"
        job.progress = 15
        db.commit()

        all_sections = json.loads(doc.sections_json or "[]")
        if eff_para_text and job.scope in {"single_paragraph", "selected_paragraphs"}:
            target_sections = [{"id": "selected_paragraph", "heading": "Selected Paragraph", "content": eff_para_text}]
        elif job.scope == "selected_sections" and eff_section_ids:
            selected_set = set(eff_section_ids)
            target_sections = [s for s in all_sections if s.get("id") in selected_set]
        else:
            target_sections = all_sections

        results = asyncio.run(
            refine_sections_academic(
                sections=target_sections,
                mode=job.mode,
                preserve_terms=eff_preserve,
                engine_mode=eff_engine,
                gemini_api_key=settings.GEMINI_API_KEY,
                ollama_base_url=settings.OLLAMA_BASE_URL,
                ollama_model=settings.OLLAMA_MODEL,
                paragraph_index=eff_para_idx if not eff_para_text else None,
            )
        )

        db.refresh(job)
        if job.cancelled:
            job.status = "cancelled"
            db.commit()
            return {"status": "cancelled"}

        metrics = {
            "sectionsRefined": len(results),
            "allCitationsPreserved": all(r["preservation"]["citationsPreserved"] for r in results),
            "allEquationsPreserved": all(r["preservation"]["equationsPreserved"] for r in results),
            "meaningRetained": all(r["preservation"]["meaningRetained"] for r in results),
            "engineUsed": results[0].get("engineUsed", "local-structural") if results else "local-structural",
        }
        job.refined_sections_json = json.dumps(results)
        job.metrics_json = json.dumps(metrics)
        job.progress = 100
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return {"status": "completed", "jobId": job.id}
    except Exception as exc:
        job = db.query(RefinementJob).filter(RefinementJob.id == job_id).first()
        if job and not job.cancelled:
            job.status = "failed"
            job.error_message = str(exc)[:500]
            db.commit()
        raise
    finally:
        db.close()


def execute_analysis_job_sync(job_id: str) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id).first()
        if not job:
            return {"status": "missing"}
        if job.cancelled or job.status == "cancelled":
            job.status = "cancelled"
            db.commit()
            return {"status": "cancelled"}
        if job.status == "completed":
            return {"status": "completed", "jobId": job.id, "idempotent": True}
        if job.status == "processing":
            return {"status": "processing", "jobId": job.id, "idempotent": True}

        payload = json.loads(job.payload_json or "{}")
        job.status = "processing"
        job.progress = 15
        db.commit()

        if job.job_type == "similarity_analyze":
            text = payload.get("text") or ""
            title = payload.get("title") or "Async Similarity Scan"
            doc_id = job.target_id
            if doc_id:
                doc = db.query(Document).filter(Document.id == doc_id, Document.user_id == job.user_id).first()
                if doc:
                    text = doc.raw_text
                    title = doc.title
            pg_chunks = query_pgvector_similar_chunks(db, job.user_id, text, exclude_document_id=doc_id, limit=8)
            pg_doc_ids = {c["id"] for c in pg_chunks}
            workspace_docs = [
                {"id": d.id, "title": d.title, "authors": "", "year": str(d.created_at.year), "url": "", "source": "Workspace Document", "text": d.raw_text}
                for d in db.query(Document).filter(Document.user_id == job.user_id).all()
                if (doc_id is None or d.id != doc_id) and d.id not in pg_doc_ids
            ]
            result = analyze_text_similarity(text, BUILTIN_CORPUS + pg_chunks + workspace_docs, arxiv_count=0)
            rec = SimilarityReport(
                user_id=job.user_id,
                document_id=doc_id,
                title=title,
                overall_similarity=result["overallSimilarityPercent"],
                corpus_coverage=result["corpusCoverage"]["limitationNotice"],
                results_json=json.dumps(result),
            )
            db.add(rec)
            db.commit()
            db.refresh(rec)
            job.result_json = json.dumps({"id": rec.id, **result})
        elif job.job_type == "citations_verify":
            refs = parse_reference_lines(payload.get("referencesText") or "")
            full_text = payload.get("referencesText") or ""
            title = payload.get("title") or "Async Citation Audit"
            doc_id = job.target_id
            if doc_id:
                doc = db.query(Document).filter(Document.id == doc_id, Document.user_id == job.user_id).first()
                if doc:
                    refs = json.loads(doc.references_json or "[]")
                    full_text = doc.raw_text
                    title = doc.title

            sem = asyncio.Semaphore(5)

            async def _bounded_lookup(ref_line: str):
                async with sem:
                    return await lookup_citation_registries(
                        ref_line,
                        mailto=settings.CONTACT_MAILTO,
                        claim_context=payload.get("claimText") or "",
                    )

            async def _verify_all():
                return await asyncio.gather(*[_bounded_lookup(r) for r in refs[:25]])

            checked = asyncio.run(_verify_all())
            reconciliation = reconcile_citations_and_references(full_text, refs)
            claim_check = evaluate_claim_support(payload["claimText"], payload.get("sourceTitle") or "") if payload.get("claimText") else None
            for c in checked:
                db.add(
                    Citation(
                        user_id=job.user_id,
                        document_id=doc_id,
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
            rec = CitationCheck(
                user_id=job.user_id,
                document_id=doc_id,
                title=title,
                citations_json=json.dumps(checked),
                summary_json=json.dumps(summary),
            )
            db.add(rec)
            db.commit()
            db.refresh(rec)
            job.result_json = json.dumps({"id": rec.id, "checkId": rec.id, "title": title, "audit": {"citations": checked, "summary": summary}, "citations": checked, "summary": summary, "claimRelevance": claim_check})
        else:
            raise ValueError(f"Unsupported analysis job type: {job.job_type}")

        db.refresh(job)
        if job.cancelled:
            job.status = "cancelled"
            db.commit()
            return {"status": "cancelled"}

        job.progress = 100
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return {"status": "completed", "jobId": job.id}
    except Exception as exc:
        job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id).first()
        if job and not job.cancelled:
            job.status = "failed"
            job.error_message = str(exc)[:500]
            db.commit()
        raise
    finally:
        db.close()


if celery_app is not None:
    try:
        from celery.exceptions import SoftTimeLimitExceeded
    except Exception:
        SoftTimeLimitExceeded = TimeoutError  # type: ignore

    @celery_app.task(name="researchforge.run_refinement_job", bind=True, max_retries=settings.JOB_MAX_RETRIES)
    def run_refinement_job_task(self, job_id: str, *_args):
        try:
            return execute_refinement_job_sync(job_id)
        except SoftTimeLimitExceeded:
            return {"status": "failed", "error": "Refinement job exceeded worker soft time limit."}
        except Exception as exc:
            if self.request.retries < self.max_retries:
                raise self.retry(exc=exc, countdown=2 ** (self.request.retries + 1))
            return {"status": "failed", "error": str(exc)}

    @celery_app.task(name="researchforge.run_analysis_job", bind=True, max_retries=settings.JOB_MAX_RETRIES)
    def run_analysis_job_task(self, job_id: str):
        try:
            return execute_analysis_job_sync(job_id)
        except SoftTimeLimitExceeded:
            return {"status": "failed", "error": "Analysis job exceeded worker soft time limit."}
        except Exception as exc:
            if self.request.retries < self.max_retries:
                raise self.retry(exc=exc, countdown=2 ** (self.request.retries + 1))
            return {"status": "failed", "error": str(exc)}

