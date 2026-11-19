# ResearchForge AI Engineering Audit

**Audit date:** 2026-11-19  
**Scope:** Repository structure, backend/frontend entry points, data models and migrations, AI/document services, tests, and deployment configuration. This is a static audit plus baseline command attempts; external integrations and production deployment were not available.

## Assessment

**Readiness rating: 5/10.**

The repository has a substantial FastAPI implementation and a premium React/Vite workspace with all nine advertised modules represented. The deployed Render API is FastAPI, and its Alembic chain includes PostgreSQL/pgvector support. A broad Express/Drizzle implementation still overlaps the API. Local Vite now proxies `/api` to FastAPI, while the optional Express adapter remains available under a separate command. The second backend still creates long-term parity and maintenance risk.

### Priority findings

| Priority | Finding, root cause, impact | Affected files | Recommended resolution |
| --- | --- | --- | --- |
| **High** | Upload size validation happens after `UploadFile.read()` loads the complete upload into process memory. A request larger than the configured 25 MiB limit can consume substantially more memory before rejection; concurrent requests amplify the risk. | `app/api/deps.py` | Read in bounded chunks, stop as soon as the byte limit is crossed, and close the temporary upload. **Implemented in this stabilization pass.** |
| **Resolved** | FastAPI startup imports `EmailStr`, but `email-validator` was absent from `requirements.txt`; application import failed before serving requests. | `app/schemas/common.py`, `requirements.txt`, `tests/test_application_startup.py` | Added the pinned dependency, application schema import guard and verified local health/readiness. |
| **High** | `GEMINI_MODEL` is configurable but unused; generation, refinement and critique hardcode `gemini-4-hydrogen`. That identifier is absent from Google's current model catalog, so provider calls can fail and silently fall through to heuristic/local output. | `app/core/config.py`, `app/services/generator_refinement_service.py`, `app/services/quality_audit_service.py`, `app/api/routes/generator.py`, `app/api/routes/analysis.py`, `app/worker.py` | Use the configured model consistently and identify the actual engine in output. Implemented with a current catalog model as the default; validate using a real provider key before production. [Google Gemini model catalog](https://ai.google.dev/gemini-api/docs/models). |
| **Medium** | PDF verification delegated structural checks to PyMuPDF, which can accept truncated files without an EOF marker and undercount explicit page objects when `/Count` metadata is stale. The existing export regression test failed on both cases. | `app/services/export_service.py` | Require a trailing EOF marker and compare parsed page count with explicit `/Type /Page` objects, excluding `/Type /Pages`. Implemented and covered by the existing regression test. |
| **High** | Two independently implemented API stacks expose overlapping authentication, project, document, citation and analysis workflows. The Express stack also owns Node/Drizzle tables and separate engines, creating route, persistence and security parity risk. | `server.ts`, `server/routes.ts`, `server/engines/*`, `src/db/*`, `vite.config.ts`, `Dockerfile`, `render.yaml`, `vercel.json` | Keep FastAPI canonical. Local Vite now proxies to FastAPI; isolate or retire Express only after proving no active consumers and documenting data compatibility. |
| **High** | A database WAL file is tracked in Git. Its contents are not inspected or reproduced here; it may contain application data. Existing ignore rules omit WAL/SHM, general SQLite extensions, and the `data/` directory. | `data/researchforge.db-wal`, `.gitignore` | Treat the tracked file as a possible data exposure; review it privately, remove it from future commits only after preserving/validating useful data, and rotate credentials only if investigation finds any. Ignore database and private-data paths going forward. Ignore rules updated; tracked file intentionally preserved. |
| **High** | Production database initialization checks connectivity but does not run migrations. The Docker command runs migrations before API startup, while the worker overrides that command. Concurrent service rollout and backward-incompatible schema changes still require coordination. | `app/core/database.py`, `Dockerfile`, `render.yaml`, `alembic/*` | Render API now runs `alembic upgrade head` as a pre-deploy command before starting the new API instance. Keep schema changes backward-compatible across worker/API rollout and verify against production-like PostgreSQL. |
| **Medium** | The readiness endpoint treats configured Redis failure as total API unavailability even where synchronous/background-task fallback may allow non-Celery operation. Conversely, deployments relying on Celery need to distinguish broker and worker health. | `app/main.py`, `app/worker.py`, `render.yaml`, `docker-compose.yml` | Define whether Redis is required per deployment mode and report API, broker and worker readiness separately. |
| **Medium** | Database schema work is split across SQLAlchemy/Alembic and Drizzle, with no documented single migration authority or parity check. SQLite is the development fallback despite PostgreSQL/pgvector being the production target. | `alembic/*`, `src/db/*`, `app/core/config.py`, `README.md` | Declare Alembic authoritative for the FastAPI product; isolate or remove Drizzle schema only after confirming the Express adapter is no longer required. Test clean PostgreSQL migration and upgrade paths. |
| **Medium** | Long synchronous operations (embedding/model loading, OCR and some analyses) can run in request or in-process background paths. Optional dependencies/providers can fail or increase latency, and availability of Redis changes dispatch behavior. | `app/api/routes/*`, `app/services/*`, `app/worker.py` | Bound request work and payload sizes, document fallback behavior, and ensure heavy workflows use the durable worker in production. Add provider and job integration checks with external dependencies clearly marked. |
| **Medium** | AI and analytic output labels include `Verified` and numeric percentages even where the underlying logic is heuristic. Writing analysis includes hand-authored synthetic comparison samples; similarity scoring falls back to lexical heuristics when embeddings are unavailable. These outputs are not scientific plagiarism/authorship determinations. | `app/services/writing_service.py`, `app/services/similarity_service.py`, `app/services/quality_audit_service.py`, `server/engines/writingAnalyzer.ts`, `server/engines/similarityEngine.ts`, affected UI | Keep uncertainty and method provenance visible; avoid presenting heuristic labels as proof. Confirm provider failure cannot be mistaken for a completed external verification. |
| **Medium** | API client requests have no general timeout or cancellation; only selected upstream provider calls have timeouts. A stalled server can leave UI actions pending indefinitely. | `src/lib/api.ts`, `src/pages/*`, `app/services/*` | Add shared request timeouts and user-visible retry/error states, taking upload and long-running job workflows into account. |
| **Resolved** | Vite 8.3.8 required optional peer `esbuild ^0.27 || ^0.28`, while the root manifest specified `^0.25.0`, causing npm resolution to fail. | `package.json`, `bun.lock` | Updated to `^0.28.2`, regenerated the lockfile and installed with `bun install --frozen-lockfile`. TypeScript and production build pass. |
| **Low** | The repository contains a Bun lockfile while commands also use npm, and package metadata remains generic (`react-example`). | `bun.lock`, `package.json`, `README.md`, `vercel.json` | Bun is documented as the installer and lockfile authority. Avoid a competing npm lockfile; package name can be normalized separately. |
| **Low** | There is no frontend component test suite. A test script now runs the existing Node engine tests; backend tests use unittest under pytest. | `package.json`, `tests/*`, `server/engines/engines.test.ts` | Continue integration coverage; existing Node engine tests run through `npm test`. |

## Module trace

The React routes in `src/App.tsx` cover the nine modules: generator, similarity, writing analysis, citations, quality evaluation, project analysis, writing studio, integrity audit, and refinement. Their screens call `/api/*` through `src/lib/api.ts`; document and project selection use the shared FastAPI endpoints. FastAPI registers route modules in `app/main.py` under both `/api` and `/api/v1`:

1. Generator → `app/api/routes/generator.py` → grounding/provider service → persisted document/version/chunks.
2. Similarity → `analysis.py` → local corpus, workspace chunks and optional embeddings → persisted report.
3. Writing analysis → `analysis.py` → stylometric heuristic service → persisted analysis.
4. Citation intelligence → `analysis.py` → Crossref/OpenAlex/arXiv lookup and BibTeX parser/export → citation records/checks.
5. Quality evaluation → `analysis.py` → structural heuristics plus optional Gemini critique → persisted evaluation.
6. Project analyzer → `projects.py` → ZIP/GitHub static inspection and paper/code cross-check → persisted project.
7. Writing studio → `documents.py` → CRUD, versions, section parsing and DOCX/PDF/TeX/BibTeX export.
8. Integrity audit → `audit_and_refinement.py` → combines similarity, writing, citation and quality checks → stored audit/report.
9. Refinement → `audit_and_refinement.py` → durable job record → Celery or in-process fallback → review/approve into document version.

`server/routes.ts` and `server/engines/*` implement a second, overlapping route to most of these capabilities. This report does not assume the Express implementation is redundant: its route surface and local startup are active. `Firebase` client configuration is public client configuration, not an admin credential; production Firebase Admin credentials are read from environment configuration.

## Baseline and security inventory

- Git baseline: clean working tree on `main`; no branch was created. No user edits were present.
- Initial `pytest -q`: `pytest` was not on PATH. The configured `.venv` executable ran the original suite: **19 passed, 1 failed** in PDF verification. Final full pytest after PDF and startup dependency fixes: **22 passed, 11 warnings**. Warnings include PyMuPDF deprecations and an scikit-learn solver-option warning. Python was not available on PATH for a rerun during Docker verification.
- Frontend: **354 packages installed** from the regenerated Bun lockfile. TypeScript validation (`npm.cmd run lint`) passed. Production build passed; after route splitting, largest chunks are 413 kB (chart library) and 373 kB (main app). Vite's deprecated `__dirname` warning is fixed.
- Existing TypeScript engine suite: **16 passed, 0 failed** through the new `npm test` script.
- Local smoke check: FastAPI started against isolated SQLite; `/api/health` and `/api/ready` returned 200. Vite served `/` and its `/api/health` proxy returned the FastAPI response.
- Python dependency consistency: `pip check` reported no broken requirements.
- Python dependencies were already present in the configured virtual environment. No production integration was claimed.
- Tracked sensitive-looking artifact: `data/researchforge.db-wal`; no credential values or artifact contents are included in this report. `firebase-applet-config.json` is a public client config file; private Firebase service-account material is expected through environment settings.
- Docker Compose PostgreSQL and Redis started healthy, the migration service exited successfully, and the API readiness endpoint returned healthy database, Redis, and Tesseract checks. The Celery worker exposed `redis-py==5.2.1` incompatibility with Kombu's minimum 6.1.0; `requirements.txt` now pins 6.1.0. Docker Desktop did not complete exporting the updated shared app image during this audit, so the corrected worker runtime remains unverified.
- Gemini and Firebase provider integrations, Render, Vercel, and production deployment were not tested.

## Deployment blockers and preserved behavior

- Local Vite development proxies to `FASTAPI_URL` or defaults to `http://127.0.0.1:8000`; FastAPI must be started separately. Docker Compose publishes its API on port 8001, PostgreSQL on 5433, and Redis on 6380 to avoid common occupied ports.
- Render requires PostgreSQL settings, Redis service configuration, Firebase project/service-account settings, CORS origins and Gemini key for AI-backed features. Vercel API rewrite currently targets a fixed Render hostname.
- Render's API now runs migrations before the new web instance starts; worker rollout still requires backward-compatible schemas and production verification. Docker Compose uses development credentials and should remain local-only.
- OCR requires Tesseract; Docker installs it, but local setup must supply it separately.
- Preserve the existing React UI and all nine module workflows, Firebase and local/demo authentication modes, user-owned document/project access, citation registry checks, exports, and the current FastAPI route contracts while resolving the split backend.

## Changes in this pass

- `.gitignore`: added ignore coverage for all of `data/`, SQLite database/WAL/SHM files, Python bytecode and local upload/log directories. This does not untrack or delete existing artifacts.
- `app/api/deps.py`: upload ingestion now reads in bounded chunks, stops at the configured limit, and closes the upload; regression tests cover exact-limit and oversized uploads.
- `app/core/config.py`, `app/services/generator_refinement_service.py`, `app/services/quality_audit_service.py`, `app/api/routes/generator.py`, `app/api/routes/analysis.py`, `app/worker.py`: route the configured Gemini model into all Python provider calls and report its actual identifier.
- `app/services/export_service.py`: PDF export verification now rejects missing EOF markers and accounts for explicit page objects when parser page-tree metadata is stale.
- `requirements.txt`, `.env.example`: included the email validation dependency and documented Gemini model selection.
- `render.yaml`: runs Alembic migrations in the API pre-deploy phase.
- `tests/test_application_startup.py`: guards FastAPI route/schema import and catches undeclared Pydantic schema dependencies.
- `package.json`, `bun.lock`: aligned esbuild with Vite 8, added the Node engine test command and separated Vite/Express development commands.
- `vite.config.ts`, `.env.example`, `src/App.tsx`: configured the FastAPI proxy, removed deprecated Vite path usage and lazy-loaded page routes.
- `README.md`: corrected repository-root setup, environment names, migrations and local start commands.
- `Dockerfile`, `.dockerignore`, `requirements-docker.txt`, `docker-compose.yml`: added a non-root image with CPU-only PyTorch, restricted build context, shared API/worker/migration image, one-shot migrations, and local PostgreSQL/Redis/API ports. Compose health checks verified the database, Redis, migration, and API; the image export delay prevented verification of the corrected worker.
- `requirements.txt`: updated Redis client to 6.1.0 to meet Celery/Kombu's Redis transport requirement.
- `app/core/config.py`, `.env.example`, `docker-compose.yml`: included Vite's default localhost:5173 origins and documented Firebase and Docker API settings; production must replace local CORS origins with the deployed frontend origins.
- `tests/test_security_and_exports.py`: isolated the Alembic upgrade/downgrade test in a temporary SQLite database so it cannot collide with the developer's existing local database.
- `tests/test_security_and_exports.py`: added bounded-upload regression tests.
- `ENGINEERING_AUDIT.md`: this audit and baseline record.

## Remaining work

The FastAPI and Express backends still overlap. Docker's corrected worker image needs a completed local image export and runtime check. Provider-backed Gemini/Firebase flows and production hosting still require provider credentials and external verification. No production deployment was performed.
