import json
import os
import re
from typing import Any, Dict, List, Optional


def evaluate_research_quality(text: str, title: str = "Manuscript") -> Dict[str, Any]:
    lower = text.lower()
    words = len(re.findall(r"\b\w+\b", text))

    def check(
        key: str,
        label: str,
        passed: bool,
        strong_score: int,
        location: str,
        why: str,
        evidence_ok: str,
        evidence_weak: str,
        how_to_improve: str,
    ) -> Dict[str, Any]:
        return {
            "key": key,
            "dimension": label,
            "score": strong_score if passed else max(32, strong_score - 36),
            "status": "Strong" if passed else "Needs improvement",
            "location": location,
            "why": why,
            "evidence": evidence_ok if passed else evidence_weak,
            "recommendation": "Meets academic baseline." if passed else how_to_improve,
        }

    dimensions: List[Dict[str, Any]] = [
        check(
            "abstract",
            "Abstract & Contribution Clarity",
            "abstract" in lower and words >= 250,
            88,
            "Abstract section",
            "Reviewers evaluate novelty and scope within the first 250 words.",
            "Structured Abstract framing cues detected.",
            "Dedicated Abstract section or sufficient manuscript context missing.",
            "Write a 150-250 word Abstract stating problem, method, dataset, and primary quantitative outcome.",
        ),
        check(
            "problem",
            "Problem Statement & Research Gap",
            any(k in lower for k in ("problem statement", "research gap", "challenge", "limitation of prior")),
            85,
            "Introduction / Problem Statement",
            "Clarifies why existing literature cannot resolve the target task.",
            "Explicit problem statement and gap framing detected.",
            "Prior-art gap or explicit problem formulation not clearly stated.",
            "Add a dedicated Problem Statement contrasting specific limitations of prior baselines.",
        ),
        check(
            "literature",
            "Literature Review & Synthesis",
            any(k in lower for k in ("literature", "related work", "prior work")) and bool(re.search(r"\[\d+\]|\([A-Z][a-z]+.*?(?:19|20)\d{2}\)", text)),
            86,
            "Literature Review / Related Work",
            "Situates contributions against peer-reviewed state of the art.",
            "Related work section paired with inline academic citations.",
            "Literature synthesis lacks comparative inline citations.",
            "Compare >= 5 peer-reviewed baselines with inline citations and highlight methodological differences.",
        ),
        check(
            "methodology",
            "Methodology Transparency",
            any(k in lower for k in ("methodology", "proposed method", "algorithm", "objective", "loss")),
            87,
            "Proposed Methodology",
            "Enables independent verification of algorithmic logic.",
            "Methodology steps and algorithmic formulation described.",
            "Algorithmic steps or optimization objective insufficiently detailed.",
            "Document formal equations, inputs/outputs, and step-by-step algorithmic pseudocode.",
        ),
        check(
            "architecture",
            "System Architecture & Component Traceability",
            any(k in lower for k in ("architecture", "pipeline", "module", "component", "api", "schema")),
            84,
            "System Architecture",
            "Connects high-level claims to concrete software/hardware modules.",
            "Architectural component breakdown detected.",
            "System architecture or module boundaries not explicitly detailed.",
            "Add an Architecture section describing data flow across ingestion, inference, and storage layers.",
        ),
        check(
            "datasets",
            "Dataset & Sampling Documentation",
            any(k in lower for k in ("dataset", "corpus", "sample size", "train", "validation", "split")),
            84,
            "Experimental Setup",
            "Dataset provenance and split hygiene govern generalization validity.",
            "Dataset origin or train/test sampling protocol referenced.",
            "Dataset sample counts, provenance, or split criteria missing.",
            "Specify dataset source, sample count, train/validation/test split ratios, and preprocessing.",
        ),
        check(
            "baselines",
            "Comparative Baselines & Ablations",
            any(k in lower for k in ("baseline", "ablation", "comparison", "outperform", "benchmark")),
            85,
            "Results and Discussion",
            "Ablations isolate which components drive observed performance.",
            "Baseline or ablation comparisons referenced.",
            "No comparative baseline or ablation analysis detected.",
            "Report ablation rows removing key components alongside standard literature baselines.",
        ),
        check(
            "metrics",
            "Quantitative Metrics Rigor",
            any(k in lower for k in ("accuracy", "f1", "precision", "recall", "rmse", "latency", "auc")),
            86,
            "Results and Discussion",
            "Standardized metrics make empirical claims falsifiable.",
            "Standard quantitative evaluation metrics identified.",
            "Few standardized quantitative metrics detected.",
            "Report domain-standard metrics (e.g., F1, AUROC, RMSE, latency p95) with units.",
        ),
        check(
            "statistics",
            "Statistical Validity & Variance",
            any(k in lower for k in ("confidence interval", "p-value", "p <", "std", "standard deviation", "variance", "cross-validation", "fold")),
            83,
            "Results / Evaluation",
            "Single-run point estimates conceal run-to-run variance.",
            "Statistical dispersion, cross-validation, or significance markers found.",
            "No confidence intervals, standard deviations, or significance tests found.",
            "Include mean +/- standard deviation across seeds/folds or 95% confidence intervals.",
        ),
        check(
            "reproducibility",
            "Reproducibility & Hyperparameters",
            any(k in lower for k in ("hyperparameter", "seed", "learning rate", "epoch", "hardware", "reproducib", "github")),
            82,
            "Experimental Setup",
            "Reproducibility requires exact hyperparameters, seeds, and environment details.",
            "Hyperparameters, seed, or repository references documented.",
            "Random seeds, hyperparameters, or hardware details omitted.",
            "Document random seeds, optimizer hyperparameters, library versions, and compute specs.",
        ),
        check(
            "limitations",
            "Limitations & Threats to Validity",
            any(k in lower for k in ("limitation", "threat to validity", "bias", "future scope", "future work")),
            84,
            "Discussion / Future Scope",
            "Transparently identifies failure modes and boundary conditions.",
            "Limitations or threats to validity acknowledged.",
            "Missing explicit Threats to Validity or Limitations subsection.",
            "Add a dedicated Limitations subsection detailing failure modes and external validity limits.",
        ),
        check(
            "ethics",
            "Ethics & Academic Integrity Disclosure",
            any(k in lower for k in ("ethic", "privacy", "consent", "bias", "integrity", "disclaimer", "irb")),
            81,
            "Ethics / Discussion",
            "Addresses privacy, dataset consent, and responsible deployment.",
            "Ethical, privacy, or integrity considerations documented.",
            "No explicit ethical or data-governance disclosure detected.",
            "Include an Ethics & Data Governance statement covering consent, bias, and limitations.",
        ),
        check(
            "structure",
            "Academic Structural Completeness",
            words >= 450 and "conclusion" in lower and "references" in lower,
            88,
            "Full Manuscript",
            "Ensures publication-ready progression from Abstract to References.",
            f"Manuscript has {words} words with Conclusion and References.",
            f"Manuscript ({words} words) lacks full Conclusion/References structure.",
            "Ensure complete academic section ordering from Abstract through Conclusion and References.",
        ),
    ]

    overall_score = round(sum(d["score"] for d in dimensions) / len(dimensions), 1)
    weak_items = [d for d in dimensions if d["status"] != "Strong"]
    recommendations = [f"[{d['dimension']} · {d['location']}] {d['recommendation']}" for d in weak_items]

    return {
        "title": title,
        "wordCount": words,
        "overallScore": overall_score,
        "criteriaCount": len(dimensions),
        "dimensions": dimensions,
        "recommendations": recommendations,
    }


async def evaluate_research_quality_with_llm(text: str, title: str = "Manuscript", gemini_api_key: str = "") -> Dict[str, Any]:
    base = evaluate_research_quality(text, title=title)
    api_key = gemini_api_key or os.getenv("GEMINI_API_KEY", "")
    if not api_key or len(text.strip()) < 100:
        return base

    try:
        from google import genai

        client = genai.Client(api_key=api_key)
        prompt = (
            "Provide a concise, grounded peer-review critique of the manuscript excerpt below. "
            "Do NOT invent facts or citations not in the text. Return JSON with keys: "
            "strengths (list[str]), criticalWeaknesses (list[{issue, why, location, improvement}]).\n\n"
            f"Title: {title}\nExcerpt:\n{text[:5000]}"
        )
        resp = client.models.generate_content(model="gemini-4-hydrogen", contents=prompt)
        m = re.search(r"\{[\s\S]*\}", (resp.text or "").strip())
        if m:
            base["llmCritique"] = json.loads(m.group(0))
            base["critiqueProvider"] = "gemini-4-hydrogen"
    except Exception:
        pass
    return base


def build_integrity_audit(
    document_title: str,
    similarity_result: Optional[Dict[str, Any]] = None,
    citation_result: Optional[Dict[str, Any]] = None,
    quality_result: Optional[Dict[str, Any]] = None,
    code_crosscheck: Optional[Dict[str, Any]] = None,
    writing_result: Optional[Dict[str, Any]] = None,
    refinement_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """6-pillar conservative academic integrity audit citing exact evidence per finding."""
    findings: List[Dict[str, str]] = []

    if similarity_result is not None:
        sim_pct = float(similarity_result.get("overallSimilarityPercent", 0.0))
        uncited = int(similarity_result.get("uncitedFlagCount", 0))
        status = "Verified" if sim_pct < 15.0 and uncited == 0 else ("Unverified" if sim_pct >= 30.0 or uncited >= 4 else "Needs review")
        findings.append({
            "area": "1. Textual Similarity & Attribution",
            "classification": status,
            "summary": f"{sim_pct}% composite overlap across workspace/open-access/arXiv corpus; {uncited} uncited passages flagged.",
            "evidenceDetail": similarity_result.get("corpusCoverage", {}).get("limitationNotice", "Workspace and open-access corpus scan."),
            "remediation": "Cite primary sources or rewrite uncited overlapping sentences." if status != "Verified" else "No remediation required.",
        })
    else:
        findings.append({
            "area": "1. Textual Similarity & Attribution",
            "classification": "Not evaluated",
            "summary": "Similarity scan has not been executed for this manuscript.",
            "evidenceDetail": "No persisted similarity report linked.",
            "remediation": "Run Similarity Checker before final submission.",
        })

    if citation_result is not None:
        summary = citation_result.get("summary", citation_result)
        unverified = int(summary.get("unverifiedCount", 0))
        missing = len(summary.get("reconciliation", {}).get("missingFromBibliography", []))
        dups = len(summary.get("reconciliation", {}).get("duplicateReferences", []))
        status = "Verified" if unverified == 0 and missing == 0 and dups == 0 else ("Unverified" if unverified > 2 else "Needs review")
        findings.append({
            "area": "2. Citation & Registry Verification",
            "classification": status,
            "summary": f"{unverified} unverified references; {missing} orphaned citations; {dups} duplicate bibliography entries.",
            "evidenceDetail": "Cross-checked via Crossref, OpenAlex, Semantic Scholar, and arXiv registries.",
            "remediation": "Resolve unverified DOIs, remove duplicate entries, and reconcile bracket indices." if status != "Verified" else "All citations verified.",
        })
    else:
        findings.append({
            "area": "2. Citation & Registry Verification",
            "classification": "Not evaluated",
            "summary": "Reference verification has not been executed yet.",
            "evidenceDetail": "No citation check log recorded.",
            "remediation": "Run Citation Intelligence verification.",
        })

    if code_crosscheck is not None:
        unv = int(code_crosscheck.get("unsupportedClaims", code_crosscheck.get("unverifiedClaims", 0)))
        align = float(code_crosscheck.get("alignmentPercent", 0.0))
        status = "Verified" if unv == 0 and align >= 70.0 else ("Unverified" if align < 40.0 or unv > 0 else "Needs review")
        findings.append({
            "area": "3. Code-to-Paper Alignment",
            "classification": status,
            "summary": f"{align}% technical claim alignment ({unv} unsupported claims detected).",
            "evidenceDetail": "Static AST and dependency artifact inspection against repository files.",
            "remediation": "Align manuscript claims and metric tables strictly with repository code and evaluation logs." if status != "Verified" else "Implementation claims confirmed.",
        })
    else:
        findings.append({
            "area": "3. Code-to-Paper Alignment",
            "classification": "Not evaluated",
            "summary": "No repository linked for implementation verification.",
            "evidenceDetail": "Project cross-check not performed.",
            "remediation": "Link a ZIP archive or GitHub repository in Project Analyzer.",
        })

    if quality_result is not None:
        qscore = float(quality_result.get("overallScore", 0.0))
        status = "Verified" if qscore >= 78.0 else ("Unverified" if qscore < 55.0 else "Needs review")
        findings.append({
            "area": "4. Methodology & Reproducibility Rigor",
            "classification": status,
            "summary": f"13-dimension scientific rubric scored {qscore}/100.",
            "evidenceDetail": "Evaluated Abstract, Problem Gap, Baselines, Statistics, Reproducibility, Limitations, and Ethics.",
            "remediation": "Address highlighted Needs improvement dimensions before peer review." if status != "Verified" else "Meets baseline methodology rigor.",
        })
    else:
        findings.append({
            "area": "4. Methodology & Reproducibility Rigor",
            "classification": "Not evaluated",
            "summary": "Quality evaluation rubric not run yet.",
            "evidenceDetail": "No quality evaluation persisted.",
            "remediation": "Run Quality Evaluator.",
        })

    if writing_result is not None:
        obs = writing_result.get("observations", [])
        flagged = sum(1 for o in obs if o.get("signal") not in {"Balanced", "Strong"})
        status = "Verified" if flagged == 0 else "Needs review"
        findings.append({
            "area": "5. Stylistic Consistency & Telemetry",
            "classification": status,
            "summary": f"Stylometric telemetry logged {flagged} structural cadence/repetition notice(s) (descriptive only).",
            "evidenceDetail": "Fano burstiness, MATTR-50, transition density, and n-gram repetition telemetry.",
            "remediation": "Review flagged monotonous transitions or low sentence variance." if flagged > 0 else "Balanced academic cadence.",
        })
    else:
        findings.append({
            "area": "5. Stylistic Consistency & Telemetry",
            "classification": "Not evaluated",
            "summary": "Stylometric telemetry not computed yet.",
            "evidenceDetail": "No writing analysis record linked.",
            "remediation": "Run AI-Writing Pattern Analyzer.",
        })

    if refinement_result is not None:
        meaning_ok = bool(refinement_result.get("meaningRetained", True))
        cites_ok = bool(refinement_result.get("allCitationsPreserved", True))
        eq_ok = bool(refinement_result.get("allEquationsPreserved", True))
        status = "Verified" if (meaning_ok and cites_ok and eq_ok) else "Needs review"
        findings.append({
            "area": "6. Refinement Meaning Preservation",
            "classification": status,
            "summary": f"Citations preserved: {cites_ok}; Equations preserved: {eq_ok}; Meaning retained: {meaning_ok}.",
            "evidenceDetail": "Post-refinement numeric, citation, equation, and semantic drift verification.",
            "remediation": "Inspect diff in Paper Refinement before approving draft." if status != "Verified" else "No semantic or numeric drift detected.",
        })
    else:
        findings.append({
            "area": "6. Refinement Meaning Preservation",
            "classification": "Verified",
            "summary": "No automated refinement job applied; original author prose intact.",
            "evidenceDetail": "Direct manuscript draft.",
            "remediation": "Run Paper Refinement if editorial polishing is desired.",
        })

    statuses = [f["classification"] for f in findings]
    if "Unverified" in statuses:
        overall = "Unverified"
    elif "Needs review" in statuses or "Not evaluated" in statuses:
        overall = "Needs review"
    else:
        overall = "Verified"

    counts = {
        "verified": statuses.count("Verified"),
        "needsReview": statuses.count("Needs review"),
        "unverified": statuses.count("Unverified"),
        "notEvaluated": statuses.count("Not evaluated"),
    }

    return {
        "documentTitle": document_title,
        "overallStatus": overall,
        "findings": findings,
        "counts": counts,
        "summary": counts,
        "auditSummary": (
            f"Conservative 6-pillar audit verdict: {overall} "
            f"({counts['verified']} Verified, {counts['needsReview']} Needs review, "
            f"{counts['unverified']} Unverified, {counts['notEvaluated']} Not evaluated)."
        ),
    }


def export_audit_markdown(audit: Dict[str, Any]) -> str:
    lines = [
        f"# ResearchForge AI Integrity Audit — {audit.get('documentTitle', 'Manuscript')}",
        "",
        f"**Overall Verdict:** {audit.get('overallStatus', 'Needs review')}",
        f"**Summary:** {audit.get('auditSummary', '')}",
        "",
        "## Pillar Breakdown",
        "",
    ]
    for f in audit.get("findings", []):
        lines.extend([
            f"### {f.get('area', 'Pillar')} — [{f.get('classification', 'Not evaluated')}]",
            f"- **Finding:** {f.get('summary', '')}",
            f"- **Evidence:** {f.get('evidenceDetail', '')}",
            f"- **Remediation:** {f.get('remediation', '')}",
            "",
        ])
    return "\n".join(lines)
