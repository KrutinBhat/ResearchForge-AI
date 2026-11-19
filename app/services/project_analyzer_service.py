import ast
import io
import json
import posixpath
import re
import zipfile
from typing import Any, Dict, List, Tuple

from ..core.security import (
    is_safe_archive_path,
    validate_file_signature,
    validate_outbound_https_url,
    validate_public_github_url,
)

ALLOWED_GITHUB_HOSTS = {"api.github.com", "raw.githubusercontent.com"}

CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".c", ".cpp", ".h", ".sql"}
CONFIG_FILES = {"package.json", "requirements.txt", "pyproject.toml", "pom.xml", "cargo.toml", "go.mod"}
MAX_READ_FILE_BYTES = 200_000


def _detect_language(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".py"):
        return "Python"
    if lower.endswith((".ts", ".tsx")):
        return "TypeScript"
    if lower.endswith((".js", ".jsx")):
        return "JavaScript"
    if lower.endswith(".java"):
        return "Java"
    if lower.endswith((".c", ".cpp", ".h")):
        return "C/C++"
    if lower.endswith(".sql"):
        return "SQL"
    return "Other"


def _parse_python_ast(path: str, content: str) -> Dict[str, Any]:
    imports: List[str] = []
    models: List[Dict[str, str]] = []
    endpoints: List[Dict[str, str]] = []
    functions: List[str] = []
    seeds_detected = False

    try:
        tree = ast.parse(content)
    except SyntaxError:
        return {"imports": imports, "models": models, "endpoints": endpoints, "functions": functions, "seedsDetected": False}

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.append(node.module.split(".")[0])
        elif isinstance(node, ast.ClassDef):
            bases = [ast.unparse(b) if hasattr(ast, "unparse") else getattr(b, "id", "") for b in node.bases]
            base_str = ", ".join(bases)
            if any(k in base_str for k in ("Module", "BaseModel", "Base", "Model", "Estimator")):
                models.append({"name": node.name, "type": base_str or "Class", "file": path, "details": f"Line {node.lineno}"})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
            for dec in node.decorator_list:
                dec_src = ast.unparse(dec) if hasattr(ast, "unparse") else ""
                m = re.search(r"\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']", dec_src)
                if m:
                    endpoints.append({"method": m.group(1).upper(), "path": m.group(2), "file": path})
        elif isinstance(node, ast.Call):
            call_src = ast.unparse(node.func) if hasattr(ast, "unparse") else ""
            if any(s in call_src for s in ("manual_seed", "seed_everything", "np.random.seed", "random.seed")):
                seeds_detected = True

    return {
        "imports": sorted(set(imports)),
        "models": models,
        "endpoints": endpoints,
        "functions": functions[:40],
        "seedsDetected": seeds_detected,
    }


def analyze_project_files(files: List[Tuple[str, str]], project_name: str = "Analyzed Project") -> Dict[str, Any]:
    """Statically inspect source files using AST and pattern parsers without executing untrusted code."""
    languages: Dict[str, int] = {}
    dependencies: set[str] = set()
    frameworks: set[str] = set()
    models: List[Dict[str, str]] = []
    seen_model_names: set[str] = set()
    datasets: set[str] = set()
    endpoints: List[Dict[str, str]] = []
    databases: List[Dict[str, Any]] = []
    evaluation_evidence: List[Dict[str, Any]] = []
    algorithms: set[str] = set()
    test_files: List[str] = []
    backend_files: List[str] = []
    frontend_files: List[str] = []
    db_files: List[str] = []
    config_files: List[str] = []
    repro_notes: set[str] = set()
    readmes: List[str] = []
    total_lines = 0

    for path, content in files:
        lower_path = path.lower()
        base = posixpath.basename(lower_path)
        ext = posixpath.splitext(lower_path)[1]

        if "node_modules/" in lower_path or "__pycache__/" in lower_path or ".git/" in lower_path:
            continue

        total_lines += len(content.splitlines())

        if ext in CODE_EXTENSIONS:
            lang = _detect_language(base)
            languages[lang] = languages.get(lang, 0) + 1
            if ext in {".tsx", ".jsx"} or "src/pages" in lower_path or "src/components" in lower_path:
                frontend_files.append(path)
            elif ext == ".sql" or "models" in lower_path or "schema" in lower_path:
                db_files.append(path)
            else:
                backend_files.append(path)

        if base in CONFIG_FILES or ext in {".yml", ".yaml", ".toml", ".ini"}:
            config_files.append(path)

        if "test" in lower_path or base.startswith("test_") or base.endswith((".test.ts", ".spec.ts", ".test.py")):
            test_files.append(path)

        if base.startswith("readme"):
            readmes.append(content[:2500])

        if base == "requirements.txt":
            repro_notes.add("Pinned dependencies in requirements.txt")
            for line in content.splitlines():
                pkg = re.split(r"[=<>!~\[]", line.strip())[0].strip()
                if pkg and not pkg.startswith("#"):
                    dependencies.add(pkg)
        elif base == "package.json":
            repro_notes.add("Dependencies declared in package.json")
            try:
                pkg_json = json.loads(content)
                for dep_group in ("dependencies", "devDependencies"):
                    for k in (pkg_json.get(dep_group) or {}).keys():
                        dependencies.add(k)
            except Exception:
                pass

        if ext == ".py":
            py_info = _parse_python_ast(path, content)
            for mod in py_info["models"]:
                if mod["name"] not in seen_model_names:
                    seen_model_names.add(mod["name"])
                    models.append(mod)
            endpoints.extend(py_info["endpoints"])
            if py_info["seedsDetected"]:
                repro_notes.add(f"Deterministic random seed configured in {path}")
            for imp in py_info["imports"]:
                if imp in {"torch", "sklearn", "fastapi", "transformers", "faiss", "sqlalchemy", "celery"}:
                    frameworks.add({"torch": "PyTorch", "sklearn": "Scikit-learn", "fastapi": "FastAPI", "transformers": "HuggingFace Transformers", "faiss": "FAISS", "sqlalchemy": "SQLAlchemy", "celery": "Celery"}[imp])

        for fw, pattern in [
            ("FastAPI", r"\bfastapi\b"),
            ("PyTorch", r"\btorch\b|torch\.nn"),
            ("TensorFlow", r"\btensorflow\b|tf\.keras"),
            ("Scikit-learn", r"\bsklearn\b"),
            ("HuggingFace Transformers", r"\btransformers\b|AutoModel"),
            ("Express.js", r"\bexpress\b"),
            ("React", r"\breact\b"),
            ("SQLAlchemy", r"\bsqlalchemy\b"),
            ("Drizzle ORM", r"\bdrizzle-orm\b"),
            ("FAISS", r"\bfaiss\b"),
        ]:
            if re.search(pattern, content, re.IGNORECASE):
                frameworks.add(fw)

        for m in re.finditer(r"(?:RandomForestClassifier|LogisticRegression|XGBClassifier|SentenceTransformer|BertModel|ResNet|Sequential)", content):
            sym = m.group(0)
            if sym not in seen_model_names:
                seen_model_names.add(sym)
                models.append({"name": sym, "type": "ML/NLP Component", "file": path, "details": "Referenced in source"})

        for m in re.finditer(r"(?:app|router)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']", content):
            endpoints.append({"method": m.group(1).upper(), "path": m.group(2), "file": path})

        for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\"?([A-Za-z0-9_]+)\"?\s*\(([\s\S]{1,400}?)\)", content, re.IGNORECASE):
            cols = [c.strip().split()[0].strip('"') for c in m.group(2).split(",") if c.strip()]
            databases.append({"table": m.group(1), "columns": cols[:10], "file": path})

        for m in re.finditer(r"([A-Za-z0-9_/-]+\.(?:csv|parquet|jsonl|tsv))", content, re.IGNORECASE):
            datasets.add(m.group(1))

        for algo in ("BM25", "TF-IDF", "cosine similarity", "Jaccard", "k-means", "backpropagation", "attention", "FAISS", "FedAvg"):
            if algo.lower() in content.lower():
                algorithms.add(algo)

        if ext == ".json" and any(k in lower_path for k in ("metric", "eval", "result", "report")):
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict):
                    numeric_kv = {k: v for k, v in parsed.items() if isinstance(v, (int, float, str))}
                    if numeric_kv:
                        evaluation_evidence.append({"source": path, "metrics": numeric_kv})
            except Exception:
                pass

    return {
        "projectName": project_name,
        "fileCount": len(files),
        "totalLines": total_lines,
        "languages": sorted(languages.keys()),
        "languageBreakdown": languages,
        "dependencies": sorted(dependencies)[:60],
        "frameworks": sorted(frameworks),
        "architecture": {
            "backend": backend_files[:20],
            "frontend": frontend_files[:20],
            "database": db_files[:15],
            "tests": test_files[:20],
            "configs": config_files[:15],
        },
        "endpoints": endpoints[:40],
        "models": models[:30],
        "modelsDetected": [m["name"] for m in models][:30],
        "algorithms": sorted(algorithms),
        "algorithmsDetected": sorted(algorithms),
        "databases": databases[:20],
        "evaluationEvidence": evaluation_evidence[:20],
        "datasetsDetected": sorted(datasets),
        "testFiles": test_files[:30],
        "reproducibilityNotes": sorted(repro_notes),
        "readmeSummary": "\n".join(readmes)[:2500],
        "securityWarnings": ["Static inspection only; uploaded archives and repository scripts are never executed."],
    }


def extract_and_analyze_zip(zip_bytes: bytes, max_files: int = 450, max_uncompressed_bytes: int = 80 * 1024 * 1024, project_name: str = "Uploaded ZIP Project") -> Dict[str, Any]:
    validate_file_signature(zip_bytes, "archive.zip", expected_ext="zip")
    extracted: List[Tuple[str, str]] = []
    skipped_unsafe: List[str] = []
    total_uncompressed = 0
    max_ratio = 60

    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        infos = zf.infolist()[:max_files]
        for info in infos:
            if info.is_dir():
                continue
            if not is_safe_archive_path(info.filename):
                skipped_unsafe.append(info.filename)
                continue
            if info.compress_size > 0 and (info.file_size / info.compress_size) > max_ratio:
                skipped_unsafe.append(f"{info.filename} (suspicious compression ratio)")
                continue
            total_uncompressed += max(0, info.file_size)
            if total_uncompressed > max_uncompressed_bytes:
                skipped_unsafe.append(f"{info.filename} (uncompressed quota exceeded)")
                break
            if info.file_size > MAX_READ_FILE_BYTES:
                continue
            ext = posixpath.splitext(info.filename.lower())[1]
            base = posixpath.basename(info.filename.lower())
            if ext in CODE_EXTENSIONS or ext in {".md", ".txt", ".json", ".yaml", ".yml", ".toml"} or base in CONFIG_FILES:
                try:
                    raw = zf.read(info.filename).decode("utf-8", errors="ignore")
                    extracted.append((info.filename, raw))
                except Exception:
                    continue

    analysis = analyze_project_files(extracted, project_name=project_name)
    analysis["skippedUnsafePaths"] = skipped_unsafe
    return analysis


def cross_check_paper_against_code(paper_text: str, project_analysis: Dict[str, Any]) -> Dict[str, Any]:
    """4-state verification: Confirmed, Possible, Unsupported, Unable to verify."""
    findings: List[Dict[str, Any]] = []
    lower_paper = paper_text.lower()

    frameworks = project_analysis.get("frameworks", [])
    deps = project_analysis.get("dependencies", [])
    models = project_analysis.get("modelsDetected") or [m.get("name", "") for m in project_analysis.get("models", [])]
    datasets = project_analysis.get("datasetsDetected", [])
    metrics = project_analysis.get("evaluationEvidence", [])
    tests = project_analysis.get("testFiles") or (project_analysis.get("architecture") or {}).get("tests", [])

    claimed_tools = [
        t for t in ("PyTorch", "TensorFlow", "FastAPI", "Scikit-learn", "React", "Express", "FAISS", "SQLAlchemy", "Drizzle")
        if t.lower() in lower_paper
    ]
    for idx, tool in enumerate(claimed_tools):
        fw_hit = any(tool.lower() in fw.lower() for fw in frameworks)
        dep_hit = any(tool.lower() in d.lower() for d in deps)
        status = "Confirmed" if fw_hit else ("Possible" if dep_hit else "Unsupported")
        findings.append({
            "id": f"cc_fw_{idx + 1}",
            "category": "Framework / Dependency Claim",
            "status": status,
            "claimExcerpt": f"Manuscript references '{tool}'.",
            "codeEvidence": f"Frameworks: {frameworks}; Dependencies sample: {deps[:10]}" if (fw_hit or dep_hit) else "Not detected in AST imports or dependency manifests.",
            "explanation": "Matched directly in AST/imports." if status == "Confirmed" else ("Present in dependencies without direct AST usage." if status == "Possible" else "Claimed framework was not found in repository source."),
        })

    for idx, model in enumerate(models[:8]):
        mentioned = model.lower() in lower_paper
        findings.append({
            "id": f"cc_mod_{idx + 1}",
            "category": "Model / Component Traceability",
            "status": "Confirmed" if mentioned else "Possible",
            "claimExcerpt": f"Repository symbol '{model}'",
            "codeEvidence": f"AST/symbol scan detected '{model}'.",
            "explanation": "Implemented model symbol is documented in the manuscript." if mentioned else "Implemented in repository code; verify whether omission from paper text is intentional.",
        })

    if "dataset" in lower_paper or "benchmark" in lower_paper:
        findings.append({
            "id": "cc_data_1",
            "category": "Dataset Artifact Presence",
            "status": "Confirmed" if datasets else "Unable to verify",
            "claimExcerpt": "Manuscript discusses empirical datasets or benchmarks.",
            "codeEvidence": f"Detected dataset references: {datasets}" if datasets else "No local CSV/Parquet/JSONL data file references found in archive.",
            "explanation": "Dataset filenames confirmed in repo." if datasets else "External or unbundled datasets cannot be verified from source code alone.",
        })

    pct_claims = re.findall(r"\b\d{1,3}(?:\.\d+)?%", paper_text)
    if pct_claims:
        if metrics:
            eval_str = json.dumps(metrics[:4])
            matched_pct = any(p.rstrip("%") in eval_str for p in pct_claims)
            findings.append({
                "id": "cc_met_1",
                "category": "Quantitative Metric Verification",
                "status": "Confirmed" if matched_pct else "Possible",
                "claimExcerpt": f"Manuscript cites quantitative figures: {', '.join(pct_claims[:5])}",
                "codeEvidence": f"Evaluation logs found: {eval_str[:220]}",
                "explanation": "Reported numeric metrics align with evaluation logs." if matched_pct else "Evaluation logs exist, but exact percentage values require manual reconciliation.",
            })
        else:
            findings.append({
                "id": "cc_met_1",
                "category": "Quantitative Metric Verification",
                "status": "Unable to verify",
                "claimExcerpt": f"Manuscript cites quantitative figures: {', '.join(pct_claims[:5])}",
                "codeEvidence": "No JSON metric/evaluation log artifacts found in repository.",
                "explanation": "Cannot verify numeric claims without experimental output artifacts.",
            })

    if tests or "test" in lower_paper:
        status = "Confirmed" if (tests and ("test" in lower_paper or "evaluation" in lower_paper)) else ("Unsupported" if ("unit test" in lower_paper and not tests) else "Possible")
        findings.append({
            "id": "cc_test_1",
            "category": "Test & Verification Coverage",
            "status": status,
            "claimExcerpt": "Automated verification / test coverage",
            "codeEvidence": f"{len(tests)} test files: {', '.join(tests[:4])}" if tests else "No test files detected.",
            "explanation": "Test suite presence aligns with manuscript." if status == "Confirmed" else "Mismatch or ambiguity between test claims and repository test files.",
        })

    confirmed_n = sum(1 for f in findings if f["status"] == "Confirmed")
    unsupported_n = sum(1 for f in findings if f["status"] == "Unsupported")
    alignment = round((confirmed_n / max(len(findings), 1)) * 100.0, 1)

    return {
        "alignmentPercent": alignment,
        "confirmedClaims": confirmed_n,
        "unsupportedClaims": unsupported_n,
        "verifiedClaims": confirmed_n,
        "unverifiedClaims": unsupported_n,
        "findings": findings,
    }


async def analyze_github_repository(repo_url: str) -> Dict[str, Any]:
    import httpx

    owner, repo = validate_public_github_url(repo_url)
    files: List[Tuple[str, str]] = []
    async with httpx.AsyncClient(timeout=12.0, headers={"User-Agent": "ResearchForgeAI/1.1"}) as client:
        repo_url_api = validate_outbound_https_url(f"https://api.github.com/repos/{owner}/{repo}", ALLOWED_GITHUB_HOSTS)
        repo_resp = await client.get(repo_url_api)
        if repo_resp.status_code != 200:
            raise ValueError(f"GitHub repository lookup failed with status {repo_resp.status_code}")
        meta = repo_resp.json()
        branch = meta.get("default_branch", "main")

        tree_url_api = validate_outbound_https_url(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1",
            ALLOWED_GITHUB_HOSTS,
        )
        tree_resp = await client.get(tree_url_api)
        if tree_resp.status_code == 200:
            tree = tree_resp.json().get("tree", [])
            candidates = [
                item["path"]
                for item in tree
                if item.get("type") == "blob"
                and is_safe_archive_path(item["path"])
                and (
                    posixpath.splitext(item["path"].lower())[1] in CODE_EXTENSIONS
                    or posixpath.basename(item["path"].lower()) in CONFIG_FILES
                    or posixpath.basename(item["path"].lower()).startswith("readme")
                )
            ][:35]
            for path in candidates:
                raw_url = validate_outbound_https_url(
                    f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}",
                    ALLOWED_GITHUB_HOSTS,
                )
                raw_resp = await client.get(raw_url)
                if raw_resp.status_code == 200 and len(raw_resp.text) <= MAX_READ_FILE_BYTES:
                    files.append((path, raw_resp.text))

    analysis = analyze_project_files(files, project_name=meta.get("full_name", f"{owner}/{repo}"))
    analysis["githubMeta"] = {
        "fullName": meta.get("full_name", f"{owner}/{repo}"),
        "description": meta.get("description") or "",
        "stars": meta.get("stargazers_count", 0),
        "primaryLanguage": meta.get("language") or "Unknown",
    }
    return analysis
