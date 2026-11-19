import os
from logging.config import fileConfig
from pathlib import Path
from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_settings
from app.core.database import Base
from app.models import entities  # noqa: F401

config = context.config
if config.config_file_name and os.path.exists(config.config_file_name):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

settings = get_settings()
effective_url = settings.DATABASE_URL or "sqlite:///./data/researchforge_fastapi.db"
if effective_url.startswith("sqlite:///"):
    db_file_part = effective_url.replace("sqlite:///", "", 1)
    if db_file_part and db_file_part != ":memory:":
        Path(db_file_part).parent.mkdir(parents=True, exist_ok=True)

# Escape '%' as '%%' so ConfigParser interpolation does not crash on URL-encoded passwords (e.g. %40)
config.set_main_option("sqlalchemy.url", effective_url.replace("%", "%%"))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    is_sqlite = bool(url and url.startswith("sqlite"))
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=is_sqlite,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        is_sqlite = connection.dialect.name == "sqlite"
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=is_sqlite,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

