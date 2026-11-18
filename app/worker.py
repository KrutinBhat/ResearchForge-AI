import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Dict

from .core.config import get_settings
from .core.database import SessionLocal
from .models.entities import AnalysisJob, Document, RefinementJob
from .services.generator_refinement_service import refine_sections_academic

settings = get_settings()

try:
    from celery import Celery

    broker = settings.CELERY_BROKER_URL or settings.REDIS_URL or "memory://"
    backend = settings.CELERY_RESULT_BACKEND or settings.REDIS_URL or "rpc://"
    celery_app = Celery("researchforge", broker=broker, backend=backend)
    celery_app.conf.task_soft_time_limit = settings.JOB_TIMEOUT_SECONDS
    celery_app.conf.task_time_limit = settings.JOB_TIMEOUT_SECONDS + 30
except Exception:
    celery_app = None


def recover_interrupted_jobs() -> int:
    """Mark any stale in-flight jobs left from a hard crash as failed so users can retry safely."""
    db = SessionLocal()
    recovered = 0
    try:
        stale_ref = db.query(RefinementJob).filter(RefinementJob.status == "processing").all()
        for job in stale_ref:
            job.status = "failed"
            job.error_message = "Worker restarted while job was in progress. Click Retry to resume."
            recovered += 1
        stale_ana = db.query(AnalysisJob).filter(AnalysisJob.status == "processing").all()
        for job in stale_ana:
            job.status = "failed"
            job.error_message = "Worker restarted while job was in progress. Retry supported."
            recovered += 1
        if recovered:
            db.commit()
    finally:
        db.close()
    return recovered


def execute_refinement_job_sync(
    job_id: str,
    section_ids: list[str] | None = None,
    preserve_terms: str = "",
    engine_mode: str = "gemini",
    paragraph_index: int | None = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        job = db.query(RefinementJob).filter(RefinementJob.id == job_id).first()
        if not job or job.cancelled:
            return {"status": "cancelled"}

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
        target_sections = (
            [s for s in all_sections if s.get("id") in set(section_ids)]
            if (job.scope == "selected_sections" and section_ids)
            else all_sections
        )

        results = asyncio.run(
            refine_sections_academic(
                sections=target_sections,
                mode=job.mode,
                preserve_terms=preserve_terms,
                engine_mode=engine_mode,
                gemini_api_key=settings.GEMINI_API_KEY,
                ollama_base_url=settings.OLLAMA_BASE_URL,
                ollama_model=settings.OLLAMA_MODEL,
                paragraph_index=paragraph_index,
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
        if job:
            job.status = "failed"
            job.error_message = str(exc)
            db.commit()
        return {"status": "failed", "error": str(exc)}
    finally:
        db.close()


if celery_app is not None:
    @celery_app.task(name="researchforge.run_refinement_job", bind=True, max_retries=2)
    def run_refinement_job_task(self, job_id: str, section_ids=None, preserve_terms: str = "", engine_mode: str = "gemini", paragraph_index=None):
        return execute_refinement_job_sync(job_id, section_ids, preserve_terms, engine_mode, paragraph_index)
