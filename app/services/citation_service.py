import asyncio
import re
import time
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from ..core.security import validate_outbound_https_url
from .similarity_service import content_tokens, jaccard

DOI_REGEX = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)\b")
ARXIV_REGEX = re.compile(r"\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)
YEAR_REGEX = re.compile(r"\b(19\d{2}|20\d{2})\b")

NEGATION_WORDS = {"not", "no", "never", "neither", "nor", "failed", "fails", "contradict", "decrease", "decreases", "reduced", "lower", "worse"}
POSITIVE_WORDS = {"improve", "improves", "improved", "increase", "increases", "higher", "outperform", "outperforms", "verified", "supports"}

ALLOWED_SCHOLARLY_HOSTS = {
    "api.crossref.org",
    "export.arxiv.org",
    "api.openalex.org",
    "api.semanticscholar.org",
}

_SCHOLARLY_CACHE: Dict[str, Tuple[float, Optional[Dict[str, Any]], str]] = {}
_CACHE_TTL_SECONDS = 3600


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
        msg = (
            "Source text or abstract was unavailable to verify this claim."
            if not source_retrieved
            else "Retrieved source metadata lacks sufficient text to evaluate claim alignment."
        )
        return {
            "overlapScore": 0.0,
            "sharedTerms": [],
            "claimStatus": "Evidence insufficient" if source_retrieved else "Verification unavailable",
            "verdict": "Evidence insufficient",
            "explanation": msg,
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
        explanation = "Polarity conflict detected between the manuscript claim and retrieved source text on shared concepts."
    elif overlap >= 0.30:
        status = "Claim supported"
        explanation = "Substantial conceptual alignment between the claim and source text without polarity contradiction."
    elif overlap >= 0.16:
        status = "Partially supported"
        explanation = "Partial topical overlap detected; review full-text methodology and results to confirm claim details."
    elif source_retrieved:
        status = "Evidence insufficient"
        explanation = "Low lexical overlap; retrieved source abstract or title does not confirm this claim."
    else:
        status = "Verification unavailable"
        explanation = "External source abstract could not be retrieved for automated claim verification."

    return {
        "overlapScore": round(overlap, 3),
        "sharedTerms": sorted(q_tokens & s_tokens)[:12],
        "claimStatus": status,
        "verdict": status,
        "explanation": explanation,
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


async def _fetch_with_backoff(client, url: str, params: dict | None = None, attempts: int = 2):
    safe_url = validate_outbound_https_url(url, ALLOWED_SCHOLARLY_HOSTS)
    delay = 0.35
    for attempt in range(attempts):
        resp = await client.get(safe_url, params=params)
        if resp.status_code in {429, 502, 503, 504} and attempt < attempts - 1:
            await asyncio.sleep(delay)
            delay *= 2
            continue
        return resp
    return None


def _infer_entry_type_from_crossref(raw_type: str | None, venue: str = "", has_isbn: bool = False) -> str:
    t = (raw_type or "").lower()
    if t in {"journal-article", "article-journal"}:
        return "article"
    if t in {"proceedings-article", "paper-conference"}:
        return "inproceedings"
    if t in {"book", "monograph", "edited-book", "book-chapter"} or has_isbn:
        return "book"
    if t in {"report", "working-paper"}:
        return "techreport"
    if t in {"posted-content", "preprint"}:
        return "misc"
    v_low = venue.lower()
    if any(k in v_low for k in ("proceedings", "conference", "symposium", "workshop", "neurips", "icml", "iclr", "cvpr", "aaai", "acl", "emnlp", "kdd", "sigir")):
        return "inproceedings"
    if "arxiv" in v_low or "preprint" in v_low:
        return "misc"
    if venue:
        return "article"
    return "misc"


async def lookup_citation_registries(
    ref_line: str,
    mailto: str = "researchforge@example.edu",
    claim_context: str = "",
) -> Dict[str, Any]:
    import httpx

    ident = extract_reference_identifiers(ref_line)
    cache_key = (ident["doi"] or ident["arxivId"] or ident["guessedTitle"] or ref_line).lower().strip()
    now = time.time()

    matched: Optional[Dict[str, Any]] = None
    registry = "None"
    network_errors = 0
    cache_hit = False

    cached = _SCHOLARLY_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _CACHE_TTL_SECONDS:
        matched, registry = cached[1], cached[2]
        cache_hit = True
    else:
        headers = {"User-Agent": f"ResearchForgeAI/1.2 (mailto:{mailto})"}
        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            if ident["doi"]:
                try:
                    r = await _fetch_with_backoff(client, f"https://api.crossref.org/works/{ident['doi']}")
                    if r is not None and r.status_code == 200:
                        msg = r.json().get("message", {})
                        authors = [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in msg.get("author", [])]
                        title = (msg.get("title") or [""])[0]
                        year = str(((msg.get("issued") or {}).get("date-parts") or [[""]])[0][0])
                        venue = (msg.get("container-title") or ["Academic Venue"])[0]
                        abstract = re.sub(r"<[^>]+>", " ", msg.get("abstract") or "").strip()
                        isbn_list = msg.get("ISBN") or []
                        isbn = str(isbn_list[0]) if isbn_list else None
                        matched = {
                            "title": title,
                            "authors": authors,
                            "year": year,
                            "venue": venue,
                            "doi": ident["doi"],
                            "url": msg.get("URL") or f"https://doi.org/{ident['doi']}",
                            "abstract": abstract,
                            "volume": msg.get("volume") or None,
                            "issue": msg.get("issue") or None,
                            "pages": msg.get("page") or None,
                            "publisher": msg.get("publisher") or None,
                            "isbn": isbn,
                            "entryType": _infer_entry_type_from_crossref(msg.get("type"), venue, bool(isbn)),
                        }
                        registry = "Crossref"
                except Exception:
                    network_errors += 1

            if matched is None and ident["arxivId"]:
                try:
                    r = await _fetch_with_backoff(
                        client,
                        "https://export.arxiv.org/api/query",
                        params={"id_list": ident["arxivId"]},
                    )
                    if r is not None and r.status_code == 200:
                        root = ET.fromstring(r.text)
                        ns = {"a": "http://www.w3.org/2005/Atom"}
                        entry = root.find("a:entry", ns)
                        if entry is not None:
                            title = re.sub(r"\s+", " ", (entry.findtext("a:title", "", ns) or "").strip())
                            authors = [a.findtext("a:name", "", ns) or "" for a in entry.findall("a:author", ns)]
                            published = (entry.findtext("a:published", "", ns) or "")[:4]
                            summary = re.sub(r"\s+", " ", (entry.findtext("a:summary", "", ns) or "").strip())
                            matched = {
                                "title": title,
                                "authors": authors,
                                "year": published,
                                "venue": "arXiv",
                                "doi": None,
                                "url": f"https://arxiv.org/abs/{ident['arxivId']}",
                                "abstract": summary,
                                "volume": None,
                                "issue": None,
                                "pages": None,
                                "publisher": "arXiv",
                                "isbn": None,
                                "entryType": "misc",
                            }
                            registry = "arXiv"
                except Exception:
                    network_errors += 1

            if matched is None and ident["guessedTitle"]:
                try:
                    r = await _fetch_with_backoff(
                        client,
                        "https://api.openalex.org/works",
                        params={"search": ident["guessedTitle"], "per-page": 1},
                    )
                    if r is not None and r.status_code == 200:
                        results = r.json().get("results", [])
                        if results:
                            top = results[0]
                            sim = title_similarity(ident["guessedTitle"], top.get("title") or "")
                            if sim >= 0.48:
                                authors = [au.get("author", {}).get("display_name", "") for au in top.get("authorships", [])]
                                source = (top.get("primary_location") or {}).get("source") or {}
                                venue = source.get("display_name") or "OpenAlex"
                                biblio = top.get("biblio") or {}
                                first_p = biblio.get("first_page")
                                last_p = biblio.get("last_page")
                                pages = f"{first_p}-{last_p}" if first_p and last_p else (str(first_p) if first_p else None)
                                doi = (top.get("doi") or "").replace("https://doi.org/", "") or None
                                matched = {
                                    "title": top.get("title", ""),
                                    "authors": authors,
                                    "year": str(top.get("publication_year", "")),
                                    "venue": venue,
                                    "doi": doi,
                                    "url": top.get("doi") or top.get("id") or "",
                                    "abstract": "",
                                    "volume": biblio.get("volume") or None,
                                    "issue": biblio.get("issue") or None,
                                    "pages": pages,
                                    "publisher": source.get("host_organization_name") or None,
                                    "isbn": None,
                                    "entryType": _infer_entry_type_from_crossref(top.get("type"), venue, False),
                                }
                                registry = "OpenAlex"
                except Exception:
                    network_errors += 1

            if matched is None and ident["guessedTitle"]:
                try:
                    r = await _fetch_with_backoff(
                        client,
                        "https://api.semanticscholar.org/graph/v1/paper/search",
                        params={"query": ident["guessedTitle"], "limit": 1, "fields": "title,authors,year,venue,journal,publicationTypes,externalIds,abstract,url"},
                    )
                    if r is not None and r.status_code == 200:
                        data = r.json().get("data", [])
                        if data:
                            top = data[0]
                            sim = title_similarity(ident["guessedTitle"], top.get("title") or "")
                            if sim >= 0.48:
                                authors = [a.get("name", "") for a in top.get("authors", [])]
                                doi = (top.get("externalIds") or {}).get("DOI")
                                journal = top.get("journal") or {}
                                venue = journal.get("name") or top.get("venue") or "Semantic Scholar"
                                pub_types = [pt.lower() for pt in (top.get("publicationTypes") or [])]
                                entry_type = "inproceedings" if "conference" in pub_types else _infer_entry_type_from_crossref(None, venue, False)
                                matched = {
                                    "title": top.get("title", ""),
                                    "authors": authors,
                                    "year": str(top.get("year", "")),
                                    "venue": venue,
                                    "doi": doi,
                                    "url": top.get("url") or "",
                                    "abstract": top.get("abstract") or "",
                                    "volume": journal.get("volume") or None,
                                    "issue": None,
                                    "pages": journal.get("pages") or None,
                                    "publisher": None,
                                    "isbn": None,
                                    "entryType": entry_type,
                                }
                                registry = "Semantic Scholar"
                except Exception:
                    network_errors += 1

        if matched is not None or network_errors == 0:
            _SCHOLARLY_CACHE[cache_key] = (now, matched, registry)

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
            "cached": cache_hit,
            "matchedTitle": matched["title"],
            "authors": matched["authors"],
            "year": matched["year"],
            "venue": matched["venue"],
            "doi": matched["doi"],
            "url": matched["url"],
            "volume": matched.get("volume"),
            "issue": matched.get("issue"),
            "pages": matched.get("pages"),
            "publisher": matched.get("publisher"),
            "isbn": matched.get("isbn"),
            "entryType": matched.get("entryType") or "misc",
            "arxivId": ident["arxivId"],
            "sourceRetrieved": has_abstract,
            "yearMatch": year_ok,
            "claimEvaluation": claim_eval,
            "ieeeFormatted": format_ieee(matched["authors"], matched["title"], matched["venue"], matched["year"], matched["doi"]),
            "apaFormatted": format_apa(matched["authors"], matched["title"], matched["venue"], matched["year"], matched["doi"]),
        }

    return {
        "raw": ref_line,
        "status": "Unverified",
        "detailedStatus": "Verification unavailable" if network_errors > 0 else "No matching scholarly record",
        "registry": "None",
        "cached": cache_hit,
        "matchedTitle": None,
        "authors": [],
        "year": ident["year"],
        "venue": None,
        "doi": ident["doi"],
        "url": "",
        "volume": None,
        "issue": None,
        "pages": None,
        "publisher": None,
        "isbn": None,
        "entryType": "misc",
        "arxivId": ident["arxivId"],
        "sourceRetrieved": False,
        "yearMatch": False,
        "claimEvaluation": None,
        "ieeeFormatted": ref_line,
        "apaFormatted": ref_line,
    }


_BIBTEX_STOPWORDS = {"a", "an", "the", "of", "on", "in", "for", "to", "with", "and", "by", "via", "from", "using"}
_ALLOWED_BIBTEX_TYPES = {"article", "inproceedings", "book", "techreport", "misc"}


def escape_bibtex_value(value: str) -> str:
    """Escape special LaTeX/BibTeX characters inside braced BibTeX field values."""
    cleaned = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    replacements = [
        ("\\", r"\textbackslash{}"),
        ("{", r"\{"),
        ("}", r"\}"),
        ("&", r"\&"),
        ("%", r"\%"),
        ("$", r"\$"),
        ("#", r"\#"),
        ("_", r"\_"),
        ("~", r"\textasciitilde{}"),
        ("^", r"\textasciicircum{}"),
    ]
    out = cleaned
    for src, dst in replacements:
        out = out.replace(src, dst)
    return re.sub(r"\s{2,}", " ", out)


def _ascii_slug(text: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9\s]", "", text or "")
    return re.sub(r"\s+", "", normalized).lower()


def generate_citation_key(
    authors: List[str],
    year: Optional[str | int],
    title: str,
    existing_keys: Optional[set[str]] = None,
) -> str:
    used = existing_keys if existing_keys is not None else set()
    surname = "ref"
    if authors:
        first_author = str(authors[0] or "").strip()
        if "," in first_author:
            surname = _ascii_slug(first_author.split(",")[0]) or "ref"
        else:
            parts = first_author.split()
            surname = _ascii_slug(parts[-1] if parts else "") or "ref"

    yr = str(year or "").strip()
    if not re.match(r"^(?:19|20)\d{2}$", yr):
        yr = "nd"

    title_words = [
        w for w in re.findall(r"[A-Za-z0-9]+", (title or "").lower())
        if w not in _BIBTEX_STOPWORDS and len(w) > 2
    ]
    keyword = title_words[0] if title_words else "work"
    base = f"{surname[:18]}{yr}{keyword[:14]}"
    candidate = base
    suffix_idx = 0
    while candidate in used:
        suffix = chr(97 + (suffix_idx % 26)) if suffix_idx < 26 else f"_{suffix_idx}"
        candidate = f"{base}{suffix}"
        suffix_idx += 1
    used.add(candidate)
    return candidate


def _extract_citation_fields(item: Dict[str, Any]) -> Dict[str, Any]:
    meta = item.get("verifiedMetadata") or {}
    raw = str(item.get("rawReference") or item.get("raw") or "")
    ident = extract_reference_identifiers(raw) if raw else {"doi": None, "arxivId": None, "year": None, "guessedTitle": ""}

    title = str(meta.get("title") or item.get("matchedTitle") or item.get("extractedTitle") or ident.get("guessedTitle") or raw).strip()
    authors = [str(a).strip() for a in (meta.get("authors") or item.get("authors") or []) if str(a).strip()]
    year_val = meta.get("year") or item.get("year") or item.get("extractedYear") or ident.get("year")
    year = str(year_val).strip() if year_val else None
    venue = str(meta.get("venue") or item.get("venue") or "").strip() or None
    doi = str(meta.get("doi") or item.get("doi") or item.get("extractedDoi") or ident.get("doi") or "").strip() or None
    url = str(meta.get("url") or item.get("url") or "").strip() or None
    volume = str(meta.get("volume") or item.get("volume") or "").strip() or None
    issue = str(meta.get("issue") or item.get("issue") or "").strip() or None
    pages = str(meta.get("pages") or item.get("pages") or "").strip() or None
    publisher = str(meta.get("publisher") or item.get("publisher") or "").strip() or None
    isbn = str(meta.get("isbn") or item.get("isbn") or "").strip() or None
    arxiv_id = str(item.get("arxivId") or item.get("extractedArxiv") or ident.get("arxivId") or "").strip() or None

    raw_entry_type = str(meta.get("entryType") or item.get("entryType") or "").lower().strip()
    entry_type = raw_entry_type if raw_entry_type in _ALLOWED_BIBTEX_TYPES else _infer_entry_type_from_crossref(None, venue or "", bool(isbn))

    status = str(item.get("status") or "Unverified")
    bib_status = str(item.get("bibliographicStatus") or item.get("detailedStatus") or "")
    is_verified = status == "Verified" or (
        status != "Unverified" and bib_status == "Bibliographic metadata verified"
    )

    warnings: List[str] = []
    if not is_verified:
        warnings.append(f"Citation verification status is '{status}' (registry metadata not fully confirmed).")
    if not title:
        warnings.append("Missing verified title.")
    if not authors:
        warnings.append("Missing author list.")
    if not year:
        warnings.append("Missing publication year.")
    if entry_type in {"article", "inproceedings"} and not venue:
        warnings.append("Missing journal or proceedings venue.")

    return {
        "raw": raw,
        "status": status,
        "isVerified": is_verified,
        "isComplete": bool(title and authors and year),
        "title": title,
        "authors": authors,
        "year": year,
        "venue": venue,
        "doi": doi,
        "url": url,
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "publisher": publisher,
        "isbn": isbn,
        "arxivId": arxiv_id,
        "entryType": entry_type,
        "warnings": warnings,
    }


def format_bibtex_entry(
    item: Dict[str, Any],
    existing_keys: Optional[set[str]] = None,
    annotate_unverified: bool = True,
) -> Dict[str, Any]:
    fields = _extract_citation_fields(item)
    key = generate_citation_key(fields["authors"], fields["year"], fields["title"], existing_keys)
    entry_type = fields["entryType"]

    lines: List[str] = []
    if annotate_unverified and (not fields["isVerified"] or not fields["isComplete"]):
        lines.append(f"% WARNING: {'; '.join(fields['warnings']) or 'Unverified metadata — check before publication.'}")

    bib_fields: List[Tuple[str, str]] = []
    if fields["authors"]:
        bib_fields.append(("author", " and ".join(escape_bibtex_value(a) for a in fields["authors"])))
    if fields["title"]:
        bib_fields.append(("title", f"{{{escape_bibtex_value(fields['title'])}}}"))
    if fields["venue"]:
        if entry_type == "article":
            bib_fields.append(("journal", escape_bibtex_value(fields["venue"])))
        elif entry_type == "inproceedings":
            bib_fields.append(("booktitle", escape_bibtex_value(fields["venue"])))
        elif entry_type == "techreport":
            bib_fields.append(("institution", escape_bibtex_value(fields["venue"])))
        elif entry_type == "misc":
            bib_fields.append(("howpublished", escape_bibtex_value(fields["venue"])))
    if fields["year"]:
        bib_fields.append(("year", escape_bibtex_value(fields["year"])))
    if fields["volume"]:
        bib_fields.append(("volume", escape_bibtex_value(fields["volume"])))
    if fields["issue"]:
        bib_fields.append(("number", escape_bibtex_value(fields["issue"])))
    if fields["pages"]:
        bib_fields.append(("pages", escape_bibtex_value(fields["pages"])))
    if fields["publisher"]:
        bib_fields.append(("publisher", escape_bibtex_value(fields["publisher"])))
    if fields["isbn"]:
        bib_fields.append(("isbn", escape_bibtex_value(fields["isbn"])))
    if fields["doi"]:
        bib_fields.append(("doi", escape_bibtex_value(fields["doi"])))
    if fields["arxivId"]:
        bib_fields.append(("eprint", escape_bibtex_value(fields["arxivId"])))
        bib_fields.append(("archivePrefix", "arXiv"))
    if fields["url"]:
        bib_fields.append(("url", escape_bibtex_value(fields["url"])))
    if annotate_unverified and fields["warnings"]:
        bib_fields.append(("note", escape_bibtex_value(f"Verification notice: {fields['warnings'][0]}")))

    header = f"@{entry_type}{{{key},"
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in bib_fields)
    raw_entry = f"{header}\n{body}\n}}" if body else f"{header}\n}}"
    lines.append(raw_entry)

    return {
        "key": key,
        "entryType": entry_type,
        "bibtex": "\n".join(lines),
        "isVerified": fields["isVerified"],
        "isComplete": fields["isComplete"],
        "warnings": fields["warnings"],
    }


def validate_bibtex_syntax(bibtex_text: str) -> Dict[str, Any]:
    """Validate structural BibTeX syntax: balanced braces, valid headers, and unique citation keys."""
    errors: List[str] = []
    keys: List[str] = []
    seen: set[str] = set()

    if not bibtex_text or not bibtex_text.strip():
        return {"valid": False, "entryCount": 0, "keys": [], "errors": ["BibTeX output is empty."]}

    cleaned_lines = [l for l in bibtex_text.splitlines() if not l.lstrip().startswith("%")]
    no_comments = "\n".join(cleaned_lines)

    depth = 0
    for idx, ch in enumerate(no_comments):
        prev = no_comments[idx - 1] if idx > 0 else ""
        if ch == "{" and prev != "\\":
            depth += 1
        elif ch == "}" and prev != "\\":
            depth -= 1
            if depth < 0:
                errors.append(f"Unmatched closing brace '}}' at character {idx}.")
                break
    if depth != 0:
        errors.append(f"Unbalanced BibTeX braces (net brace depth = {depth}).")

    for m in re.finditer(r"@([a-zA-Z]+)\s*\{\s*([^,\s{}]+)\s*,", no_comments):
        etype = m.group(1).lower()
        key = m.group(2).strip()
        if etype not in _ALLOWED_BIBTEX_TYPES:
            errors.append(f"Unsupported BibTeX entry type '@{etype}' on key '{key}'.")
        if key in seen:
            errors.append(f"Duplicate BibTeX citation key '{key}'.")
        seen.add(key)
        keys.append(key)

    if len(keys) == 0:
        errors.append("No valid '@type{key,' BibTeX entries found.")

    return {
        "valid": len(errors) == 0,
        "entryCount": len(keys),
        "keys": keys,
        "errors": errors,
    }


def export_bibtex_collection(
    citations: List[Dict[str, Any]],
    include_unverified: bool = False,
) -> Dict[str, Any]:
    """Export verified (and optionally unverified/incomplete) citations to validated BibTeX."""
    used_keys: set[str] = set()
    included_entries: List[Dict[str, Any]] = []
    skipped_refs: List[Dict[str, str]] = []

    for item in citations:
        fields = _extract_citation_fields(item)
        eligible = fields["isVerified"] and fields["isComplete"]
        if not include_unverified and not eligible:
            skipped_refs.append({
                "id": str(item.get("id") or ""),
                "rawReference": fields["raw"][:120],
                "reason": "; ".join(fields["warnings"]) or "Unverified metadata",
            })
            continue
        formatted = format_bibtex_entry(item, existing_keys=used_keys, annotate_unverified=True)
        included_entries.append({
            "id": str(item.get("id") or ""),
            **formatted,
        })

    header_comment = (
        f"% ResearchForge AI BibTeX Export — {len(included_entries)} included, "
        f"{len(skipped_refs)} skipped ({'verified + unverified' if include_unverified else 'verified only'})"
    )
    bibtex_blocks = [header_comment] + [e["bibtex"] for e in included_entries]
    bibtex_text = "\n\n".join(bibtex_blocks).strip() + ("\n" if included_entries else "")
    validation = (
        validate_bibtex_syntax(bibtex_text)
        if included_entries
        else {"valid": True, "entryCount": 0, "keys": [], "errors": []}
    )

    return {
        "bibtex": bibtex_text,
        "includeUnverified": include_unverified,
        "includedCount": len(included_entries),
        "skippedCount": len(skipped_refs),
        "skippedEntries": skipped_refs,
        "entries": included_entries,
        "validation": validation,
    }


def _clean_bibtex_field_text(val: str) -> str:
    s = (val or "").strip()
    while len(s) >= 2 and ((s[0] == "{" and s[-1] == "}") or (s[0] == '"' and s[-1] == '"')):
        # Only strip outer braces if balanced inside
        if s[0] == "{":
            depth = 0
            balanced_wrap = True
            for idx, ch in enumerate(s):
                prev = s[idx - 1] if idx > 0 else ""
                if ch == "{" and prev != "\\":
                    depth += 1
                elif ch == "}" and prev != "\\":
                    depth -= 1
                    if depth == 0 and idx < len(s) - 1:
                        balanced_wrap = False
                        break
            if not balanced_wrap:
                break
        s = s[1:-1].strip()
    # Unwrap single-word/phrase protective braces like {Transformer}
    s = re.sub(r"\{([^{}]+)\}", r"\1", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _split_bibtex_authors(author_raw: str) -> List[str]:
    if not author_raw:
        return []
    parts: List[str] = []
    buf: List[str] = []
    depth = 0
    i = 0
    while i < len(author_raw):
        ch = author_raw[i]
        prev = author_raw[i - 1] if i > 0 else ""
        if ch == "{" and prev != "\\":
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch == "}" and prev != "\\":
            depth = max(0, depth - 1)
            buf.append(ch)
            i += 1
            continue
        if depth == 0:
            m = re.match(r"\s+and\s+", author_raw[i:], flags=re.IGNORECASE)
            if m:
                chunk = _clean_bibtex_field_text("".join(buf))
                if chunk:
                    parts.append(chunk)
                buf = []
                i += len(m.group(0))
                continue
        buf.append(ch)
        i += 1
    tail = _clean_bibtex_field_text("".join(buf))
    if tail:
        parts.append(tail)
    return parts


def _parse_bibtex_fields(body: str) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    i = 0
    n = len(body)
    while i < n:
        while i < n and (body[i].isspace() or body[i] == ","):
            i += 1
        if i >= n:
            break
        if body[i] == "%":
            nl = body.find("\n", i)
            i = n if nl == -1 else nl + 1
            continue

        name_start = i
        while i < n and (body[i].isalnum() or body[i] in "_-:"):
            i += 1
        field_name = body[name_start:i].strip().lower()
        while i < n and body[i].isspace():
            i += 1
        if not field_name or i >= n or body[i] != "=":
            # Skip unexpected token to next comma
            comma = body.find(",", i)
            i = n if comma == -1 else comma + 1
            continue
        i += 1  # consume '='

        value_segments: List[str] = []
        while i < n:
            while i < n and body[i].isspace():
                i += 1
            if i >= n:
                break
            if body[i] == "{":
                start = i
                depth = 0
                while i < n:
                    prev = body[i - 1] if i > start else ""
                    if body[i] == "{" and prev != "\\":
                        depth += 1
                    elif body[i] == "}" and prev != "\\":
                        depth -= 1
                        if depth == 0:
                            i += 1
                            break
                    i += 1
                value_segments.append(_clean_bibtex_field_text(body[start:i]))
            elif body[i] == '"':
                start = i + 1
                i += 1
                depth = 0
                while i < n:
                    prev = body[i - 1]
                    if body[i] == "{" and prev != "\\":
                        depth += 1
                    elif body[i] == "}" and prev != "\\":
                        depth = max(0, depth - 1)
                    elif body[i] == '"' and depth == 0 and prev != "\\":
                        break
                    i += 1
                value_segments.append(_clean_bibtex_field_text(body[start:i]))
                if i < n and body[i] == '"':
                    i += 1
            else:
                start = i
                while i < n and body[i] not in ",#}\n\r":
                    i += 1
                value_segments.append(_clean_bibtex_field_text(body[start:i]))

            while i < n and body[i].isspace():
                i += 1
            if i < n and body[i] == "#":
                i += 1
                continue
            break

        if field_name:
            fields[field_name] = " ".join(seg for seg in value_segments if seg).strip()
        if i < n and body[i] == ",":
            i += 1
    return fields


def parse_bibtex_entries(bibtex_text: str) -> List[Dict[str, Any]]:
    """Parse raw .bib text into structured BibTeX entries, preserving nested braces and citation keys."""
    entries: List[Dict[str, Any]] = []
    if not bibtex_text or not bibtex_text.strip():
        return entries

    n = len(bibtex_text)
    i = 0
    while i < n:
        ch = bibtex_text[i]
        if ch == "%":
            nl = bibtex_text.find("\n", i)
            i = n if nl == -1 else nl + 1
            continue
        if ch != "@":
            i += 1
            continue

        at_idx = i
        i += 1
        type_start = i
        while i < n and bibtex_text[i].isalpha():
            i += 1
        entry_type = bibtex_text[type_start:i].lower().strip()
        while i < n and bibtex_text[i].isspace():
            i += 1
        if i >= n or bibtex_text[i] not in "{(":
            continue
        open_delim = bibtex_text[i]
        close_delim = "}" if open_delim == "{" else ")"
        depth = 1
        i += 1
        content_start = i
        in_quotes = False
        while i < n and depth > 0:
            c = bibtex_text[i]
            prev = bibtex_text[i - 1] if i > content_start else ""
            if open_delim == "{" and c == '"' and depth == 1 and prev != "\\":
                in_quotes = not in_quotes
            elif not in_quotes or open_delim == "{":
                if c == open_delim and prev != "\\":
                    depth += 1
                elif c == close_delim and prev != "\\":
                    depth -= 1
                    if depth == 0:
                        break
            i += 1

        raw_block = bibtex_text[at_idx : min(n, i + 1)]
        inner = bibtex_text[content_start:i]
        if i < n and bibtex_text[i] == close_delim:
            i += 1

        if entry_type in {"comment", "preamble", "string"} or not entry_type:
            continue

        comma_idx = inner.find(",")
        parse_errors: List[str] = []
        if comma_idx == -1:
            cite_key = inner.strip() or f"entry_{len(entries) + 1}"
            fields: Dict[str, str] = {}
            parse_errors.append("Missing comma separator after citation key.")
        else:
            cite_key = inner[:comma_idx].strip() or f"entry_{len(entries) + 1}"
            fields = _parse_bibtex_fields(inner[comma_idx + 1 :])

        if depth != 0:
            parse_errors.append("Unclosed brace/parenthesis in BibTeX entry.")

        raw_doi = fields.get("doi", "").strip()
        doi_match = DOI_REGEX.search(raw_doi) or DOI_REGEX.search(fields.get("url", ""))
        doi = doi_match.group(1).rstrip(".,;)") if doi_match else (raw_doi.replace("https://doi.org/", "").replace("http://doi.org/", "").strip() or None)

        raw_eprint = fields.get("eprint", "").strip()
        arxiv_m = ARXIV_REGEX.search(raw_eprint) or ARXIV_REGEX.search(fields.get("url", "")) or re.match(r"^(\d{4}\.\d{4,5}(?:v\d+)?)$", raw_eprint)
        arxiv_id = arxiv_m.group(1) if arxiv_m else None

        year_str = fields.get("year", "").strip()
        year_m = YEAR_REGEX.search(year_str)
        year = year_m.group(1) if year_m else (year_str or None)

        authors = _split_bibtex_authors(fields.get("author", "") or fields.get("editor", ""))
        title = fields.get("title", "").strip()
        venue = (fields.get("journal") or fields.get("booktitle") or fields.get("institution") or fields.get("publisher") or "").strip() or None

        entries.append({
            "rawEntry": raw_block,
            "entryType": entry_type,
            "citeKey": cite_key,
            "fields": fields,
            "title": title,
            "authors": authors,
            "year": year,
            "venue": venue,
            "doi": doi,
            "arxivId": arxiv_id,
            "url": fields.get("url", "").strip() or None,
            "parseErrors": parse_errors,
        })
    return entries


def _surname_tokens(name: str) -> str:
    cleaned = (name or "").strip()
    if "," in cleaned:
        last = cleaned.split(",")[0].strip()
    else:
        parts = cleaned.split()
        last = parts[-1] if parts else ""
    return re.sub(r"[^a-z0-9]", "", last.lower())


def _bibtex_entry_to_lookup_string(entry: Dict[str, Any]) -> str:
    parts: List[str] = []
    if entry.get("authors"):
        parts.append(", ".join(entry["authors"][:3]))
    if entry.get("title"):
        parts.append(f'"{entry["title"]}"')
    if entry.get("venue"):
        parts.append(entry["venue"])
    if entry.get("year"):
        parts.append(str(entry["year"]))
    if entry.get("doi"):
        parts.append(f"DOI: {entry['doi']}")
    if entry.get("arxivId"):
        parts.append(f"arXiv:{entry['arxivId']}")
    return ", ".join(parts) or entry.get("citeKey", "")


def evaluate_bibtex_entry_against_record(
    entry: Dict[str, Any],
    lookup_res: Dict[str, Any],
) -> Dict[str, Any]:
    """Compare declared BibTeX entry fields against a registry lookup record."""
    discrepancies: List[Dict[str, str]] = []
    matched_title = lookup_res.get("matchedTitle") or ""
    registry = lookup_res.get("registry") or "None"
    declared_title = entry.get("title") or ""
    declared_year = str(entry.get("year") or "").strip() or None
    reg_year = str(lookup_res.get("year") or "").strip() or None
    declared_doi = (entry.get("doi") or "").strip() or None
    reg_doi = (lookup_res.get("doi") or "").strip() or None
    declared_authors = entry.get("authors") or []
    reg_authors = lookup_res.get("authors") or []
    declared_venue = entry.get("venue") or None
    reg_venue = lookup_res.get("venue") or None

    t_sim = round(title_similarity(declared_title, matched_title), 3) if declared_title and matched_title else (1.0 if matched_title and not declared_title else 0.0)
    doi_matched: Optional[bool] = None
    if declared_doi and reg_doi:
        doi_matched = declared_doi.lower() == reg_doi.lower()
        if not doi_matched:
            discrepancies.append({
                "field": "doi",
                "declared": declared_doi,
                "registry": reg_doi,
                "severity": "error",
            })

    year_matched: Optional[bool] = None
    if declared_year and reg_year:
        year_matched = declared_year == reg_year
        if not year_matched:
            discrepancies.append({
                "field": "year",
                "declared": declared_year,
                "registry": reg_year,
                "severity": "warning",
            })

    author_matched: Optional[bool] = None
    if declared_authors and reg_authors:
        dec_surnames = {_surname_tokens(a) for a in declared_authors if _surname_tokens(a)}
        reg_surnames = {_surname_tokens(a) for a in reg_authors if _surname_tokens(a)}
        author_matched = bool(dec_surnames & reg_surnames)
        if not author_matched:
            discrepancies.append({
                "field": "author",
                "declared": "; ".join(declared_authors[:3]),
                "registry": "; ".join(reg_authors[:3]),
                "severity": "error",
            })

    if declared_title and matched_title and t_sim < 0.72:
        discrepancies.append({
            "field": "title",
            "declared": declared_title,
            "registry": matched_title,
            "severity": "warning" if t_sim >= 0.48 else "error",
        })

    venue_sim = round(title_similarity(declared_venue, reg_venue), 3) if declared_venue and reg_venue else None
    venue_contains = (
        declared_venue.lower() in reg_venue.lower() or reg_venue.lower() in declared_venue.lower()
        if declared_venue and reg_venue
        else False
    )
    if declared_venue and reg_venue and venue_sim is not None and venue_sim < 0.45 and not venue_contains:
        discrepancies.append({
            "field": "venue",
            "declared": declared_venue,
            "registry": reg_venue,
            "severity": "warning",
        })

    if matched_title and t_sim >= 0.72 and doi_matched is not False and year_matched is not False and author_matched is not False:
        status = "Verified"
        bib_status = "Bibliographic metadata verified"
    elif matched_title and (t_sim >= 0.48 or doi_matched is True):
        status = "Needs review"
        bib_status = "Bibliographic metadata verified"
    else:
        status = "Unverified"
        bib_status = lookup_res.get("detailedStatus") or "No matching scholarly record"

    flags = list(entry.get("parseErrors") or [])
    for d in discrepancies:
        flags.append(f"{d['field'].upper()} mismatch: BibTeX has \"{d['declared']}\", {registry} reports \"{d['registry']}\".")
    if status == "Unverified" and not discrepancies:
        flags.append("No matching record confirmed across Crossref, OpenAlex, Semantic Scholar, or arXiv.")

    verified_meta = (
        {
            "title": matched_title,
            "authors": reg_authors,
            "year": reg_year,
            "venue": reg_venue,
            "doi": reg_doi or declared_doi,
            "url": lookup_res.get("url") or "",
            "volume": lookup_res.get("volume"),
            "issue": lookup_res.get("issue"),
            "pages": lookup_res.get("pages"),
            "publisher": lookup_res.get("publisher"),
            "isbn": lookup_res.get("isbn"),
            "entryType": lookup_res.get("entryType") or entry.get("entryType") or "misc",
            "credibilityNote": f"{registry} indexed ({reg_venue})" if reg_venue else f"{registry} record matched",
        }
        if matched_title
        else None
    )

    return {
        "id": f"bib_{entry['citeKey']}",
        "citeKey": entry["citeKey"],
        "entryType": entry["entryType"],
        "rawReference": entry["rawEntry"],
        "declared": {
            "title": declared_title,
            "authors": declared_authors,
            "year": declared_year,
            "venue": declared_venue,
            "doi": declared_doi,
            "arxivId": entry.get("arxivId"),
            "url": entry.get("url"),
        },
        "status": status,
        "bibliographicStatus": bib_status,
        "matchedProvider": registry,
        "titleMatchScore": t_sim,
        "doiMatched": doi_matched,
        "yearMatched": year_matched,
        "authorMatched": author_matched,
        "venueMatchScore": venue_sim,
        "discrepancies": discrepancies,
        "verifiedMetadata": verified_meta,
        "matchedTitle": matched_title or None,
        "authors": reg_authors or declared_authors,
        "year": reg_year or declared_year,
        "venue": reg_venue or declared_venue,
        "doi": reg_doi or declared_doi,
        "url": lookup_res.get("url") or entry.get("url") or "",
        "flags": flags,
    }


async def verify_bibtex_entries(
    bibtex_text: str,
    mailto: str = "researchforge@example.edu",
    include_unverified: bool = False,
) -> Dict[str, Any]:
    """Parse a BibTeX collection and cross-reference every entry against Crossref, OpenAlex, Semantic Scholar, and arXiv."""
    syntax = validate_bibtex_syntax(bibtex_text)
    parsed_entries = parse_bibtex_entries(bibtex_text)
    if not parsed_entries:
        return {
            "syntax": syntax,
            "summary": {
                "totalEntries": 0,
                "verifiedCount": 0,
                "needsReviewCount": 0,
                "unverifiedCount": 0,
                "discrepancyCount": 0,
            },
            "entries": [],
            "correctedBibtex": export_bibtex_collection([], include_unverified=include_unverified),
        }

    sem = asyncio.Semaphore(5)

    async def _check_one(entry: Dict[str, Any]) -> Dict[str, Any]:
        async with sem:
            lookup_str = _bibtex_entry_to_lookup_string(entry)
            lookup_res = await lookup_citation_registries(lookup_str, mailto=mailto)
            return evaluate_bibtex_entry_against_record(entry, lookup_res)

    checked = await asyncio.gather(*[_check_one(e) for e in parsed_entries[:25]])
    corrected = export_bibtex_collection(checked, include_unverified=include_unverified)

    return {
        "syntax": syntax,
        "summary": {
            "totalEntries": len(checked),
            "verifiedCount": sum(1 for e in checked if e["status"] == "Verified"),
            "needsReviewCount": sum(1 for e in checked if e["status"] == "Needs review"),
            "unverifiedCount": sum(1 for e in checked if e["status"] == "Unverified"),
            "discrepancyCount": sum(len(e["discrepancies"]) for e in checked),
        },
        "entries": checked,
        "correctedBibtex": corrected,
    }
