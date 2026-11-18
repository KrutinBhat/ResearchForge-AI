import json
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...models.entities import Document, Project, User
from ...schemas.common import CrossCheckRequest, GithubProjectRequest
from ...services.project_analyzer_service import (
    analyze_github_repository,
    cross_check_paper_against_code,
    extract_and_analyze_zip,
)
from ..deps import get_current_user, read_validated_upload, record_activity

router = APIRouter(tags=["Projects & Code-to-Paper"])


def _serialize_project(p: Project) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "description": p.description,
        "domain": p.domain,
        "source_type": p.source_type,
        "sourceType": p.source_type,
        "source_url": p.source_url,
        "sourceUrl": p.source_url,
        "status": p.status,
        "analysis": json.loads(p.analysis_json or "{}"),
        "created_at": p.created_at.isoformat(),
        "createdAt": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
        "updatedAt": p.updated_at.isoformat(),
    }


@router.get("/projects")
def list_projects(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(Project).filter(Project.user_id == current_user.id).order_by(Project.updated_at.desc()).all()
    return {"projects": [_serialize_project(r) for r in rows]}


@router.post("/projects/analyze-zip", status_code=status.HTTP_201_CREATED)
@router.post("/projects/upload-zip", status_code=status.HTTP_201_CREATED)
async def upload_project_zip(
    archive: UploadFile | None = File(None),
    file: UploadFile | None = File(None),
    title: str = Form("Uploaded Software Project"),
    domain: str = Form("Computer Science"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    upload = archive or file
    if upload is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ZIP archive field is required.")
    if not (upload.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only .zip archives are supported.")

    settings = get_settings()
    data = await read_validated_upload(upload)
    proj_title = title.strip() or (upload.filename or "Uploaded Project").rsplit(".", 1)[0]
    try:
        analysis = extract_and_analyze_zip(
            data,
            max_files=settings.MAX_ARCHIVE_FILES,
            max_uncompressed_bytes=settings.MAX_ARCHIVE_UNCOMPRESSED_BYTES,
            project_name=proj_title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    project = Project(
        user_id=current_user.id,
        title=proj_title,
        description=analysis.get("readmeSummary", "")[:500],
        domain=domain,
        source_type="zip",
        analysis_json=json.dumps(analysis),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    record_activity(db, current_user.id, "Project Analyzer", "Analyzed ZIP Archive", project.title)
    serialized = _serialize_project(project)
    return {"project": serialized, **serialized}


@router.post("/projects/analyze-github", status_code=status.HTTP_201_CREATED)
@router.post("/projects/github", status_code=status.HTTP_201_CREATED)
async def import_github_project(
    payload: GithubProjectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        analysis = await analyze_github_repository(payload.repoUrl)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    meta = analysis.get("githubMeta", {})
    project = Project(
        user_id=current_user.id,
        title=(payload.title or meta.get("fullName") or "GitHub Project").strip(),
        description=meta.get("description", ""),
        domain=payload.domain,
        source_type="github",
        source_url=payload.repoUrl,
        analysis_json=json.dumps(analysis),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    record_activity(db, current_user.id, "Project Analyzer", "Imported GitHub Repo", project.title)
    serialized = _serialize_project(project)
    return {"project": serialized, **serialized}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    db.delete(project)
    db.commit()
    return {"deleted": True}


@router.post("/project-analysis/crosscheck")
@router.post("/project-analysis/cross-check")
def cross_check(
    payload: CrossCheckRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = db.query(Project).filter(Project.id == payload.projectId, Project.user_id == current_user.id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    paper_text = payload.customText or ""
    if payload.documentId:
        doc = db.query(Document).filter(Document.id == payload.documentId, Document.user_id == current_user.id).first()
        if not doc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
        paper_text = doc.raw_text

    if not paper_text.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide either documentId or customText.")

    analysis = json.loads(project.analysis_json or "{}")
    result = cross_check_paper_against_code(paper_text, analysis)
    record_activity(db, current_user.id, "Project Analyzer", "Cross-Checked Paper vs Code", project.title)
    return result
