def test_fastapi_application_and_request_schemas_import():
    from app.main import app

    schema = app.openapi()
    assert schema["info"]["title"] == "ResearchForge AI"
    assert "/api/auth/register" in schema["paths"]


def test_managed_postgres_urls_select_installed_psycopg_driver(monkeypatch):
    from app.core.config import _resolve_database_url

    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@db.example:5432/researchforge")
    monkeypatch.delenv("POSTGRES_DSN", raising=False)
    monkeypatch.delenv("SQL_HOST", raising=False)
    monkeypatch.delenv("SQL_USER", raising=False)
    monkeypatch.delenv("SQL_DB_NAME", raising=False)
    assert _resolve_database_url("production") == "postgresql+psycopg://user:pass@db.example:5432/researchforge"

    monkeypatch.setenv("DATABASE_URL", "postgres://user:pass@db.example:5432/researchforge")
    assert _resolve_database_url("production") == "postgresql+psycopg://user:pass@db.example:5432/researchforge"
