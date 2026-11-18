import json
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...models.entities import (
    ActivityLog,
    CitationCheck,
    Document,
    DocumentVersion,
    IntegrityAudit,
    Project,
    QualityEvaluation,
    RefinementJob,
    SimilarityReport,
    User,
    WritingAnalysis,
)
from ...schemas.common import IntegrityAuditRequest, RefinementApproveRequest, RefinementStartRequest
from ...services.project_analyzer_service import cross_check_paper_against_code
from ...services.quality_audit_service import build_integrity_audit, export_audit_markdown
from ...services.writing_service import analyze_writing_patterns
from ...worker import celery_app, execute_refinement_job_sync
from ..deps import get_current_user, record_activity

router = APIRouter(tags=["Dashboard, Integrity Audit, Paper Refinement & Reports"])


@router.get("/dashboard/summary")
def dashboard_summary(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    docs = db.query(Document).filter(Document.user_id == current_user.id).order_by(Document.updated_at.desc()).limit(5).all()
    projs = db.query(Project).filter(Project.user_id == current_user.id).order_by(Project.updated_at.desc()).limit(5).all()
    audits = db.query(IntegrityAudit).filter(IntegrityAudit.user_id == current_user.id).order_by(IntegrityAudit.created_at.desc()).limit(5).all()
    acts = db.query(ActivityLog).filter(ActivityLog.user_id == current_user.id).order_by(ActivityLog.created_at.desc()).limit(10).all()

    return {
        "counts": {
            "documents": db.query(Document).filter(Document.user_id == current_user.id).count(),
            "projects": db.query(Project).filter(Project.user_id == current_user.id).count(),
            "similarityReports": db.query(SimilarityReport).filter(SimilarityReport.user_id == current_user.id).count(),
            "citationChecks": db.query(CitationCheck).filter(CitationCheck.user_id == current_user.id).count(),
            "integrityAudits": db.query(IntegrityAudit).filter(IntegrityAudit.user_id == current_user.id).count(),
        },
        "recentDocuments": [
            {"id": d.id, "title": d.title, "status": d.status, "wordCount": d.word_count, "updatedAt": d.updated_at.isoformat()}
            for d in docs
        ],
        "recentProjects": [
            {"id": p.id, "title": p.title, "domain": p.domain, "sourceType": p.source_type, "updatedAt": p.updated_at.isoformat()}
            for p in projs
        ],
        "recentAudits": [
            {"id": a.id, "title": a.title, "overallStatus": a.overall_status, "createdAt": a.created_at.isoformat()}
            for a in audits
        ],
        "recentActivity": [
            {"id": a.id, "module": a.module, "action": a.action, "entityTitle": a.entity_title, "status": a.status, "createdAt": a.created_at.isoformat()}
            for a in acts
        ],
    }


@router.post("/integrity-audit/run")
def run_integrity_audit(
    payload: IntegrityAuditRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = db.query(Document).filter(Document.id == payload.documentId, Document.user_id == current_user.id).first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    sim = (
        db.query(SimilarityReport)
        .filter(SimilarityReport.document_id == doc.id, SimilarityReport.user_id == current_user.id)
        .order_by(SimilarityReport.created_at.desc())
        .first()
    )
    cit = (
        db.query(CitationCheck)
        .filter(CitationCheck.document_id == doc.id, CitationCheck.user_id == current_user.id)
        .order_by(CitationCheck.created_at.desc())
        .first()
    )
    qual = (
        db.query(QualityEvaluation)
        .filter(QualityEvaluation.document_id == doc.id, QualityEvaluation.user_id == current_user.id)
        .order_by(QualityEvaluation.created_at.desc())
        .first()
    )
    wrt = (
        db.query(WritingAnalysis)
        .filter(WritingAnalysis.document_id == doc.id, WritingAnalysis.user_id == current_user.id)
        .order_by(WritingAnalysis.created_at.desc())
        .first()
    )
    ref_job = (
        db.query(RefinementJob)
        .filter(RefinementJob.document_id == doc.id, RefinementJob.user_id == current_user.id, RefinementJob.status.in_(["completed", "approved"]))
        .order_by(RefinementJob.created_at.desc())
        .first()
    )

    code_check = None
    target_project_id = payload.projectId or doc.project_id
    if target_project_id:
        proj = db.query(Project).filter(Project.id == target_project_id, Project.user_id == current_user.id).first()
        if proj:
            code_check = cross_check_paper_against_code(doc.raw_text, json.loads(proj.analysis_json or "{}"))

    qual_dims = json.loads(qual.dimensions_json) if qual else []
    audit = build_integrity_audit(
        document_title=doc.title,
        similarity_result=json.loads(sim.results_json) if sim else None,
        citation_result=json.loads(cit.summary_json) if cit else None,
        quality_result={"overallScore": round(sum(d["score"] for d in qual_dims) / max(len(qual_dims), 1), 1)} if qual else None,
        code_crosscheck=code_check,
        writing_result={"observations": json.loads(wrt.observations_json)} if wrt else None,
        refinement_result=json.loads(ref_job.metrics_json) if ref_job else None,
    )

    record = IntegrityAudit(
        user_id=current_user.id,
        project_id=target_project_id,
        document_id=doc.id,
        title=doc.title,
        overall_status=audit["overallStatus"],
        findings_json=json.dumps(audit["findings"]),
        summary_json=json.dumps(audit["summary"]),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    record_activity(db, current_user.id, "Integrity Audit", "Generated Integrity Audit", doc.title, audit["overallStatus"])
    return {"auditId": record.id, "id": record.id, "title": doc.title, "audit": audit, **audit}


@router.get("/integrity-audit/{audit_id}/export")
def export_integrity_audit_report(
    audit_id: str,
    format: str = "md",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.query(IntegrityAudit).filter(IntegrityAudit.id == audit_id, IntegrityAudit.user_id == current_user.id).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit record not found.")

    audit_payload = {
        "id": row.id,
        "documentTitle": row.title,
        "overallStatus": row.overall_status,
        "findings": json.loads(row.findings_json or "[]"),
        "counts": json.loads(row.summary_json or "{}"),
        "auditSummary": f"Overall audit status: {row.overall_status}",
    }
    if format.lower() == "json":
        return Response(content=json.dumps(audit_payload, indent=2), media_type="application/json", headers={"Content-Disposition": f'attachment; filename="audit-{row.id}.json"'})

    md = export_audit_markdown(audit_payload)
    return Response(content=md, media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="audit-{row.id}.md"'})


@router.post("/paper-refinement/start", status_code=status.HTTP_202_ACCEPTED)
def start_refinement(
    payload: RefinementStartRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = db.query(Document).filter(Document.id == payload.documentId, Document.user_id == current_user.id).first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    all_sections = json.loads(doc.sections_json or "[]")
    target_sections = (
        [s for s in all_sections if s.get("id") in set(payload.sectionIds)]
        if (payload.scope == "selected_sections" and payload.sectionIds)
        else all_sections
    )
    if not target_sections:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No sections selected for refinement.")

    job = RefinementJob(
        document_id=doc.id,
        user_id=current_user.id,
        mode=payload.mode,
        scope=payload.scope,
        status="queued",
        progress=5,
        original_sections_json=json.dumps(target_sections),
        refined_sections_json="[]",
        metrics_json="{}",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    settings = get_settings()
    if celery_app is not None and (settings.CELERY_BROKER_URL or settings.REDIS_URL):
        celery_app.send_task(
            "researchforge.run_refinement_job",
            args=[job.id, payload.sectionIds, payload.preserveTerms, payload.engineMode, payload.paragraphIndex],
        )
    else:
        background_tasks.add_task(
            execute_refinement_job_sync,
            job.id,
            payload.sectionIds,
            payload.preserveTerms,
            payload.engineMode,
            payload.paragraphIndex,
        )

    record_activity(db, current_user.id, "Paper Refinement", f"Queued Refinement ({payload.mode})", doc.title, "Processing")
    return {"jobId": job.id, "id": job.id, "status": job.status}


@router.get("/paper-refinement/jobs/{job_id}")
@router.get("/paper-refinement/{job_id}")
def get_refinement_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Refinement job not found.")

    orig_sections = json.loads(job.original_sections_json or "[]")
    ref_results = json.loads(job.refined_sections_json or "[]")
    metrics = json.loads(job.metrics_json or "{}")
    if job.status == "completed" and "preMetrics" not in metrics and orig_sections:
        orig_text = "\n\n".join(s.get("content", "") for s in orig_sections)
        ref_text = "\n\n".join(r.get("refinedContent", r.get("content", "")) for r in ref_results)
        metrics["preMetrics"] = analyze_writing_patterns(orig_text)["metrics"]
        metrics["postMetrics"] = analyze_writing_patterns(ref_text)["metrics"]

    return {
        "id": job.id,
        "documentId": job.document_id,
        "mode": job.mode,
        "scope": job.scope,
        "status": job.status,
        "progress": job.progress,
        "errorMessage": job.error_message,
        "retries": job.retries,
        "originalSections": orig_sections,
        "refinedSections": [
            {"id": r.get("id"), "heading": r.get("heading"), "content": r.get("refinedContent", r.get("content", ""))}
            for r in ref_results
        ],
        "results": ref_results,
        "metrics": metrics,
        "createdAt": job.created_at.isoformat(),
        "completedAt": job.completed_at.isoformat() if job.completed_at else None,
    }


@router.post("/paper-refinement/cancel/{job_id}")
def cancel_refinement_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Refinement job not found.")
    job.cancelled = True
    if job.status in {"queued", "processing"}:
        job.status = "cancelled"
    db.commit()
    return {"id": job.id, "status": job.status}


@router.post("/paper-refinement/retry/{job_id}")
def retry_refinement_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Refinement job not found.")
    job.cancelled = False
    job.status = "queued"
    job.progress = 5
    job.error_message = ""
    job.retries += 1
    db.commit()
    background_tasks.add_task(execute_refinement_job_sync, job.id, None, "", "gemini", None)
    return {"jobId": job.id, "status": job.status, "retries": job.retries}


@router.post("/paper-refinement/approve/{job_id}")
@router.post("/paper-refinement/{job_id}/approve")
def approve_refinement_job(
    job_id: str,
    payload: RefinementApproveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if not job or job.status not in {"completed", "approved"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Completed refinement job not found.")
    doc = db.query(Document).filter(Document.id == job.document_id, Document.user_id == current_user.id).first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    current_sections = json.loads(doc.sections_json or "[]")
    if payload.approvedSections:
        approved_map = {s.id: s.content for s in payload.approvedSections}
    else:
        refined_list = json.loads(job.refined_sections_json or "[]")
        approved_map = {r["id"]: r.get("refinedContent", r.get("content", "")) for r in refined_list}

    updated_sections = [{**s, "content": approved_map.get(s["id"], s["content"])} for s in current_sections]
    doc.sections_json = json.dumps(updated_sections)
    doc.raw_text = "\n\n".join(f"{s['heading']}\n{s['content']}" for s in updated_sections)
    doc.word_count = len([w for w in doc.raw_text.split() if w])
    doc.status = "refined"
    job.status = "approved"

    ver_n = db.query(DocumentVersion).filter(DocumentVersion.document_id == doc.id).count()
    version_num = ver_n + 1
    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_number=version_num,
            label=f"Approved Refinement ({job.mode})",
            sections_json=doc.sections_json,
            raw_text=doc.raw_text,
        )
    )
    db.commit()
    record_activity(db, current_user.id, "Paper Refinement", f"Approved Refined Draft v{version_num}", doc.title)
    return {"approved": True, "versionNumber": version_num, "documentId": doc.id, "wordCount": doc.word_count}


@router.get("/reports")
def list_reports_and_dashboard(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sim_rows = db.query(SimilarityReport).filter(SimilarityReport.user_id == current_user.id).order_by(SimilarityReport.created_at.desc()).limit(20).all()
    cit_rows = db.query(CitationCheck).filter(CitationCheck.user_id == current_user.id).order_by(CitationCheck.created_at.desc()).limit(20).all()
    wrt_rows = db.query(WritingAnalysis).filter(WritingAnalysis.user_id == current_user.id).order_by(WritingAnalysis.created_at.desc()).limit(20).all()
    qual_rows = db.query(QualityEvaluation).filter(QualityEvaluation.user_id == current_user.id).order_by(QualityEvaluation.created_at.desc()).limit(20).all()
    aud_rows = db.query(IntegrityAudit).filter(IntegrityAudit.user_id == current_user.id).order_by(IntegrityAudit.created_at.desc()).limit(20).all()
    job_rows = db.query(RefinementJob).filter(RefinementJob.user_id == current_user.id).order_by(RefinementJob.created_at.desc()).limit(20).all()

    return {
        "similarity": [
            {"id": r.id, "title": r.title, "overall_similarity": r.overall_similarity, "results": json.loads(r.results_json or "{}"), "created_at": r.created_at.isoformat()}
            for r in sim_rows
        ],
        "citations": [
            {"id": r.id, "title": r.title, "summary": json.loads(r.summary_json or "{}"), "citations": json.loads(r.citations_json or "[]"), "created_at": r.created_at.isoformat()}
            for r in cit_rows
        ],
        "writing": [
            {"id": r.id, "title": r.title, "analysis": {"metrics": json.loads(r.metrics_json or "{}"), "observations": json.loads(r.observations_json or "[]")}, "created_at": r.created_at.isoformat()}
            for r in wrt_rows
        ],
        "quality": [
            {"id": r.id, "title": r.title, "evaluation": {"dimensions": json.loads(r.dimensions_json or "[]"), "recommendations": json.loads(r.recommendations_json or "[]")}, "created_at": r.created_at.isoformat()}
            for r in qual_rows
        ],
        "audits": [
            {"id": r.id, "title": r.title, "overall_status": r.overall_status, "findings": json.loads(r.findings_json or "[]"), "summary": json.loads(r.summary_json or "{}"), "created_at": r.created_at.isoformat()}
            for r in aud_rows
        ],
        "refinementJobs": [
            {"id": j.id, "document_id": j.document_id, "mode": j.mode, "status": j.status, "progress": j.progress, "created_at": j.created_at.isoformat()}
            for j in job_rows
        ],
    }
