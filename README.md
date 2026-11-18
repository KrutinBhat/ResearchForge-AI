# ResearchForge AI V1.1

**Tagline:** Research Intelligence. Verified Evidence. Academic Integrity.

ResearchForge AI is a modular full-stack platform for project-grounded research paper authoring, scholarly manuscript refinement, multi-layer textual similarity analysis, descriptive stylometric inspection, live registry citation verification, static code-to-paper auditing, and unified academic integrity reporting.

---

## V1.1 Architecture Overview

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, React Router, Recharts, Lucide Icons, Firebase Web Auth (`src/lib/firebase.ts`).
- **Canonical Backend (`app/` + `alembic/`):** Python FastAPI with Pydantic v2, SQLAlchemy 2.0, Alembic migrations (`alembic/versions/001_initial_schema.py`, `002_v11_upgrade.py`), Celery + Redis worker (`app/worker.py`), SlowAPI rate limiting, and `pgvector` chunk indexing.
- **Database & Auth:** Cloud SQL PostgreSQL (`vector` extension enabled) + Drizzle ORM schema (`src/db/schema.ts`) paired with Firebase Authentication (`firebase-admin` token verification + HS256 JWT fallback).
- **Port-3000 Runtime Adapter (`server.ts` + `server/routes.ts`):** When `FASTAPI_URL` is configured, `server.ts` transparently proxies `/api/*` to the FastAPI backend. In Node-only preview containers without Python pip runtime packages, `server.ts` serves full feature-parity V1.1 engines (`server/engines/*`) backed by the same Cloud SQL PostgreSQL database.
- **Hybrid AI & Deterministic Engines:** Server-side `@google/genai` / `google-genai` (`gemini-4-hydrogen`), optional Ollama local inference, Sentence-Transformers / FAISS / BM25 / TF-IDF similarity, OpenAlex / Crossref / Semantic Scholar / arXiv citation verification, and deterministic **Local Structural** engines so every module runs reliably without fabricated outputs.

---

## Nine Implemented Modules

1. **Module 1 — AI Research Paper Generator (`/generator`):** Generates 12-section IEEE or APA drafts grounded in extracted source-code evidence, user notes, and live OpenAlex retrieval; explicitly inserts `[INPUT NEEDED: ...]` markers for missing metrics or datasets.
2. **Module 2 — Multi-Layer Similarity Engine (`/similarity`):** Exact, 3-gram Jaccard, Dice fuzzy, TF-IDF cosine, BM25, and semantic synonym-stem / embedding overlap at sentence and paragraph granularity across workspace documents, built-in corpus, and live arXiv abstracts. Categorizes matches as `Exact Overlap`, `Paraphrase / Near Match`, `Properly Cited Match`, or `Potentially Uncited Passage` with explicit non-equivalence disclosures.
3. **Module 3 — AI-Writing Pattern Analyzer (`/writing-analysis`):** Descriptive stylometric telemetry (Fano burstiness, MATTR-50, TTR, Guiraud Root TTR, Hapax ratio, Shannon entropy, Zipf slope, trigram repetition rate, transition density, bigram perplexity proxy) plus a 24-excerpt 6-topic leave-one-topic-out standardized classifier benchmark reporting Precision, Recall, F1, Confusion Matrix, and False Positive Rate.
4. **Module 4 — Citation Intelligence Engine (`/citations`):** Queries Crossref, OpenAlex, Semantic Scholar, and arXiv APIs live; separates 6-state bibliographic verification vs. claim support (`Claim supported`, `Claim contradicted`, `Evidence insufficient`, `Source retrieved`, `Bibliographic metadata verified`, `Verification unavailable`); detects duplicate bibliography entries, orphaned citations, and formats IEEE & APA entries.
5. **Module 5 — Research Quality Evaluator (`/quality`):** Evaluates 13 methodological, statistical, dataset, baseline, ablation, reproducibility, limitation, and ethical dimensions with `why`, `location`, `evidence`, and actionable recommendations, plus optional Gemini peer-review critique.
6. **Module 6 — Technical Project-to-Paper Analyzer (`/project-analyzer`):** Magic-byte + Zip-Slip protected archive ingestion and strict HTTPS public GitHub inspection (`https://github.com/owner/repo`) across Python AST, TS/JS, Java, C/C++, SQL/Drizzle schemas, configs, tests, and evaluation JSONs. Cross-checks manuscripts using 4 conservative states: `Confirmed`, `Possible`, `Unsupported`, `Unable to verify`.
7. **Module 7 — Academic Writing Studio (`/studio`):** Section editor, IEEE/APA citation style switch, verified bibliography insertion, revision history, and genuine two-column IEEE / single-column APA `.docx`, `.pdf`, `.tex`, and `.md` exports.
8. **Module 8 — Final Research Integrity Audit (`/audit`):** Conservative 6-pillar aggregator (Similarity, Citations, Code-to-Paper, Methodology Rigor, Stylometric Telemetry, Refinement Preservation) producing `Verified`, `Needs review`, `Unverified`, or `Not evaluated` classifications and downloadable Markdown (`.md`) and JSON audit reports.
9. **Module 9 — Paper Humanization & Refinement Engine (`/refinement`):** Magic-byte validated multi-format upload (`.pdf`, `.docx`, `.doc`, `.txt`, `.rtf`, `.md`, `.tex` with scanned-PDF detection), durable job tracking with progress, cancel, and retry, whole-paper or single-paragraph refinement scope, word-level diff review, and preservation guards verifying citations, equations, numbers, and protected domain terms.

---

## Local Setup & Verification

### Node + Cloud SQL Preview Server
```bash
npm install
npx --yes tsx --test server/engines/engines.test.ts
npm run lint
npm run build
npm run dev
```

### Canonical Python FastAPI + Celery Stack
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
python3 -m unittest discover -s tests -p "test_*.py" -v
uvicorn app.main:app --reload --port 8000
# Optional durable worker:
celery -A app.worker.celery_app worker --loglevel=info --concurrency=2
```

---

## Deployment Targets

- **Frontend (Vercel):** Configured in `vercel.json` with Vite build output (`dist`), SPA fallback, security headers, and `/api/*` rewrite to the hosted FastAPI service.
- **Backend + Worker + Redis (Render):** Blueprint defined in `render.yaml` using `Dockerfile` (`alembic upgrade head && uvicorn app.main:app`).
- **Self-Hosted Container Stack (Docker Compose):** `docker-compose.yml` provisions `pgvector/pgvector:pg16`, `redis:7-alpine`, FastAPI `api`, and Celery `worker`.
