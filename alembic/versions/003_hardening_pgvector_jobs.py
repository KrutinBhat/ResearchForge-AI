"""Production hardening: native pgvector embeddings, job payload durability, composite indexes

Revision ID: 003_hardening_pgvector_jobs
Revises: 002_v11_upgrade
Create Date: 2026-11-19 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "003_hardening_pgvector_jobs"
down_revision = "002_v11_upgrade"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    op.add_column("refinement_jobs", sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"))

    if is_pg:
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
        op.execute("ALTER TABLE corpus_chunks ADD COLUMN IF NOT EXISTS embedding vector(384)")
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_corpus_chunks_embedding_hnsw "
            "ON corpus_chunks USING hnsw (embedding vector_cosine_ops)"
        )
    else:
        op.add_column("corpus_chunks", sa.Column("embedding", sa.Text(), nullable=True))

    op.create_index("ix_projects_user_updated", "projects", ["user_id", "updated_at"])
    op.create_index("ix_documents_user_updated", "documents", ["user_id", "updated_at"])
    op.create_index("ix_refinement_jobs_user_created", "refinement_jobs", ["user_id", "created_at"])
    op.create_index("ix_analysis_jobs_user_created", "analysis_jobs", ["user_id", "created_at"])
    op.create_index("ix_corpus_chunks_user_doc", "corpus_chunks", ["user_id", "document_id"])
    op.create_index("ix_similarity_user_created", "similarity_reports", ["user_id", "created_at"])
    op.create_index("ix_writing_user_created", "writing_analyses", ["user_id", "created_at"])
    op.create_index("ix_citation_checks_user_created", "citation_checks", ["user_id", "created_at"])
    op.create_index("ix_quality_user_created", "quality_evaluations", ["user_id", "created_at"])
    op.create_index("ix_audits_user_created", "integrity_audits", ["user_id", "created_at"])
    op.create_index("ix_activity_user_created", "activity_logs", ["user_id", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    for idx_name, tbl in (
        ("ix_activity_user_created", "activity_logs"),
        ("ix_audits_user_created", "integrity_audits"),
        ("ix_quality_user_created", "quality_evaluations"),
        ("ix_citation_checks_user_created", "citation_checks"),
        ("ix_writing_user_created", "writing_analyses"),
        ("ix_similarity_user_created", "similarity_reports"),
        ("ix_corpus_chunks_user_doc", "corpus_chunks"),
        ("ix_analysis_jobs_user_created", "analysis_jobs"),
        ("ix_refinement_jobs_user_created", "refinement_jobs"),
        ("ix_documents_user_updated", "documents"),
        ("ix_projects_user_updated", "projects"),
    ):
        op.drop_index(idx_name, table_name=tbl)

    if is_pg:
        op.execute("DROP INDEX IF EXISTS ix_corpus_chunks_embedding_hnsw")
        op.execute("ALTER TABLE corpus_chunks DROP COLUMN IF EXISTS embedding")
    else:
        op.drop_column("corpus_chunks", "embedding")

    op.drop_column("refinement_jobs", "payload_json")
