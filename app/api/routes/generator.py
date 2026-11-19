import json
from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...models.entities import Document, DocumentVersion, Project, User
from ...schemas.common import GeneratePaperRequest
from ...services.document_parser import parse_raw_text
from ...services.generator_refinement_service import generate_grounded_ieee_paper
from ..deps import get_current_user, get_owned_or_404, record_activity
from .documents import _index_document_chunks

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
        project = get_owned_or_404(db, Project, payload.projectId, current_user.id, "Referenced project not found.")
        project_analysis = json.loads(project.analysis_json or "{}")

    effective_style = payload.paperFormat or payload.citationStyle
    generated = await generate_grounded_ieee_paper(
        title=payload.title.strip(),
        synopsis=payload.synopsis,
        dataset_notes=payload.datasetNotes,
        experimental_results=payload.experimentalResults,
        literature_notes=payload.literatureNotes,
        project_analysis=project_analysis,
        engine_mode=payload.engineMode,
        gemini_api_key=settings.GEMINI_API_KEY,
        gemini_model=settings.GEMINI_MODEL,
        citation_style=effective_style,
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
        format=effective_style.lower(),
        citation_style=effective_style,
        raw_text=raw_text,
        sections_json=json.dumps(sections),
        references_json=json.dumps(references),
        word_count=len([w for w in raw_text.split() if w]),
        status="generated",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    parsed_chunks = parse_raw_text(raw_text, doc.format).get("chunks", [])
    _index_document_chunks(db, current_user.id, doc, parsed_chunks)
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
    record_activity(db, current_user.id, "Paper Generator", f"Generated {effective_style} Draft", doc.title)

    keywords_sec = next((s["content"] for s in sections if "keyword" in s["heading"].lower()), "")
    keywords = [k.strip() for k in keywords_sec.split(",") if k.strip()] if keywords_sec else []

    return {
        "documentId": doc.id,
        "generated": {
            "title": doc.title,
            "keywords": keywords,
            "sections": sections,
            "references": references,
            "missingInformationPrompts": generated["missingInputs"],
            "groundingSummary": f"Grounded in {len(sections)} structured {effective_style} sections ({generated['engineUsed']}).",
            "engineUsed": generated["engineUsed"],
        },
        "title": doc.title,
        "citationStyle": doc.citation_style,
        "engineUsed": generated["engineUsed"],
        "missingInputs": generated["missingInputs"],
        "sections": sections,
        "wordCount": doc.word_count,
    }

