import re
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional
from .similarity_service import content_tokens, jaccard

DOI_REGEX = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)\b")
ARXIV_REGEX = re.compile(r"\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)
YEAR_REGEX = re.compile(r"\b(19\d{2}|20\d{2})\b")

NEGATION_WORDS = {"not", "no", "never", "neither", "nor", "failed", "fails", "contradict", "decrease", "decreases", "reduced", "lower", "worse"}
POSITIVE_WORDS = {"improve", "improves", "improved", "increase", "increases", "higher", "outperform", "outperforms", "verified", "supports"}


def parse_reference_lines(raw_refs: str) -> List[str]:
    lines = [line.strip() for line in re.split(r"\r?\n", raw_refs) if len(line.strip()) > 10]
    merged: List[str] = []
    for line in lines:
        if re.match(r"^(?:\[\d+\]|\d+[.)])\s+", line) or not merged:
            merged.append(line)
        else:
            merged[-1] = f"{merged[-1]} {line}"
    return merged


def extract_reference_identifiers(ref_line: str) -> Dict[str, Optional[str]]:
    doi_m = DOI_REGEX.search(ref_line)
    arxiv_m = ARXIV_REGEX.search(ref_line)
    year_m = YEAR_REGEX.search(ref_line)
    cleaned = re.sub(r"^(?:\[\d+\]|\d+[.)])\s*", "", ref_line).strip()
    quoted_m = re.search(r"[\"“]([^\"”]{8,220})[\"”]", cleaned)
    guessed_title = quoted_m.group(1) if quoted_m else cleaned
    return {
        "raw": ref_line,
        "doi": doi_m.group(1).rstrip(".,;)") if doi_m else None,
        "arxivId": arxiv_m.group(1) if arxiv_m else None,
        "year": year_m.group(1) if year_m else None,
        "guessedTitle": guessed_title[:220],
    }


def extract_in_text_citations(text: str) -> Dict[str, Any]:
    numeric = set(int(x) for x in re.findall(r"\[(\d+)\]", text))
    for rng in re.finditer(r"\[(\d+)\s*[-–]\s*(\d+)\]", text):
        start, end = int(rng.group(1)), int(rng.group(2))
        if 0 < end - start <= 20:
            for k in range(start, end + 1):
                numeric.add(k)
    author_year = re.findall(r"\(([A-Z][A-Za-z-]+(?:\s+et\s+al\.?)?,\s*(?:19|20)\d{2}[a-z]?)\)", text)
    return {"numericIndices": sorted(numeric), "authorYear": sorted(set(author_year))}


def title_similarity(a: str, b: str) -> float:
    s1 = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", a.lower())).strip()
    s2 = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", b.lower())).strip()
    if not s1 or not s2:
        return 0.0
    return round(SequenceMatcher(None, s1, s2).ratio(), 3)


def format_ieee(authors: List[str], title: str, venue: str, year: str, doi: Optional[str] = None) -> str:
    author_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "") if authors else "Unknown Author"
    doi_part = f", doi: {doi}." if doi else "."
    return f'{author_str}, "{title}," {venue}, {year}{doi_part}'


def format_apa(authors: List[str], title: str, venue: str, year: str, doi: Optional[str] = None) -> str:
    author_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "") if authors else "Unknown Author"
    doi_part = f" https://doi.org/{doi}" if doi else ""
    return f"{author_str} ({year}). {title}. {venue}.{doi_part}"


def detect_duplicate_references(references: List[str]) -> List[Dict[str, Any]]:
    seen_titles: List[Tuple[int, str]] = []
    duplicates: List[Dict[str, Any]] = []
    for idx, ref in enumerate(references):
        ident = extract_reference_identifiers(ref)
        title = ident["guessedTitle"] or ref
        for prev_idx, prev_title in seen_titles:
            if title_similarity(title, prev_title) >= 0.85:
                duplicates.append({"indexA": prev_idx + 1, "indexB": idx + 1, "excerpt": title[:100]})
                break
        seen_titles.append((idx, title))
    return duplicates


def evaluate_claim_support(claim_text: str, source_text: str, source_retrieved: bool = True) -> Dict[str, Any]:
    if not source_text or not source_text.strip():
        return {
            "overlapScore": 0.0,
            "sharedTerms": [],
            "claimStatus": "Evidence insufficient" if source_retrieved else "Verification unavailable",
            "verdict": "Evidence insufficient",
        }

    q_tokens = set(content_tokens(claim_text))
    s_tokens = set(content_tokens(source_text))
    overlap = jaccard(q_tokens, s_tokens)

    q_neg = bool(q_tokens & NEGATION_WORDS)
    s_neg = bool(s_tokens & NEGATION_WORDS)
    q_pos = bool(q_tokens & POSITIVE_WORDS)
    s_pos = bool(s_tokens & POSITIVE_WORDS)

    contradiction = overlap >= 0.14 and ((q_pos and s_neg and not q_neg) or (q_neg and s_pos and not s_neg))
    if contradiction:
        status = "Claim contradicted"
    elif overlap >= 0.22:
        status = "Claim supported"
    elif source_retrieved:
        status = "Evidence insufficient"
    else:
        status = "Verification unavailable"

    return {
        "overlapScore": round(overlap, 3),
        "sharedTerms": sorted(q_tokens & s_tokens)[:12],
        "claimStatus": status,
        "verdict": status,
    }


def reconcile_citations_and_references(full_text: str, references: List[str]) -> Dict[str, Any]:
    in_text = extract_in_text_citations(full_text)
    ref_count = len(references)
    missing_from_bibliography = [idx for idx in in_text["numericIndices"] if idx < 1 or idx > ref_count]
    unused_references = [i for i in range(1, ref_count + 1) if i not in in_text["numericIndices"]]
    duplicates = detect_duplicate_references(references)
    return {
        "inTextCitations": in_text,
        "referenceCount": ref_count,
        "missingFromBibliography": missing_from_bibliography,
        "unusedReferences": unused_references,
        "duplicateReferences": duplicates,
    }


async def lookup_citation_registries(
    ref_line: str,
    mailto: str = "researchforge@example.edu",
    claim_context: str = "",
) -> Dict[str, Any]:
    import httpx

    ident = extract_reference_identifiers(ref_line)
    headers = {"User-Agent": f"ResearchForgeAI/1.1 (mailto:{mailto})"}
    matched: Optional[Dict[str, Any]] = None
    registry = "None"
    network_errors = 0

    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        if ident["doi"]:
            try:
                r = await client.get(f"https://api.crossref.org/works/{ident['doi']}")
                if r.status_code == 200:
                    msg = r.json().get("message", {})
                    authors = [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in msg.get("author", [])]
                    title = (msg.get("title") or [""])[0]
                    year = str(((msg.get("issued") or {}).get("date-parts") or [[""]])[0][0])
                    venue = (msg.get("container-title") or ["Academic Venue"])[0]
                    abstract = re.sub(r"<[^>]+>", " ", msg.get("abstract") or "").strip()
                    matched = {
                        "title": title, "authors": authors, "year": year, "venue": venue,
                        "doi": ident["doi"], "url": f"https://doi.org/{ident['doi']}", "abstract": abstract,
                    }
                    registry = "Crossref"
            except Exception:
                network_errors += 1

        if matched is None and ident["arxivId"]:
            try:
                r = await client.get(f"https://export.arxiv.org/api/query?id_list={ident['arxivId']}")
                if r.status_code == 200:
                    root = ET.fromstring(r.text)
                    ns = {"a": "http://www.w3.org/2005/Atom"}
                    entry = root.find("a:entry", ns)
                    if entry is not None:
                        title = re.sub(r"\s+", " ", (entry.findtext("a:title", "", ns) or "").strip())
                        authors = [a.findtext("a:name", "", ns) or "" for a in entry.findall("a:author", ns)]
                        published = (entry.findtext("a:published", "", ns) or "")[:4]
                        summary = re.sub(r"\s+", " ", (entry.findtext("a:summary", "", ns) or "").strip())
                        matched = {
                            "title": title, "authors": authors, "year": published, "venue": "arXiv",
                            "doi": None, "url": f"https://arxiv.org/abs/{ident['arxivId']}", "abstract": summary,
                        }
                        registry = "arXiv"
            except Exception:
                network_errors += 1

        if matched is None and ident["guessedTitle"]:
            try:
                r = await client.get("https://api.openalex.org/works", params={"search": ident["guessedTitle"], "per-page": 1})
                if r.status_code == 200:
                    results = r.json().get("results", [])
                    if results:
                        top = results[0]
                        sim = title_similarity(ident["guessedTitle"], top.get("title") or "")
                        if sim >= 0.48:
                            authors = [au.get("author", {}).get("display_name", "") for au in top.get("authorships", [])]
                            venue = ((top.get("primary_location") or {}).get("source") or {}).get("display_name", "OpenAlex")
                            doi = (top.get("doi") or "").replace("https://doi.org/", "") or None
                            matched = {
                                "title": top.get("title", ""), "authors": authors,
                                "year": str(top.get("publication_year", "")), "venue": venue,
                                "doi": doi, "url": top.get("doi") or top.get("id") or "", "abstract": "",
                            }
                            registry = "OpenAlex"
            except Exception:
                network_errors += 1

        if matched is None and ident["guessedTitle"]:
            try:
                r = await client.get(
                    "https://api.semanticscholar.org/graph/v1/paper/search",
                    params={"query": ident["guessedTitle"], "limit": 1, "fields": "title,authors,year,venue,externalIds,abstract,url"},
                )
                if r.status_code == 200:
                    data = r.json().get("data", [])
                    if data:
                        top = data[0]
                        sim = title_similarity(ident["guessedTitle"], top.get("title") or "")
                        if sim >= 0.48:
                            authors = [a.get("name", "") for a in top.get("authors", [])]
                            doi = (top.get("externalIds") or {}).get("DOI")
                            matched = {
                                "title": top.get("title", ""), "authors": authors,
                                "year": str(top.get("year", "")), "venue": top.get("venue") or "Semantic Scholar",
                                "doi": doi, "url": top.get("url") or "", "abstract": top.get("abstract") or "",
                            }
                            registry = "Semantic Scholar"
            except Exception:
                network_errors += 1

    if matched:
        year_ok = not ident["year"] or ident["year"] == matched["year"]
        has_abstract = bool((matched.get("abstract") or "").strip())
        claim_eval = evaluate_claim_support(claim_context, matched.get("abstract") or "", source_retrieved=has_abstract) if claim_context else None
        if claim_eval:
            detailed_status = claim_eval["claimStatus"]
        elif has_abstract:
            detailed_status = "Source retrieved"
        else:
            detailed_status = "Bibliographic metadata verified"

        ui_status = "Verified" if (year_ok and detailed_status != "Claim contradicted") else "Needs review"
        return {
            "raw": ref_line,
            "status": ui_status,
            "detailedStatus": detailed_status,
            "registry": registry,
            "matchedTitle": matched["title"],
            "authors": matched["authors"],
            "year": matched["year"],
            "venue": matched["venue"],
            "doi": matched["doi"],
            "url": matched["url"],
            "sourceRetrieved": has_abstract,
            "yearMatch": year_ok,
            "claimEvaluation": claim_eval,
            "ieeeFormatted": format_ieee(matched["authors"], matched["title"], matched["venue"], matched["year"], matched["doi"]),
            "apaFormatted": format_apa(matched["authors"], matched["title"], matched["venue"], matched["year"], matched["doi"]),
        }

    unavailable_reason = "Verification unavailable" if network_errors > 0 else "Verification unavailable"
    return {
        "raw": ref_line,
        "status": "Unverified",
        "detailedStatus": unavailable_reason,
        "registry": "None",
        "matchedTitle": None,
        "authors": [],
        "year": ident["year"],
        "venue": None,
        "doi": ident["doi"],
        "url": "",
        "sourceRetrieved": False,
        "yearMatch": False,
        "claimEvaluation": None,
        "ieeeFormatted": ref_line,
        "apaFormatted": ref_line,
    }
