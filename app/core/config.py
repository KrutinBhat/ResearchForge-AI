import os
from functools import lru_cache
from typing import List
from urllib.parse import quote_plus
from pydantic_settings import BaseSettings, SettingsConfigDict


def _resolve_database_url() -> str:
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
        return explicit_dsn

    return "sqlite:///./data/researchforge_fastapi.db"


class Settings(BaseSettings):
    APP_NAME: str = "ResearchForge AI"
    APP_VERSION: str = "1.1.0"
    ENVIRONMENT: str = "development"
    API_PREFIX: str = "/api"

    DATABASE_URL: str = _resolve_database_url()

    # Security & Auth
    JWT_SECRET: str = "researchforge-dev-ephemeral-secret"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7
    FIREBASE_PROJECT_ID: str = ""
    ENABLE_DEMO_WORKSPACE: bool = True

    # Uploads & Rate Limits
    MAX_UPLOAD_BYTES: int = 25 * 1024 * 1024
    MAX_ARCHIVE_FILES: int = 450
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: int = 80 * 1024 * 1024
    RATE_LIMIT_PER_MINUTE: int = 120

    # Background Tasks (Celery + Redis)
    REDIS_URL: str = ""
    CELERY_BROKER_URL: str = ""
    CELERY_RESULT_BACKEND: str = ""
    JOB_TIMEOUT_SECONDS: int = 180

    # AI / Model Providers
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-4-hydrogen"
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3.1"
    EMBEDDING_MODEL_NAME: str = "sentence-transformers/all-MiniLM-L6-v2"
    CONTACT_MAILTO: str = "researchforge@example.edu"

    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def validate_production_security(self) -> None:
        if self.ENVIRONMENT.lower() == "production":
            if not self.JWT_SECRET or "dev" in self.JWT_SECRET or "change-me" in self.JWT_SECRET:
                raise RuntimeError("JWT_SECRET must be set to a cryptographically strong value in production.")

    @property
    def demo_enabled(self) -> bool:
        return self.ENVIRONMENT.lower() != "production" and self.ENABLE_DEMO_WORKSPACE


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.DATABASE_URL or settings.DATABASE_URL.startswith("sqlite"):
        resolved = _resolve_database_url()
        if not resolved.startswith("sqlite"):
            settings.DATABASE_URL = resolved
    return settings
