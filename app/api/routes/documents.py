import json
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...core.security import sanitize_filename
from ...models.entities import Citation, CorpusChunk, Document, DocumentVersion, Project, User
from ...schemas.common import DocumentCreateTextRequest, DocumentUpdateRequest
from ...services.document_parser import parse_document_bytes, parse_raw_text
from ...services.export_service import (
    export_bibliography_bibtex,
    export_document_docx_bytes,
    export_document_latex,
    export_document_markdown,
    export_document_pdf_bytes,
)
from ...services.similarity_service import compute_semantic_embeddings
from ..deps import get_current_user, get_owned_or_404, read_validated_upload, record_activity

router = APIRouter(tags=["Documents & Academic Editor"])


def _serialize_doc(doc: Document) -> dict:
    return {
        "id": doc.id,
        "projectId": doc.project_id,
        "project_id": doc.project_id,
        "title": doc.title,
        "format": doc.format,
        "citationStyle": doc.citation_style,
        "citation_style": doc.citation_style,
        "rawText": doc.raw_text,
        "raw_text": doc.raw_text,
        "sections": json.loads(doc.sections_json or "[]"),
        "references": json.loads(doc.references_json or "[]"),
        "metadata": json.loads(doc.metadata_json or "{}"),
        "wordCount": doc.word_count,
        "word_count": doc.word_count,
        "status": doc.status,
        "createdAt": doc.created_at.isoformat(),
        "created_at": doc.created_at.isoformat(),
        "updatedAt": doc.updated_at.isoformat(),
        "updated_at": doc.updated_at.isoformat(),
    }


def _index_document_chunks(db: Session, user_id: str, doc: Document, chunks: list[dict]) -> None:
    db.query(CorpusChunk).filter(CorpusChunk.document_id == doc.id).delete()
    if not chunks:
        return
    capped = chunks[:60]
    texts = [c["text"] for c in capped]
    vecs = compute_semantic_embeddings(texts)
    for idx, c in enumerate(capped):
        emb = vecs[idx] if vecs and idx < len(vecs) else None
        db.add(
            CorpusChunk(
                user_id=user_id,
                document_id=doc.id,
                source_type="workspace",
                title=doc.title[:500],
                chunk_index=c["chunkIndex"],
                content=c["text"],
                embedding_json=json.dumps(emb or []),
                embedding=emb,
            )
        )


@router.get("/documents")
def list_documents(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(Document).filter(Document.user_id == current_user.id)
    total = q.count()
    docs = q.order_by(Document.updated_at.desc()).offset(offset).limit(limit).all()
    return {
        "documents": [_serialize_doc(d) for d in docs],
        "pagination": {"total": total, "limit": limit, "offset": offset},
    }


@router.post("/documents/upload", status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    title: str = Form(""),
    citationStyle: str = Form("IEEE"),
    projectId: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    clean_project_id = projectId.strip() if projectId and projectId.strip() else None
    if clean_project_id:
        get_owned_or_404(db, Project, clean_project_id, current_user.id, "Referenced project not found.")

    data = await read_validated_upload(file)
    try:
        parsed = parse_document_bytes(data, file.filename or "manuscript.txt", file.content_type or "")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    doc_title = title.strip() or sanitize_filename(file.filename or "Uploaded Manuscript").rsplit(".", 1)[0]

    doc = Document(
        user_id=current_user.id,
        project_id=clean_project_id,
        title=doc_title[:255],
        format=parsed["format"],
        citation_style="APA" if citationStyle.upper() == "APA" else "IEEE",
        raw_text=parsed["rawText"],
        sections_json=json.dumps(parsed["sections"]),
        references_json=json.dumps(parsed["references"]),
        metadata_json=json.dumps(parsed["metadata"]),
        word_count=parsed["wordCount"],
        status="ocr_required" if parsed["ocrRequired"] else "uploaded",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    _index_document_chunks(db, current_user.id, doc, parsed.get("chunks", []))
    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_number=1,
            label="Initial Ingestion",
            sections_json=doc.sections_json,
            raw_text=doc.raw_text,
        )
    )
    db.commit()
    record_activity(db, current_user.id, "Documents", "Uploaded Manuscript", doc.title)
    serialized = _serialize_doc(doc)
    return {
        "document": serialized,
        **serialized,
        "parseMeta": {"ocrRequired": parsed["ocrRequired"], "ocrApplied": parsed["ocrApplied"], "warnings": parsed["warnings"]},
    }


@router.post("/documents/text", status_code=status.HTTP_201_CREATED)
def create_text_document(
    payload: DocumentCreateTextRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.projectId:
        get_owned_or_404(db, Project, payload.projectId, current_user.id, "Referenced project not found.")

    parsed = parse_raw_text(payload.rawText, payload.format)
    doc = Document(
        user_id=current_user.id,
        project_id=payload.projectId,
        title=payload.title.strip()[:255],
        format=parsed["format"],
        citation_style=payload.citationStyle,
        raw_text=parsed["rawText"],
        sections_json=json.dumps(parsed["sections"]),
        references_json=json.dumps(parsed["references"]),
        metadata_json=json.dumps(parsed["metadata"]),
        word_count=parsed["wordCount"],
        status="draft",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    _index_document_chunks(db, current_user.id, doc, parsed.get("chunks", []))
    db.add(DocumentVersion(document_id=doc.id, version_number=1, label="Initial Draft", sections_json=doc.sections_json, raw_text=doc.raw_text))
    db.commit()
    record_activity(db, current_user.id, "Documents", "Created Text Draft", doc.title)
    serialized = _serialize_doc(doc)
    return {"document": serialized, **serialized}


@router.get("/documents/{document_id}")
def get_document(document_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    doc = get_owned_or_404(db, Document, document_id, current_user.id, "Document not found.")
    versions = (
        db.query(DocumentVersion)
        .filter(DocumentVersion.document_id == doc.id)
        .order_by(DocumentVersion.version_number.desc())
        .all()
    )
    serialized_versions = [
        {
            "id": v.id,
            "versionNumber": v.version_number,
            "version_number": v.version_number,
            "label": v.label,
            "sections": json.loads(v.sections_json or "[]"),
            "createdAt": v.created_at.isoformat(),
            "created_at": v.created_at.isoformat(),
        }
        for v in versions
    ]
    serialized_doc = _serialize_doc(doc)
    return {
        "document": serialized_doc,
        **serialized_doc,
        "versions": serialized_versions,
    }


@router.patch("/documents/{document_id}")
@router.put("/academic-editor/{document_id}")
def save_document_edits(
    document_id: str,
    payload: DocumentUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = get_owned_or_404(db, Document, document_id, current_user.id, "Document not found.")

    if payload.title:
        doc.title = payload.title.strip()[:255]
    if payload.citationStyle:
        doc.citation_style = payload.citationStyle
    if payload.sections is not None:
        sections_dicts = [s.model_dump() for s in payload.sections]
        doc.sections_json = json.dumps(sections_dicts)
        doc.raw_text = "\n\n".join(f"{s['heading']}\n{s['content']}" for s in sections_dicts)
        doc.word_count = len([w for w in doc.raw_text.split() if w])
    if payload.references is not None:
        doc.references_json = json.dumps(payload.references)

    parsed_refresh = parse_raw_text(doc.raw_text, doc.format)
    _index_document_chunks(db, current_user.id, doc, parsed_refresh.get("chunks", []))

    latest_ver = db.query(DocumentVersion).filter(DocumentVersion.document_id == doc.id).count()
    version_num = latest_ver + 1
    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_number=version_num,
            label=payload.versionLabel or f"Revision {version_num}",
            sections_json=doc.sections_json,
            raw_text=doc.raw_text,
        )
    )
    db.commit()
    db.refresh(doc)
    record_activity(db, current_user.id, "Academic Editor", "Saved Manuscript Revision", doc.title)
    serialized = _serialize_doc(doc)
    return {"versionNumber": version_num, "wordCount": doc.word_count, "document": serialized, **serialized}


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    doc = get_owned_or_404(db, Document, document_id, current_user.id, "Document not found.")
    db.delete(doc)
    db.commit()
    return {"deleted": True}


@router.get("/documents/{document_id}/export")
@router.get("/academic-editor/{document_id}/export")
def export_document(
    document_id: str,
    format: str = "tex",
    style: str | None = Query(default=None),
    includeUnverified: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = get_owned_or_404(db, Document, document_id, current_user.id, "Document not found.")
    sections = json.loads(doc.sections_json or "[]")
    references = json.loads(doc.references_json or "[]")
    fmt = format.lower()
    target_style = "APA" if (style or doc.citation_style).upper() == "APA" else "IEEE"
    safe_slug = sanitize_filename(doc.title.lower().replace(" ", "-")[:50], default_name=doc.id)

    if fmt == "bib":
        persisted = (
            db.query(Citation)
            .filter(Citation.document_id == doc.id, Citation.user_id == current_user.id)
            .order_by(Citation.created_at.desc())
            .all()
        )
        bib_items: list[dict | str] = []
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
                bib_items.append(
                    detail
                    if detail
                    else {
                        "id": row.id,
                        "rawReference": row.raw_reference,
                        "matchedTitle": row.title,
                        "authors": [a.strip() for a in row.authors.split(",") if a.strip()],
                        "year": row.year,
                        "venue": row.venue,
                        "doi": row.doi,
                        "url": row.url,
                        "status": "Verified" if "verified" in row.verification_status.lower() else "Unverified",
                    }
                )
        else:
            bib_items = references
        exported = export_bibliography_bibtex(bib_items, include_unverified=includeUnverified)
        return Response(
            content=exported["bibtex"],
            media_type="application/x-bibtex",
            headers={"Content-Disposition": f'attachment; filename="{safe_slug}.bib"'},
        )
    if fmt == "tex":
        content = export_document_latex(doc.title, sections, references=references, style=target_style)
        return Response(content=content, media_type="application/x-tex", headers={"Content-Disposition": f'attachment; filename="{safe_slug}.tex"'})
    if fmt == "md":
        content = export_document_markdown(doc.title, sections, references=references)
        return Response(content=content, media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{safe_slug}.md"'})
    if fmt == "docx":
        try:
            payload = export_document_docx_bytes(doc.title, sections, references=references, style=target_style)
        except ImportError:
            raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="python-docx is required for DOCX export.")
        return Response(
            content=payload,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{safe_slug}.docx"'},
        )
    if fmt == "pdf":
        try:
            payload = export_document_pdf_bytes(doc.title, sections, references=references, style=target_style)
        except ImportError:
            raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="WeasyPrint or ReportLab is required for PDF export.")
        return Response(
            content=payload,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{safe_slug}.pdf"'},
        )
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported export format. Use tex, md, docx, pdf, or bib.")
