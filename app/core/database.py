from typing import Generator
from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from .config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()

if settings.ENVIRONMENT.lower() == "production" and (not settings.DATABASE_URL or settings.DATABASE_URL.startswith("sqlite")):
    raise RuntimeError("Cloud SQL PostgreSQL DSN is required when ENVIRONMENT=production.")

db_url = settings.DATABASE_URL or "sqlite:///./data/researchforge_fastapi.db"
connect_args = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
engine = create_engine(
    db_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_size=10 if not db_url.startswith("sqlite") else 5,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """In production, rely strictly on Alembic migrations; create_all runs only in local dev/test."""
    from ..models import entities  # noqa: F401

    if settings.ENVIRONMENT.lower() == "production":
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return

    if not db_url.startswith("sqlite"):
        try:
            with engine.begin() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        except Exception:
            pass
    Base.metadata.create_all(bind=engine)


def check_database_health() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
