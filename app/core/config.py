import json
import os
from functools import lru_cache
from pathlib import Path
from typing import List
from urllib.parse import quote_plus
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _resolve_database_url(environment: str | None = None) -> str:
    env_name = (environment or os.getenv("ENVIRONMENT", "development")).strip().lower()
    sql_host = os.getenv("SQL_HOST", "").strip()
    sql_user = os.getenv("SQL_USER", "").strip()
    sql_password = os.getenv("SQL_PASSWORD", "").strip()
    sql_db = os.getenv("SQL_DB_NAME", "").strip()

    if sql_host and sql_user and sql_db:
        pwd = quote_plus(sql_password)
        if sql_host.startswith("/"):
            return f"postgresql+psycopg://{quote_plus(sql_user)}:{pwd}@/{sql_db}?host={quote_plus(sql_host)}"
        return f"postgresql+psycopg://{quote_plus(sql_user)}:{pwd}@{sql_host}/{sql_db}"

    explicit_dsn = os.getenv("POSTGRES_DSN", "").strip() or os.getenv("DATABASE_URL", "").strip()
    if explicit_dsn:
        # Render and most managed Postgres providers expose postgresql:// URLs.
        # This project installs psycopg v3, so select its SQLAlchemy dialect explicitly.
        if explicit_dsn.startswith("postgres://"):
            return "postgresql+psycopg://" + explicit_dsn[len("postgres://"):]
        if explicit_dsn.startswith("postgresql://"):
            return "postgresql+psycopg://" + explicit_dsn[len("postgresql://"):]
        return explicit_dsn

    if env_name == "production":
        return ""
    return "sqlite:///./data/researchforge_fastapi.db"


def _resolve_firebase_project_id() -> str:
    env_val = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if env_val:
        return env_val
    cfg_path = Path("firebase-applet-config.json")
    if cfg_path.exists():
        try:
            pid = str(json.loads(cfg_path.read_text(encoding="utf-8")).get("projectId", "")).strip()
            if pid and not pid.startswith("remixed-"):
                return pid
        except Exception:
            pass
    return ""


class Settings(BaseSettings):
    APP_NAME: str = "ResearchForge AI"
    APP_VERSION: str = "1.2.0"
    ENVIRONMENT: str = "development"
    API_PREFIX: str = "/api"
    API_V1_PREFIX: str = "/api/v1"

    DATABASE_URL: str = _resolve_database_url()

    # Security & Auth
    JWT_SECRET: str = ""
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    FIREBASE_PROJECT_ID: str = _resolve_firebase_project_id()
    FIREBASE_SERVICE_ACCOUNT_JSON: str = ""
    FIREBASE_CHECK_REVOKED: bool = False
    ENABLE_DEMO_WORKSPACE: bool = True

    # Uploads, SSRF & Rate Limits
    MAX_UPLOAD_BYTES: int = 25 * 1024 * 1024
    MAX_ARCHIVE_FILES: int = 450
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: int = 80 * 1024 * 1024
    MAX_ARCHIVE_COMPRESSION_RATIO: int = 60
    RATE_LIMIT_PER_MINUTE: int = 120
    AUTH_RATE_LIMIT_PER_MINUTE: int = 30
    ANALYSIS_RATE_LIMIT_PER_MINUTE: int = 45

    # Background Tasks (Celery + Redis)
    REDIS_URL: str = ""
    CELERY_BROKER_URL: str = ""
    CELERY_RESULT_BACKEND: str = ""
    JOB_TIMEOUT_SECONDS: int = 180
    JOB_MAX_RETRIES: int = 2

    # AI / Model Providers & Scholarly Caching
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.6-flash"
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3.1"
    EMBEDDING_MODEL_NAME: str = "sentence-transformers/all-MiniLM-L6-v2"
    CONTACT_MAILTO: str = "researchforge@example.edu"
    SCHOLARLY_CACHE_TTL_SECONDS: int = 3600

    CORS_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value):
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned:
                return []
            if cleaned.startswith("["):
                return json.loads(cleaned)
            return [origin.strip() for origin in cleaned.split(",") if origin.strip()]
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        enable_decoding=False,
    )

    def effective_jwt_secret(self) -> str:
        if self.JWT_SECRET and self.JWT_SECRET.strip():
            return self.JWT_SECRET.strip()
        if self.ENVIRONMENT.lower() in {"development", "test"}:
            return "researchforge-local-dev-only-key-not-for-prod"
        return ""

    def validate_production_security(self) -> None:
        if self.ENVIRONMENT.lower() != "production":
            return

        secret = self.effective_jwt_secret()
        insecure_markers = ("dev", "ephemeral", "change-me", "replace-with", "local-dev")
        if not secret or len(secret) < 32 or any(m in secret.lower() for m in insecure_markers):
            raise RuntimeError("Production startup blocked: JWT_SECRET must be at least 32 chars and non-default.")

        if not self.DATABASE_URL or self.DATABASE_URL.startswith("sqlite"):
            raise RuntimeError("Production startup blocked: Cloud SQL PostgreSQL configuration is required (SQLite disallowed).")

        if not self.FIREBASE_PROJECT_ID:
            raise RuntimeError("Production startup blocked: FIREBASE_PROJECT_ID must be configured.")

        if self.FIREBASE_SERVICE_ACCOUNT_JSON.strip():
            from .security import parse_service_account_source

            parsed_sa = parse_service_account_source(self.FIREBASE_SERVICE_ACCOUNT_JSON)
            if not parsed_sa or not parsed_sa.get("client_email") or not parsed_sa.get("private_key"):
                raise RuntimeError(
                    "Production startup blocked: FIREBASE_SERVICE_ACCOUNT_JSON is invalid or missing client_email/private_key."
                )

        if not self.CORS_ORIGINS or any(o.strip() == "*" for o in self.CORS_ORIGINS):
            raise RuntimeError("Production startup blocked: explicit non-wildcard CORS_ORIGINS are required.")

        if self.ENABLE_DEMO_WORKSPACE:
            # Never permit demo accounts in production even if accidentally toggled on
            self.ENABLE_DEMO_WORKSPACE = False

    @property
    def demo_enabled(self) -> bool:
        return self.ENVIRONMENT.lower() != "production" and self.ENABLE_DEMO_WORKSPACE


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    resolved = _resolve_database_url(settings.ENVIRONMENT)
    if resolved and (not settings.DATABASE_URL or settings.DATABASE_URL.startswith("sqlite")):
        settings.DATABASE_URL = resolved
    if not settings.FIREBASE_PROJECT_ID:
        settings.FIREBASE_PROJECT_ID = _resolve_firebase_project_id()
    return settings
