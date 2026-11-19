import json
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...core.security import sanitize_filename
from ...models.entities import (
    ActivityLog,
    AnalysisJob,
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
from ...services.document_parser import parse_raw_text
from ...services.project_analyzer_service import cross_check_paper_against_code
from ...services.quality_audit_service import build_integrity_audit, export_audit_markdown
from ...services.writing_service import analyze_writing_patterns
from ...worker import dispatch_analysis_job, dispatch_refinement_job
from ..deps import get_current_user, get_owned_or_404, record_activity
from .documents import _index_document_chunks

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
    doc = get_owned_or_404(db, Document, payload.documentId, current_user.id, "Document not found.")

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
        proj = get_owned_or_404(db, Project, target_project_id, current_user.id, "Referenced project not found.")
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
    row = get_owned_or_404(db, IntegrityAudit, audit_id, current_user.id, "Audit record not found.")

    audit_payload = {
        "id": row.id,
        "documentTitle": row.title,
        "overallStatus": row.overall_status,
        "findings": json.loads(row.findings_json or "[]"),
        "counts": json.loads(row.summary_json or "{}"),
        "auditSummary": f"Overall audit status: {row.overall_status}",
    }
    safe_id = sanitize_filename(f"audit-{row.id}", default_name="audit")
    if format.lower() == "json":
        return Response(content=json.dumps(audit_payload, indent=2), media_type="application/json", headers={"Content-Disposition": f'attachment; filename="{safe_id}.json"'})

    md = export_audit_markdown(audit_payload)
    return Response(content=md, media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{safe_id}.md"'})


@router.post("/paper-refinement/start", status_code=status.HTTP_202_ACCEPTED)
def start_refinement(
    payload: RefinementStartRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = get_owned_or_404(db, Document, payload.documentId, current_user.id, "Document not found.")

    all_sections = json.loads(doc.sections_json or "[]")
    if payload.paragraphText and payload.scope in {"single_paragraph", "selected_paragraphs"}:
        target_sections = [{"id": "selected_paragraph", "heading": "Selected Paragraph", "content": payload.paragraphText}]
    elif payload.scope == "selected_sections" and payload.sectionIds:
        selected_set = set(payload.sectionIds)
        target_sections = [s for s in all_sections if s.get("id") in selected_set]
    else:
        target_sections = all_sections

    if not target_sections:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No sections selected for refinement.")

    job_payload = {
        "sectionIds": payload.sectionIds,
        "paragraphIndex": payload.paragraphIndex,
        "paragraphText": payload.paragraphText,
        "preserveTerms": payload.preserveTerms,
        "engineMode": payload.engineMode,
    }
    job = RefinementJob(
        document_id=doc.id,
        user_id=current_user.id,
        mode=payload.mode,
        scope=payload.scope,
        status="queued",
        progress=5,
        payload_json=json.dumps(job_payload),
        original_sections_json=json.dumps(target_sections),
        refined_sections_json="[]",
        metrics_json="{}",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    dispatch_mode = dispatch_refinement_job(job.id, background_tasks)
    record_activity(db, current_user.id, "Paper Refinement", f"Queued Refinement ({payload.mode})", doc.title, "Processing")
    return {"jobId": job.id, "id": job.id, "status": job.status, "dispatch": dispatch_mode}


def _serialize_refinement_job(job: RefinementJob) -> dict:
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
        "jobType": "paper_refinement",
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


@router.get("/paper-refinement/jobs/{job_id}")
@router.get("/paper-refinement/{job_id}")
def get_refinement_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = get_owned_or_404(db, RefinementJob, job_id, current_user.id, "Refinement job not found.")
    return _serialize_refinement_job(job)


@router.post("/paper-refinement/cancel/{job_id}")
@router.post("/paper-refinement/jobs/{job_id}/cancel")
def cancel_refinement_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = get_owned_or_404(db, RefinementJob, job_id, current_user.id, "Refinement job not found.")
    job.cancelled = True
    if job.status in {"queued", "processing"}:
        job.status = "cancelled"
    db.commit()
    return {"id": job.id, "status": job.status}


@router.post("/paper-refinement/retry/{job_id}")
@router.post("/paper-refinement/jobs/{job_id}/retry")
def retry_refinement_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = get_owned_or_404(db, RefinementJob, job_id, current_user.id, "Refinement job not found.")
    if job.status in {"queued", "processing"}:
        return {"jobId": job.id, "status": job.status, "retries": job.retries}

    job.cancelled = False
    job.status = "queued"
    job.progress = 5
    job.error_message = ""
    job.retries += 1
    db.commit()

    dispatch_mode = dispatch_refinement_job(job.id, background_tasks)
    return {"jobId": job.id, "status": job.status, "retries": job.retries, "dispatch": dispatch_mode}


@router.get("/jobs/{job_id}")
def get_unified_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ref_job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if ref_job:
        return _serialize_refinement_job(ref_job)
    ana_job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id, AnalysisJob.user_id == current_user.id).first()
    if not ana_job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    return {
        "id": ana_job.id,
        "jobType": ana_job.job_type,
        "targetId": ana_job.target_id,
        "status": ana_job.status,
        "progress": ana_job.progress,
        "errorMessage": ana_job.error_message,
        "retries": ana_job.retries,
        "result": json.loads(ana_job.result_json or "{}"),
        "createdAt": ana_job.created_at.isoformat(),
        "completedAt": ana_job.completed_at.isoformat() if ana_job.completed_at else None,
    }


@router.post("/jobs/{job_id}/cancel")
def cancel_unified_job(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ref_job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if ref_job:
        ref_job.cancelled = True
        if ref_job.status in {"queued", "processing"}:
            ref_job.status = "cancelled"
        db.commit()
        return {"id": ref_job.id, "status": ref_job.status}

    ana_job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id, AnalysisJob.user_id == current_user.id).first()
    if not ana_job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    ana_job.cancelled = True
    if ana_job.status in {"queued", "processing"}:
        ana_job.status = "cancelled"
    db.commit()
    return {"id": ana_job.id, "status": ana_job.status}


@router.post("/jobs/{job_id}/retry")
def retry_unified_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ref_job = db.query(RefinementJob).filter(RefinementJob.id == job_id, RefinementJob.user_id == current_user.id).first()
    if ref_job:
        ref_job.cancelled = False
        ref_job.status = "queued"
        ref_job.progress = 5
        ref_job.error_message = ""
        ref_job.retries += 1
        db.commit()
        dispatch_mode = dispatch_refinement_job(ref_job.id, background_tasks)
        return {"id": ref_job.id, "status": ref_job.status, "retries": ref_job.retries, "dispatch": dispatch_mode}

    ana_job = db.query(AnalysisJob).filter(AnalysisJob.id == job_id, AnalysisJob.user_id == current_user.id).first()
    if not ana_job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    ana_job.cancelled = False
    ana_job.status = "queued"
    ana_job.progress = 5
    ana_job.error_message = ""
    ana_job.retries += 1
    db.commit()
    dispatch_mode = dispatch_analysis_job(ana_job.id, background_tasks)
    return {"id": ana_job.id, "status": ana_job.status, "retries": ana_job.retries, "dispatch": dispatch_mode}


@router.post("/paper-refinement/approve/{job_id}")
@router.post("/paper-refinement/{job_id}/approve")
def approve_refinement_job(
    job_id: str,
    payload: RefinementApproveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = get_owned_or_404(db, RefinementJob, job_id, current_user.id, "Refinement job not found.")
    if job.status not in {"completed", "approved"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Completed refinement job not found.")
    doc = get_owned_or_404(db, Document, job.document_id, current_user.id, "Document not found.")

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

    parsed_refresh = parse_raw_text(doc.raw_text, doc.format)
    _index_document_chunks(db, current_user.id, doc, parsed_refresh.get("chunks", []))

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
def list_reports_and_dashboard(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sim_rows = db.query(SimilarityReport).filter(SimilarityReport.user_id == current_user.id).order_by(SimilarityReport.created_at.desc()).offset(offset).limit(limit).all()
    cit_rows = db.query(CitationCheck).filter(CitationCheck.user_id == current_user.id).order_by(CitationCheck.created_at.desc()).offset(offset).limit(limit).all()
    wrt_rows = db.query(WritingAnalysis).filter(WritingAnalysis.user_id == current_user.id).order_by(WritingAnalysis.created_at.desc()).offset(offset).limit(limit).all()
    qual_rows = db.query(QualityEvaluation).filter(QualityEvaluation.user_id == current_user.id).order_by(QualityEvaluation.created_at.desc()).offset(offset).limit(limit).all()
    aud_rows = db.query(IntegrityAudit).filter(IntegrityAudit.user_id == current_user.id).order_by(IntegrityAudit.created_at.desc()).offset(offset).limit(limit).all()
    job_rows = db.query(RefinementJob).filter(RefinementJob.user_id == current_user.id).order_by(RefinementJob.created_at.desc()).offset(offset).limit(limit).all()

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
        "pagination": {"limit": limit, "offset": offset},
    }

