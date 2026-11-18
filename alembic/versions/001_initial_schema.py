"""Initial ResearchForge AI schema

Revision ID: 001_initial_schema
Revises:
Create Date: 2026-01-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("institution", sa.String(255), nullable=False, server_default=""),
        sa.Column("role", sa.String(64), nullable=False, server_default="Researcher"),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("consent_analytics", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("consent_retention", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "projects",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("domain", sa.String(128), nullable=False, server_default="Computer Science"),
        sa.Column("source_type", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("source_url", sa.String(512), nullable=False, server_default=""),
        sa.Column("status", sa.String(32), nullable=False, server_default="analyzed"),
        sa.Column("analysis_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "documents",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.String(48), sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("format", sa.String(16), nullable=False, server_default="ieee"),
        sa.Column("citation_style", sa.String(16), nullable=False, server_default="IEEE"),
        sa.Column("raw_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("sections_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("references_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(32), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "document_versions",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("document_id", sa.String(48), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(128), nullable=False),
        sa.Column("sections_json", sa.Text(), nullable=False),
        sa.Column("raw_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "refinement_jobs",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("document_id", sa.String(48), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("mode", sa.String(64), nullable=False),
        sa.Column("scope", sa.String(32), nullable=False, server_default="whole_paper"),
        sa.Column("status", sa.String(32), nullable=False, server_default="processing"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("original_sections_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("refined_sections_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("metrics_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "similarity_reports",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(48), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("overall_similarity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("corpus_coverage", sa.Text(), nullable=False, server_default=""),
        sa.Column("results_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "writing_analyses",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(48), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("metrics_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("observations_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "citation_checks",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(48), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("citations_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("summary_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "quality_evaluations",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(48), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("dimensions_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("recommendations_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "integrity_audits",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.String(48), nullable=True),
        sa.Column("document_id", sa.String(48), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("overall_status", sa.String(32), nullable=False, server_default="Needs review"),
        sa.Column("findings_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("summary_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "activity_logs",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.String(48), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("module", sa.String(64), nullable=False),
        sa.Column("action", sa.String(255), nullable=False),
        sa.Column("entity_title", sa.String(255), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="Completed"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    for tbl in (
        "activity_logs",
        "integrity_audits",
        "quality_evaluations",
        "citation_checks",
        "writing_analyses",
        "similarity_reports",
        "refinement_jobs",
        "document_versions",
        "documents",
        "projects",
        "users",
    ):
        op.drop_table(tbl)
