"""V1.1 upgrade: Firebase UID, durable jobs, corpus chunks, citations, metadata

Revision ID: 002_v11_upgrade
Revises: 001_initial_schema
Create Date: 2026-11-18 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "002_v11_upgrade"
down_revision = "001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("uid", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("auth_provider", sa.String(32), nullable=False, server_default="local"))
    op.execute("UPDATE users SET uid = 'local:' || id WHERE uid IS NULL")
    op.alter_column("users", "uid", nullable=False)
    op.create_unique_constraint("users_uid_unique", "users", ["uid"])

    op.add_column("documents", sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"))

    op.add_column("refinement_jobs", sa.Column("error_message", sa.Text(), nullable=False, server_default=""))
    op.add_column("refinement_jobs", sa.Column("retries", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("refinement_jobs", sa.Column("cancelled", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "analysis_jobs",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("job_type", sa.String(64), nullable=False),
        sa.Column("target_id", sa.String(48), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("result_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("retries", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cancelled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "corpus_chunks",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("document_id", sa.String(48), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=True),
        sa.Column("source_type", sa.String(32), nullable=False, server_default="workspace"),
        sa.Column("title", sa.String(512), nullable=False),
        sa.Column("authors", sa.String(512), nullable=False, server_default=""),
        sa.Column("year", sa.String(16), nullable=False, server_default=""),
        sa.Column("url", sa.String(512), nullable=False, server_default=""),
        sa.Column("chunk_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "citations",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(48), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=True),
        sa.Column("raw_reference", sa.Text(), nullable=False),
        sa.Column("doi", sa.String(255), nullable=False, server_default=""),
        sa.Column("title", sa.String(512), nullable=False, server_default=""),
        sa.Column("authors", sa.String(512), nullable=False, server_default=""),
        sa.Column("year", sa.String(16), nullable=False, server_default=""),
        sa.Column("venue", sa.String(255), nullable=False, server_default=""),
        sa.Column("url", sa.String(512), nullable=False, server_default=""),
        sa.Column("verification_status", sa.String(64), nullable=False, server_default="Verification unavailable"),
        sa.Column("claim_support_status", sa.String(64), nullable=False, server_default="Evidence insufficient"),
        sa.Column("source_provider", sa.String(64), nullable=False, server_default="none"),
        sa.Column("details_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("citations")
    op.drop_table("corpus_chunks")
    op.drop_table("analysis_jobs")
    op.drop_column("refinement_jobs", "cancelled")
    op.drop_column("refinement_jobs", "retries")
    op.drop_column("refinement_jobs", "error_message")
    op.drop_column("documents", "metadata_json")
    op.drop_constraint("users_uid_unique", "users", type_="unique")
    op.drop_column("users", "auth_provider")
    op.drop_column("users", "uid")
