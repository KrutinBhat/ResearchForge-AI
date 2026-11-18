import json
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...models.entities import Document, DocumentVersion, Project, User
from ...schemas.common import GeneratePaperRequest
from ...services.generator_refinement_service import generate_grounded_ieee_paper
from ..deps import get_current_user, record_activity

router = APIRouter(prefix="/research-generator", tags=["AI Research Paper Generator"])


@router.post("/generate", status_code=status.HTTP_201_CREATED)
async def generate_paper(
    payload: GeneratePaperRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    project_analysis = None
    if payload.projectId:
        project = db.query(Project).filter(Project.id == payload.projectId, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Referenced project not found.")
        project_analysis = json.loads(project.analysis_json or "{}")

    generated = await generate_grounded_ieee_paper(
        title=payload.title.strip(),
        synopsis=payload.synopsis,
        dataset_notes=payload.datasetNotes,
        experimental_results=payload.experimentalResults,
        literature_notes=payload.literatureNotes,
        project_analysis=project_analysis,
        engine_mode=payload.engineMode,
        gemini_api_key=settings.GEMINI_API_KEY,
        citation_style=payload.citationStyle,
        ollama_base_url=settings.OLLAMA_BASE_URL,
        ollama_model=settings.OLLAMA_MODEL,
    )

    sections = generated["sections"]
    raw_text = "\n\n".join(f"{s['heading']}\n{s['content']}" for s in sections)
    refs_section = next((s["content"] for s in sections if "reference" in s["heading"].lower()), "")
    references = [line.strip() for line in refs_section.splitlines() if line.strip()]

    doc = Document(
        user_id=current_user.id,
        project_id=payload.projectId,
        title=generated["title"],
        format=payload.citationStyle.lower(),
        citation_style=payload.citationStyle,
        raw_text=raw_text,
        sections_json=json.dumps(sections),
        references_json=json.dumps(references),
        word_count=len([w for w in raw_text.split() if w]),
        status="generated",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    db.add(
        DocumentVersion(
            document_id=doc.id,
            version_number=1,
            label=f"Generated ({generated['engineUsed']})",
            sections_json=doc.sections_json,
            raw_text=doc.raw_text,
        )
    )
    db.commit()
    record_activity(db, current_user.id, "Paper Generator", f"Generated {payload.citationStyle} Draft", doc.title)

    return {
        "documentId": doc.id,
        "title": doc.title,
        "citationStyle": doc.citation_style,
        "engineUsed": generated["engineUsed"],
        "missingInputs": generated["missingInputs"],
        "sections": sections,
        "wordCount": doc.word_count,
    }
