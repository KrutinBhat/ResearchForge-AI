import json
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator
from ..core.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class VectorEmbeddingType(TypeDecorator):
    """Stores native pgvector vector(384) on PostgreSQL and JSON array text in SQLite unit tests."""

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            try:
                from pgvector.sqlalchemy import Vector

                return dialect.type_descriptor(Vector(384))
            except Exception:
                return dialect.type_descriptor(Text())
        return dialect.type_descriptor(Text())

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if dialect.name == "postgresql":
            return [float(x) for x in value[:384]]
        return json.dumps([float(x) for x in value[:384]])

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, str):
            try:
                return [float(x) for x in json.loads(value)]
            except Exception:
                return None
        return [float(x) for x in value]


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("usr"))
    uid: Mapped[str] = mapped_column(Text, unique=True, nullable=False, default=lambda: f"local:{uuid.uuid4().hex[:12]}")
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    institution: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    role: Mapped[str] = mapped_column(String(64), default="Researcher", nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    auth_provider: Mapped[str] = mapped_column(String(32), default="local", nullable=False)
    consent_analytics: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    consent_retention: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    projects: Mapped[list["Project"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    documents: Mapped[list["Document"]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (Index("ix_projects_user_updated", "user_id", "updated_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("proj"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    domain: Mapped[str] = mapped_column(String(128), default="Computer Science", nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)
    source_url: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="analyzed", nullable=False)
    analysis_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    owner: Mapped["User"] = relationship(back_populates="projects")


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (Index("ix_documents_user_updated", "user_id", "updated_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("doc"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    project_id: Mapped[Optional[str]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    format: Mapped[str] = mapped_column(String(16), default="ieee", nullable=False)
    citation_style: Mapped[str] = mapped_column(String(16), default="IEEE", nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    sections_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    references_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    owner: Mapped["User"] = relationship(back_populates="documents")
    versions: Mapped[list["DocumentVersion"]] = relationship(back_populates="document", cascade="all, delete-orphan")


class DocumentVersion(Base):
    __tablename__ = "document_versions"

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("ver"))
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True, nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    sections_json: Mapped[str] = mapped_column(Text, nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    document: Mapped["Document"] = relationship(back_populates="versions")


class RefinementJob(Base):
    __tablename__ = "refinement_jobs"
    __table_args__ = (Index("ix_refinement_jobs_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("refjob"))
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    mode: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(String(32), default="whole_paper", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    original_sections_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    refined_sections_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    error_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"
    __table_args__ = (Index("ix_analysis_jobs_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("job"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    job_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    result_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    error_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class CorpusChunk(Base):
    __tablename__ = "corpus_chunks"
    __table_args__ = (Index("ix_corpus_chunks_user_doc", "user_id", "document_id"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("chk"))
    user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True)
    document_id: Mapped[Optional[str]] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True, nullable=True)
    source_type: Mapped[str] = mapped_column(String(32), default="workspace", nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    authors: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    year: Mapped[str] = mapped_column(String(16), default="", nullable=False)
    url: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    embedding: Mapped[Optional[list[float]]] = mapped_column(VectorEmbeddingType(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Citation(Base):
    __tablename__ = "citations"

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("cite"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    document_id: Mapped[Optional[str]] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True, nullable=True)
    raw_reference: Mapped[str] = mapped_column(Text, nullable=False)
    doi: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    title: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    authors: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    year: Mapped[str] = mapped_column(String(16), default="", nullable=False)
    venue: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    url: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    verification_status: Mapped[str] = mapped_column(String(64), default="Verification unavailable", nullable=False)
    claim_support_status: Mapped[str] = mapped_column(String(64), default="Evidence insufficient", nullable=False)
    source_provider: Mapped[str] = mapped_column(String(64), default="none", nullable=False)
    details_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class SimilarityReport(Base):
    __tablename__ = "similarity_reports"
    __table_args__ = (Index("ix_similarity_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("sim"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    document_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    overall_similarity: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    corpus_coverage: Mapped[str] = mapped_column(Text, default="", nullable=False)
    results_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class WritingAnalysis(Base):
    __tablename__ = "writing_analyses"
    __table_args__ = (Index("ix_writing_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("wrt"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    document_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    observations_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CitationCheck(Base):
    __tablename__ = "citation_checks"
    __table_args__ = (Index("ix_citation_checks_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("cit"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    document_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    citations_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    summary_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class QualityEvaluation(Base):
    __tablename__ = "quality_evaluations"
    __table_args__ = (Index("ix_quality_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("qual"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    document_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    dimensions_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    recommendations_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class IntegrityAudit(Base):
    __tablename__ = "integrity_audits"
    __table_args__ = (Index("ix_audits_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("aud"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    project_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    document_id: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    overall_status: Mapped[str] = mapped_column(String(32), default="Needs review", nullable=False)
    findings_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    summary_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ActivityLog(Base):
    __tablename__ = "activity_logs"
    __table_args__ = (Index("ix_activity_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: new_id("act"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    module: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="Completed", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
