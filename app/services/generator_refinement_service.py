import json
import os
import re
from typing import Any, Dict, List, Optional

from .similarity_service import content_tokens, jaccard

IEEE_SECTIONS = [
    ("abstract", "Abstract"),
    ("keywords", "Keywords"),
    ("introduction", "I. Introduction"),
    ("literature_review", "II. Literature Review"),
    ("problem_statement", "III. Problem Statement"),
    ("proposed_methodology", "IV. Proposed Methodology"),
    ("system_architecture", "V. System Architecture"),
    ("experimental_setup", "VI. Experimental Setup"),
    ("results_discussion", "VII. Results and Discussion"),
    ("conclusion", "VIII. Conclusion"),
    ("future_scope", "IX. Future Scope"),
    ("references", "References"),
]

APA_SECTIONS = [
    ("abstract", "Abstract"),
    ("keywords", "Keywords"),
    ("introduction", "Introduction"),
    ("literature_review", "Literature Review"),
    ("problem_statement", "Problem Statement"),
    ("proposed_methodology", "Method"),
    ("system_architecture", "System Architecture"),
    ("experimental_setup", "Materials and Procedure"),
    ("results_discussion", "Results and Discussion"),
    ("conclusion", "Conclusion"),
    ("future_scope", "Future Directions"),
    ("references", "References"),
]

INFORMAL_REPLACEMENTS = [
    (re.compile(r"\ba lot of\b", re.IGNORECASE), "considerable"),
    (re.compile(r"\blots of\b", re.IGNORECASE), "numerous"),
    (re.compile(r"\bget better\b", re.IGNORECASE), "improve"),
    (re.compile(r"\bgets better\b", re.IGNORECASE), "improves"),
    (re.compile(r"\bshowed that\b", re.IGNORECASE), "demonstrated that"),
    (re.compile(r"\bfound out\b", re.IGNORECASE), "observed"),
    (re.compile(r"\bbig impact\b", re.IGNORECASE), "substantial effect"),
    (re.compile(r"\bdon't\b", re.IGNORECASE), "do not"),
    (re.compile(r"\bcan't\b", re.IGNORECASE), "cannot"),
    (re.compile(r"\bwon't\b", re.IGNORECASE), "will not"),
    (re.compile(r"\bit's\b", re.IGNORECASE), "it is"),
    (re.compile(r"\breally good\b", re.IGNORECASE), "effective"),
    (re.compile(r"\bvery important\b", re.IGNORECASE), "critical"),
]


async def search_academic_literature(query: str, max_results: int = 4) -> List[Dict[str, str]]:
    """Retrieve real peer-reviewed metadata from OpenAlex to ground Literature Review without inventing citations."""
    import httpx

    cleaned = " ".join(query.split()[:10]).strip()
    if not cleaned:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": "ResearchForgeAI/1.1"}) as client:
            resp = await client.get("https://api.openalex.org/works", params={"search": cleaned, "per-page": max_results})
            if resp.status_code != 200:
                return []
            items: List[Dict[str, str]] = []
            for work in resp.json().get("results", []):
                title = (work.get("title") or "").strip()
                if not title:
                    continue
                authors = [a.get("author", {}).get("display_name", "") for a in work.get("authorships", [])[:3]]
                year = str(work.get("publication_year") or "")
                venue = ((work.get("primary_location") or {}).get("source") or {}).get("display_name") or "Academic Venue"
                doi = (work.get("doi") or "").replace("https://doi.org/", "")
                items.append({
                    "title": title,
                    "authors": ", ".join(a for a in authors if a) or "Unknown Author",
                    "year": year,
                    "venue": venue,
                    "doi": doi,
                })
            return items
    except Exception:
        return []


def _local_generate_draft(
    title: str,
    synopsis: str,
    dataset_notes: str,
    experimental_results: str,
    literature_notes: str,
    project_analysis: Optional[Dict[str, Any]] = None,
    citation_style: str = "IEEE",
    live_literature: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    missing_inputs: List[str] = []
    if not dataset_notes.strip() and not (project_analysis or {}).get("datasetsDetected"):
        missing_inputs.append("Dataset source, sample count, and train/validation split details")
    if not experimental_results.strip() and not (project_analysis or {}).get("evaluationEvidence"):
        missing_inputs.append("Measured evaluation metrics and baseline comparison values")
    if not literature_notes.strip() and not live_literature:
        missing_inputs.append("Peer-reviewed prior literature references with DOIs")

    frameworks = ", ".join((project_analysis or {}).get("frameworks", [])) or "[INPUT NEEDED: specify software frameworks]"
    models = ", ".join((project_analysis or {}).get("modelsDetected", [])) or "[INPUT NEEDED: specify model/algorithm names]"
    datasets = dataset_notes.strip() or ", ".join((project_analysis or {}).get("datasetsDetected", [])) or "[INPUT NEEDED: provide verified dataset details]"
    eval_ev = (project_analysis or {}).get("evaluationEvidence") or (project_analysis or {}).get("metricsDetected") or []
    results_txt = experimental_results.strip() or (
        json.dumps(eval_ev[:6]) if eval_ev else "[INPUT NEEDED: provide measured experimental outputs — do not fabricate metrics]"
    )

    refs_lines: List[str] = []
    if live_literature:
        for idx, ref in enumerate(live_literature, 1):
            doi_suffix = f", doi: {ref['doi']}." if ref.get("doi") else "."
            refs_lines.append(f"[{idx}] {ref['authors']}, \"{ref['title']},\" {ref['venue']}, {ref['year']}{doi_suffix}")
    lit_txt = literature_notes.strip() or (
        "Relevant retrieved literature includes " + "; ".join(f"{r['authors']} ({r['year']}) [{i+1}]" for i, r in enumerate(live_literature or []))
        if live_literature
        else "[INPUT NEEDED: summarize peer-reviewed baselines and cite verified DOIs]."
    )

    template = APA_SECTIONS if citation_style.upper() == "APA" else IEEE_SECTIONS
    content_map = {
        "abstract": f"This manuscript investigates {title}. {synopsis or '[INPUT NEEDED: concise 2-sentence problem and contribution summary].'} Implementation leverages {frameworks} with core components {models}.",
        "keywords": f"{title.lower()}, reproducible research, {frameworks.lower()}",
        "introduction": synopsis or "[INPUT NEEDED: provide research motivation, context, and primary contributions].",
        "literature_review": lit_txt,
        "problem_statement": f"Given {datasets}, existing workflows require transparent traceability between source implementation and empirical claims.",
        "proposed_methodology": f"The methodology integrates {models} implemented across {frameworks}.",
        "system_architecture": f"Detected stack: {frameworks}. Endpoints: {', '.join(str(e) for e in (project_analysis or {}).get('endpoints', [])[:6]) or 'Modular pipeline'}.",
        "experimental_setup": f"Datasets: {datasets}. Test files: {', '.join((project_analysis or {}).get('testFiles', [])[:5]) or 'Pending benchmark verification'}.",
        "results_discussion": results_txt,
        "conclusion": f"This study presented {title} grounded strictly in observed project artifacts without fabricated benchmarks.",
        "future_scope": "Future work includes broader cross-domain ablation evaluation and independent reproducibility audits.",
        "references": "\n".join(refs_lines) if refs_lines else "[1] [INPUT NEEDED: Add verified bibliography entries].",
    }

    sections = [{"id": sid, "heading": heading, "content": content_map[sid], "approved": False} for sid, heading in template]
    return {
        "title": title,
        "format": citation_style.upper(),
        "engineUsed": "local-structural",
        "missingInputs": missing_inputs,
        "sections": sections,
    }


def _local_refine_section(text: str, mode: str) -> str:
    refined = text
    for pattern, repl in INFORMAL_REPLACEMENTS:
        refined = pattern.sub(repl, refined)
    refined = re.sub(r"\s{2,}", " ", refined).strip()
    if mode == "Concise Academic Writing":
        refined = re.sub(r"\b(in order to)\b", "to", refined, flags=re.IGNORECASE)
        refined = re.sub(r"\b(due to the fact that)\b", "because", refined, flags=re.IGNORECASE)
        refined = re.sub(r"\bvery\s+", "", refined, flags=re.IGNORECASE)
    elif mode == "Formal Research Style":
        refined = re.sub(r"\bwe found\b", "empirical observation indicates", refined, flags=re.IGNORECASE)
    return refined


def validate_refinement_preservation(
    original_text: str,
    refined_text: str,
    preserve_terms: str = "",
) -> Dict[str, Any]:
    orig_cites = set(re.findall(r"\[\d+(?:\s*[-,]\s*\d+)*\]|\([A-Z][A-Za-z-]+.*?(?:19|20)\d{2}\)", original_text))
    ref_cites = set(re.findall(r"\[\d+(?:\s*[-,]\s*\d+)*\]|\([A-Z][A-Za-z-]+.*?(?:19|20)\d{2}\)", refined_text))
    missing_citations = sorted(orig_cites - ref_cites)

    orig_math = set(re.findall(r"\$[^$]+\$", original_text))
    ref_math = set(re.findall(r"\$[^$]+\$", refined_text))
    missing_equations = sorted(orig_math - ref_math)

    orig_nums = set(re.findall(r"\b\d+(?:\.\d+)?(?:%|(?=\b))", original_text))
    ref_nums = set(re.findall(r"\b\d+(?:\.\d+)?(?:%|(?=\b))", refined_text))
    missing_numbers = sorted(orig_nums - ref_nums)
    added_numbers = sorted(ref_nums - orig_nums)

    mandatory_terms = [t.strip() for t in preserve_terms.split(",") if t.strip()]
    missing_terms = [t for t in mandatory_terms if t.lower() not in refined_text.lower()]

    sem_sim = round(jaccard(set(content_tokens(original_text)), set(content_tokens(refined_text))), 3) if original_text.strip() else 1.0
    meaning_retained = (
        len(missing_citations) == 0
        and len(missing_equations) == 0
        and len(missing_numbers) == 0
        and len(missing_terms) == 0
        and sem_sim >= 0.45
    )

    return {
        "citationsPreserved": len(missing_citations) == 0,
        "missingCitations": missing_citations,
        "equationsPreserved": len(missing_equations) == 0,
        "missingEquations": missing_equations,
        "numbersPreserved": len(missing_numbers) == 0,
        "missingNumbers": missing_numbers[:10],
        "addedNumbersFlagged": added_numbers[:10],
        "missingTerms": missing_terms,
        "semanticRetentionScore": sem_sim,
        "meaningRetained": meaning_retained,
    }


async def _call_ollama(prompt: str, base_url: str, model: str) -> Optional[str]:
    import httpx

    if not base_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            r = await client.post(
                f"{base_url.rstrip('/')}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
            )
            if r.status_code == 200:
                return (r.json().get("response") or "").strip()
    except Exception:
        return None
    return None


async def generate_grounded_ieee_paper(
    title: str,
    synopsis: str,
    dataset_notes: str,
    experimental_results: str,
    literature_notes: str,
    project_analysis: Optional[Dict[str, Any]] = None,
    engine_mode: str = "gemini",
    gemini_api_key: str = "",
    citation_style: str = "IEEE",
    ollama_base_url: str = "",
    ollama_model: str = "llama3.1",
) -> Dict[str, Any]:
    live_literature = await search_academic_literature(f"{title} {synopsis}", max_results=4)
    api_key = gemini_api_key or os.getenv("GEMINI_API_KEY", "")

    prompt = (
        f"Generate a 12-section {citation_style.upper()} research paper JSON object grounded strictly in the provided evidence. "
        "Do NOT fabricate metrics, datasets, or references. Where evidence is missing, write [INPUT NEEDED: ...].\n"
        f"Title: {title}\nSynopsis: {synopsis}\nDataset Notes: {dataset_notes}\n"
        f"Experimental Results: {experimental_results}\nLiterature Notes: {literature_notes}\n"
        f"Retrieved OpenAlex Literature (use only these real references if relevant): {json.dumps(live_literature)}\n"
        f"Project Analysis: {json.dumps(project_analysis or {})[:4000]}\n"
        "Return valid JSON with keys: missingInputs (list[str]) and sections (list of {id, heading, content})."
    )

    if engine_mode == "gemini" and api_key:
        try:
            from google import genai

            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(model="gemini-4-hydrogen", contents=prompt)
            json_match = re.search(r"\{[\s\S]*\}", (resp.text or "").strip())
            if json_match:
                parsed = json.loads(json_match.group(0))
                if isinstance(parsed.get("sections"), list) and parsed["sections"]:
                    return {
                        "title": title,
                        "format": citation_style.upper(),
                        "engineUsed": "gemini-4-hydrogen",
                        "missingInputs": parsed.get("missingInputs", []),
                        "sections": [{**s, "approved": False} for s in parsed["sections"]],
                    }
        except Exception:
            pass

    if ollama_base_url and engine_mode != "local":
        ol_text = await _call_ollama(prompt, ollama_base_url, ollama_model)
        if ol_text:
            json_match = re.search(r"\{[\s\S]*\}", ol_text)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    if isinstance(parsed.get("sections"), list) and parsed["sections"]:
                        return {
                            "title": title,
                            "format": citation_style.upper(),
                            "engineUsed": f"ollama:{ollama_model}",
                            "missingInputs": parsed.get("missingInputs", []),
                            "sections": [{**s, "approved": False} for s in parsed["sections"]],
                        }
                except Exception:
                    pass

    return _local_generate_draft(
        title,
        synopsis,
        dataset_notes,
        experimental_results,
        literature_notes,
        project_analysis,
        citation_style=citation_style,
        live_literature=live_literature,
    )


async def refine_sections_academic(
    sections: List[Dict[str, str]],
    mode: str,
    preserve_terms: str = "",
    engine_mode: str = "gemini",
    gemini_api_key: str = "",
    ollama_base_url: str = "",
    ollama_model: str = "llama3.1",
    paragraph_index: Optional[int] = None,
) -> List[Dict[str, Any]]:
    api_key = gemini_api_key or os.getenv("GEMINI_API_KEY", "")
    results: List[Dict[str, Any]] = []

    for sec in sections:
        orig = sec.get("content", "")
        target_text = orig
        paragraphs = re.split(r"\n\s*\n", orig) if paragraph_index is not None else None
        if paragraphs is not None and 0 <= paragraph_index < len(paragraphs):
            target_text = paragraphs[paragraph_index]

        refined_part = _local_refine_section(target_text, mode)
        engine_used = "local-structural"

        prompt = (
            f"Refine the following academic text using mode '{mode}'. "
            "Preserve all citations ([1], (Author, Year)), LaTeX equations ($...$), exact numbers/units, and technical claims. "
            f"Mandatory preserved terms: {preserve_terms or 'none specified'}.\n\n"
            f"Text ({sec.get('heading', 'Section')}):\n{target_text}\n\nReturn ONLY the refined text."
        )

        if engine_mode == "gemini" and api_key and target_text.strip():
            try:
                from google import genai

                client = genai.Client(api_key=api_key)
                resp = client.models.generate_content(model="gemini-4-hydrogen", contents=prompt)
                candidate = (resp.text or "").strip()
                if candidate:
                    refined_part = candidate
                    engine_used = "gemini-4-hydrogen"
            except Exception:
                pass
        elif ollama_base_url and engine_mode != "local" and target_text.strip():
            candidate = await _call_ollama(prompt, ollama_base_url, ollama_model)
            if candidate:
                refined_part = candidate
                engine_used = f"ollama:{ollama_model}"

        if paragraphs is not None and 0 <= paragraph_index < len(paragraphs):
            paragraphs[paragraph_index] = refined_part
            final_refined = "\n\n".join(paragraphs)
        else:
            final_refined = refined_part

        preservation = validate_refinement_preservation(orig, final_refined, preserve_terms=preserve_terms)
        results.append({
            "id": sec.get("id", "sec"),
            "heading": sec.get("heading", "Section"),
            "originalContent": orig,
            "refinedContent": final_refined,
            "engineUsed": engine_used,
            "preservation": preservation,
        })

    return results
