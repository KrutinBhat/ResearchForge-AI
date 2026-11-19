import json
import logging
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .api.routes import analysis, audit_and_refinement, auth, documents, generator, projects
from .core.config import get_settings
from .core.database import check_database_health, init_db
from .core.rate_limit import limiter
from .worker import check_redis_health, recover_interrupted_jobs

settings = get_settings()
logger = logging.getLogger("researchforge.api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.validate_production_security()
    init_db()
    recover_interrupted_jobs()
    yield


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Modular Research Writing, Academic Integrity, and Research Intelligence Platform API",
    docs_url="/docs" if settings.ENVIRONMENT.lower() != "production" else None,
    redoc_url="/redoc" if settings.ENVIRONMENT.lower() != "production" else None,
    openapi_url="/api/docs/openapi.json" if settings.ENVIRONMENT.lower() != "production" else None,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


@app.middleware("http")
async def request_context_and_security_headers(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:12]}"
    request.state.request_id = request_id
    started = time.perf_counter()

    response = await call_next(request)
    latency_ms = round((time.perf_counter() - started) * 1000, 1)

    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; object-src 'none'"

    logger.info(
        json.dumps(
            {
                "event": "http_request",
                "requestId": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "latencyMs": latency_ms,
            }
        )
    )
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", "unknown")
    logger.error(json.dumps({"event": "unhandled_exception", "requestId": request_id, "path": request.url.path, "errorType": type(exc).__name__}))
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An internal processing error occurred.", "requestId": request_id},
    )


@app.get("/health", tags=["Health"])
@app.get("/api/health", tags=["Health"])
@app.get("/api/v1/health", tags=["Health"])
def health_check():
    return JSONResponse(
        {
            "status": "ok",
            "service": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "environment": settings.ENVIRONMENT,
            "demoEnabled": settings.demo_enabled,
            "providers": {
                "geminiConfigured": bool(settings.GEMINI_API_KEY),
                "ollamaBaseUrl": settings.OLLAMA_BASE_URL,
                "redisConfigured": bool(settings.REDIS_URL or settings.CELERY_BROKER_URL),
                "ocrAvailable": bool(shutil.which("tesseract")),
            },
        }
    )


@app.get("/ready", tags=["Health"])
@app.get("/api/ready", tags=["Health"])
@app.get("/api/v1/ready", tags=["Health"])
def readiness_check():
    db_ok = check_database_health()
    redis_status = check_redis_health()
    ocr_available = bool(shutil.which("tesseract"))
    ready = db_ok and (redis_status is not False)
    return JSONResponse(
        status_code=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "ready": ready,
            "checks": {
                "database": "ok" if db_ok else "unavailable",
                "redis": "ok" if redis_status is True else ("disabled" if redis_status is None else "unavailable"),
                "tesseractOcr": "available" if ocr_available else "unavailable",
            },
        },
    )


for api_prefix in (settings.API_PREFIX, settings.API_V1_PREFIX):
    app.include_router(auth.router, prefix=api_prefix)
    app.include_router(projects.router, prefix=api_prefix)
    app.include_router(documents.router, prefix=api_prefix)
    app.include_router(generator.router, prefix=api_prefix)
    app.include_router(analysis.router, prefix=api_prefix)
    app.include_router(audit_and_refinement.router, prefix=api_prefix)

