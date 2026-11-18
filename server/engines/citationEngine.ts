import { diceBigramSimilarity, tokenize } from './similarityEngine';

export type VerificationStatus = 'Verified' | 'Needs review' | 'Unverified';
export type BibliographicState = 'Bibliographic metadata verified' | 'Verification unavailable';
export type ClaimSupportState =
  | 'Source retrieved'
  | 'Claim supported'
  | 'Claim contradicted'
  | 'Evidence insufficient'
  | 'Verification unavailable';

export interface VerifiedCitation {
  id: string;
  rawReference: string;
  parsedIndex: string | null;
  extractedDoi: string | null;
  extractedArxiv: string | null;
  extractedYear: number | null;
  extractedTitle: string;
  status: VerificationStatus;
  bibliographicStatus: BibliographicState;
  claimSupportStatus: ClaimSupportState;
  matchedProvider: 'Crossref' | 'OpenAlex' | 'Semantic Scholar' | 'arXiv' | 'None';
  titleMatchScore: number;
  yearMatched: boolean | null;
  authorMatched: boolean | null;
  verifiedMetadata: {
    title?: string;
    authors?: string[];
    year?: number;
    venue?: string;
    doi?: string;
    url?: string;
    citationCount?: number;
    credibilityNote?: string;
  } | null;
  formattedIEEE: string;
  formattedAPA: string;
  flags: string[];
  citedInText: boolean;
  isDuplicate?: boolean;
}

export interface CitationAuditResult {
  citations: VerifiedCitation[];
  summary: {
    totalReferences: number;
    verifiedCount: number;
    needsReviewCount: number;
    unverifiedCount: number;
    unavailableCount: number;
    duplicateReferences: string[];
    orphanedInTextCitations: string[];
    uncitedReferences: string[];
  };
}

function extractDoi(ref: string): string | null {
  const m = ref.match(/\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i);
  return m ? m[1].replace(/[.,;)]+$/, '') : null;
}

function extractArxiv(ref: string): string | null {
  const m = ref.match(/arXiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return m ? m[1] : null;
}

function extractYear(ref: string): number | null {
  const matches = ref.match(/\b(19\d{2}|20[0-2]\d)\b/g);
  if (!matches) return null;
  const yr = Number(matches[matches.length - 1]);
  return Number.isFinite(yr) ? yr : null;
}

function extractQuotedOrGuessedTitle(ref: string): string {
  const quoted = ref.match(/["“]([^"”]{8,220})["”]/);
  if (quoted) return quoted[1].trim();
  const cleaned = ref
    .replace(/^\[\d+\]\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\bDOI:.*$/i, '')
    .trim();
  const parts = cleaned.split(/\.\s+/);
  if (parts.length >= 2) {
    return parts.sort((a, b) => b.length - a.length)[0].slice(0, 180).trim();
  }
  return cleaned.slice(0, 180);
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 4500): Promise<{ ok: boolean; data: any | null; reachable: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ResearchForgeAI/1.1 (mailto:researchforge@example.edu)' },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, data: null, reachable: true };
    return { ok: true, data: await res.json(), reachable: true };
  } catch {
    clearTimeout(timer);
    return { ok: false, data: null, reachable: false };
  }
}

async function queryCrossrefByDoi(doi: string) {
  const r = await fetchJsonWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const msg = r.data?.message;
  if (!msg) return { record: null, reachable: r.reachable };
  const title = Array.isArray(msg.title) ? msg.title[0] : msg.title;
  const authors = Array.isArray(msg.author)
    ? msg.author.map((a: any) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean)
    : [];
  const year =
    msg.published?.['date-parts']?.[0]?.[0] ??
    msg['published-print']?.['date-parts']?.[0]?.[0] ??
    msg['published-online']?.['date-parts']?.[0]?.[0] ??
    null;
  const venue = Array.isArray(msg['container-title']) ? msg['container-title'][0] : undefined;
  return {
    reachable: true,
    record: {
      provider: 'Crossref' as const,
      title: title ?? '',
      authors,
      year,
      venue,
      doi: msg.DOI ?? doi,
      url: msg.URL ?? `https://doi.org/${doi}`,
      citationCount: msg['is-referenced-by-count'] ?? undefined,
    },
  };
}

async function queryCrossrefSearch(title: string) {
  const r = await fetchJsonWithTimeout(
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=2`
  );
  const item = r.data?.message?.items?.[0];
  if (!item) return { record: null, reachable: r.reachable };
  const matchedTitle = Array.isArray(item.title) ? item.title[0] : item.title;
  const authors = Array.isArray(item.author)
    ? item.author.map((a: any) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean)
    : [];
  const year = item.published?.['date-parts']?.[0]?.[0] ?? null;
  return {
    reachable: true,
    record: {
      provider: 'Crossref' as const,
      title: matchedTitle ?? '',
      authors,
      year,
      venue: Array.isArray(item['container-title']) ? item['container-title'][0] : undefined,
      doi: item.DOI,
      url: item.URL,
      citationCount: item['is-referenced-by-count'] ?? undefined,
    },
  };
}

async function queryOpenAlex(title: string) {
  const r = await fetchJsonWithTimeout(
    `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=2`
  );
  const work = r.data?.results?.[0];
  if (!work) return { record: null, reachable: r.reachable };
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map((a: any) => a.author?.display_name).filter(Boolean)
    : [];
  return {
    reachable: true,
    record: {
      provider: 'OpenAlex' as const,
      title: work.title ?? '',
      authors,
      year: work.publication_year ?? null,
      venue: work.primary_location?.source?.display_name ?? undefined,
      doi: work.doi ? String(work.doi).replace('https://doi.org/', '') : undefined,
      url: work.doi ?? work.id,
      citationCount: work.cited_by_count ?? undefined,
    },
  };
}

async function querySemanticScholar(title: string) {
  const r = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=title,authors,year,venue,citationCount,externalIds,url`
  );
  const p = r.data?.data?.[0];
  if (!p) return { record: null, reachable: r.reachable };
  return {
    reachable: true,
    record: {
      provider: 'Semantic Scholar' as const,
      title: p.title ?? '',
      authors: Array.isArray(p.authors) ? p.authors.map((a: any) => a.name).filter(Boolean) : [],
      year: p.year ?? null,
      venue: p.venue || undefined,
      doi: p.externalIds?.DOI,
      url: p.url,
      citationCount: p.citationCount,
    },
  };
}

async function queryArxiv(arxivIdOrTitle: string, isId: boolean) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const query = isId ? `id_list=${encodeURIComponent(arxivIdOrTitle)}` : `search_query=ti:${encodeURIComponent(arxivIdOrTitle)}&max_results=1`;
    const res = await fetch(`https://export.arxiv.org/api/query?${query}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { record: null, reachable: true };
    const xml = await res.text();
    const entry = xml.split('<entry>')[1];
    if (!entry) return { record: null, reachable: true };
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    const published = entry.match(/<published>(\d{4})/)?.[1];
    const idUrl = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim();
    const authors = Array.from(entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
    if (!title) return { record: null, reachable: true };
    return {
      reachable: true,
      record: {
        provider: 'arXiv' as const,
        title,
        authors,
        year: published ? Number(published) : null,
        venue: 'arXiv Preprint',
        doi: undefined,
        url: idUrl,
        citationCount: undefined,
      },
    };
  } catch {
    clearTimeout(timer);
    return { record: null, reachable: false };
  }
}

export function formatIEEE(idx: string | null, authors: string[], title: string, venue?: string, year?: number | null, doi?: string): string {
  const prefix = idx ? `[${idx}] ` : '';
  const authStr =
    authors.length === 0
      ? 'Unknown Author(s)'
      : authors.length > 3
      ? `${authors[0]} et al.`
      : authors.join(', ');
  const venuePart = venue ? `, ${venue}` : '';
  const yearPart = year ? `, ${year}` : '';
  const doiPart = doi ? `. DOI: ${doi}` : '';
  return `${prefix}${authStr}, "${title}"${venuePart}${yearPart}${doiPart}.`;
}

export function formatAPA(authors: string[], title: string, venue?: string, year?: number | null, doi?: string): string {
  const authStr =
    authors.length === 0
      ? 'Unknown Author.'
      : authors.length > 3
      ? `${authors[0]} et al.`
      : authors.join(', ');
  const yr = year ? `(${year})` : '(n.d.)';
  const ven = venue ? ` *${venue}*.` : '';
  const d = doi ? ` https://doi.org/${doi}` : '';
  return `${authStr} ${yr}. ${title}.${ven}${d}`;
}

interface RegistryCandidate {
  provider: 'Crossref' | 'OpenAlex' | 'Semantic Scholar' | 'arXiv';
  title: string;
  authors: string[];
  year: number | null;
  venue?: string;
  doi?: string;
  url?: string;
  citationCount?: number;
}

export async function verifySingleReference(
  rawReference: string,
  fullManuscriptText = ''
): Promise<VerifiedCitation> {
  const idxMatch = rawReference.match(/^\[(\d+)\]/);
  const parsedIndex = idxMatch ? idxMatch[1] : null;
  const extractedDoi = extractDoi(rawReference);
  const extractedArxiv = extractArxiv(rawReference);
  const extractedYear = extractYear(rawReference);
  const extractedTitle = extractQuotedOrGuessedTitle(rawReference);
  const flags: string[] = [];

  let candidate: RegistryCandidate | null = null;
  let anyReachable = false;

  if (extractedDoi) {
    const r = await queryCrossrefByDoi(extractedDoi);
    anyReachable = anyReachable || r.reachable;
    candidate = r.record;
    if (!candidate && r.reachable) {
      flags.push(`DOI ${extractedDoi} could not be resolved in Crossref.`);
    }
  }
  if (!candidate && extractedArxiv) {
    const r = await queryArxiv(extractedArxiv, true);
    anyReachable = anyReachable || r.reachable;
    candidate = r.record;
  }
  if (!candidate && extractedTitle.length >= 10) {
    const cr = await queryCrossrefSearch(extractedTitle);
    anyReachable = anyReachable || cr.reachable;
    candidate = cr.record;
    if (!candidate) {
      const oa = await queryOpenAlex(extractedTitle);
      anyReachable = anyReachable || oa.reachable;
      candidate = oa.record;
    }
    if (!candidate) {
      const s2 = await querySemanticScholar(extractedTitle);
      anyReachable = anyReachable || s2.reachable;
      candidate = s2.record;
    }
    if (!candidate) {
      const ax = await queryArxiv(extractedTitle, false);
      anyReachable = anyReachable || ax.reachable;
      candidate = ax.record;
    }
  }

  let titleMatchScore = 0;
  let yearMatched: boolean | null = null;
  let authorMatched: boolean | null = null;

  if (candidate && candidate.title) {
    titleMatchScore = Number(diceBigramSimilarity(extractedTitle, candidate.title).toFixed(3));
    if (extractedYear && candidate.year) {
      yearMatched = Math.abs(extractedYear - candidate.year) <= 1;
      if (!yearMatched) {
        flags.push(`Year mismatch: reference lists ${extractedYear}, registry reports ${candidate.year}.`);
      }
    }
    if (candidate.authors.length > 0) {
      const refLower = rawReference.toLowerCase();
      const firstLast = candidate.authors[0].split(/\s+/).pop()?.toLowerCase() ?? '';
      authorMatched = firstLast.length >= 2 ? refLower.includes(firstLast) : null;
      if (authorMatched === false) {
        flags.push(`Primary author surname "${firstLast}" not found in reference string.`);
      }
    }
  }

  let status: VerificationStatus = 'Unverified';
  let bibliographicStatus: BibliographicState = 'Verification unavailable';
  let claimSupportStatus: ClaimSupportState = 'Verification unavailable';

  if (candidate && titleMatchScore >= 0.72 && yearMatched !== false && authorMatched !== false) {
    status = 'Verified';
    bibliographicStatus = 'Bibliographic metadata verified';
    claimSupportStatus = 'Source retrieved';
  } else if (candidate && titleMatchScore >= 0.48) {
    status = 'Needs review';
    bibliographicStatus = 'Bibliographic metadata verified';
    claimSupportStatus = 'Evidence insufficient';
    if (titleMatchScore < 0.72) {
      flags.push(`Partial title similarity (${Math.round(titleMatchScore * 100)}%); confirm bibliographic match.`);
    }
  } else if (!anyReachable) {
    status = 'Needs review';
    bibliographicStatus = 'Verification unavailable';
    claimSupportStatus = 'Verification unavailable';
    flags.push('External bibliographic registries unreachable (offline/timeout).');
  } else {
    status = 'Unverified';
    bibliographicStatus = 'Verification unavailable';
    claimSupportStatus = 'Evidence insufficient';
    flags.push('No matching record confirmed across Crossref, OpenAlex, Semantic Scholar, or arXiv.');
  }

  let citedInText = true;
  if (fullManuscriptText.trim().length > 0 && parsedIndex) {
    const bodyOnly = fullManuscriptText.split(/\nreferences\b/i)[0] ?? fullManuscriptText;
    const refPattern = new RegExp(`\\[(?:[^\\]]*,\\s*)?${parsedIndex}(?:\\s*,[^\\]]*)?\\]`);
    citedInText = refPattern.test(bodyOnly);
    if (!citedInText) {
      flags.push(`Reference [${parsedIndex}] appears in bibliography but is not cited in manuscript body.`);
    }
  }

  const authors = candidate?.authors ?? [];
  const finalTitle = candidate?.title || extractedTitle;
  const finalYear = candidate?.year ?? extractedYear;
  const finalDoi = candidate?.doi ?? extractedDoi ?? undefined;
  const credibilityNote = candidate?.venue
    ? `${candidate.provider} indexed (${candidate.venue})${candidate.citationCount !== undefined ? ` · ${candidate.citationCount} citations` : ''}`
    : candidate
    ? `${candidate.provider} record matched`
    : 'Not indexed in queried open registries';

  return {
    id: `cit_${Math.random().toString(36).slice(2, 9)}`,
    rawReference,
    parsedIndex,
    extractedDoi,
    extractedArxiv,
    extractedYear,
    extractedTitle,
    status,
    bibliographicStatus,
    claimSupportStatus,
    matchedProvider: candidate ? candidate.provider : 'None',
    titleMatchScore,
    yearMatched,
    authorMatched,
    verifiedMetadata: candidate
      ? {
          title: candidate.title,
          authors: candidate.authors,
          year: candidate.year ?? undefined,
          venue: candidate.venue,
          doi: candidate.doi,
          url: candidate.url,
          citationCount: candidate.citationCount,
          credibilityNote,
        }
      : null,
    formattedIEEE: formatIEEE(parsedIndex, authors, finalTitle, candidate?.venue, finalYear, finalDoi),
    formattedAPA: formatAPA(authors, finalTitle, candidate?.venue, finalYear, finalDoi),
    flags,
    citedInText,
  };
}

export async function verifyBibliography(
  references: string[],
  fullManuscriptText = ''
): Promise<CitationAuditResult> {
  const limited = references.filter((r) => r.trim().length > 5).slice(0, 20);
  const results = await Promise.all(limited.map((r) => verifySingleReference(r, fullManuscriptText)));

  // Detect duplicate bibliography entries
  const seenKeys = new Map<string, number>();
  const duplicateReferences: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const key = (r.extractedDoi || r.extractedTitle).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (key && seenKeys.has(key)) {
      r.isDuplicate = true;
      r.flags.push(`Duplicate bibliography entry (matches item #${seenKeys.get(key)! + 1}).`);
      duplicateReferences.push(r.parsedIndex ? `[${r.parsedIndex}]` : `#${i + 1}`);
    } else if (key) {
      seenKeys.set(key, i);
    }
  }

  const bodyOnly = fullManuscriptText.split(/\nreferences\b/i)[0] ?? fullManuscriptText;
  const citedIndices = new Set<string>();
  const matches = bodyOnly.match(/\[(\d+(?:\s*,\s*\d+)*)\]/g) ?? [];
  for (const m of matches) {
    const nums = m.replace(/[[\]\s]/g, '').split(',');
    for (const n of nums) if (n) citedIndices.add(n);
  }
  const presentIndices = new Set(results.map((r) => r.parsedIndex).filter(Boolean) as string[]);
  const orphanedInTextCitations = Array.from(citedIndices).filter((idx) => !presentIndices.has(idx)).map((i) => `[${i}]`);
  const uncitedReferences = results.filter((r) => !r.citedInText && r.parsedIndex).map((r) => `[${r.parsedIndex}]`);

  return {
    citations: results,
    summary: {
      totalReferences: results.length,
      verifiedCount: results.filter((c) => c.status === 'Verified').length,
      needsReviewCount: results.filter((c) => c.status === 'Needs review').length,
      unverifiedCount: results.filter((c) => c.status === 'Unverified').length,
      unavailableCount: results.filter((c) => c.bibliographicStatus === 'Verification unavailable').length,
      duplicateReferences,
      orphanedInTextCitations,
      uncitedReferences,
    },
  };
}

const OPPOSING_POLARITY_PAIRS: Array<[RegExp, RegExp]> = [
  [/\b(increase[sd]?|improv(e[sd]?|ing)|outperform(s|ed)?|higher|gain[sd]?)\b/i, /\b(decrease[sd]?|degrad(e[sd]?|ing)|underperform(s|ed)?|lower|drop[sd]?)\b/i],
  [/\b(significant|confirmed|supports?|effective|feasible)\b/i, /\b(insignificant|refutes?|contradicts?|ineffective|infeasible|no evidence)\b/i],
];

export function checkClaimToSourceRelevance(claim: string, sourceTitleOrAbstract: string): {
  overlapScore: number;
  sharedConcepts: string[];
  claimSupportStatus: ClaimSupportState;
  assessment: string;
} {
  const claimTokens = new Set(tokenize(claim).filter((t) => t.length > 3));
  const srcTokens = new Set(tokenize(sourceTitleOrAbstract).filter((t) => t.length > 3));
  const shared: string[] = [];
  for (const t of claimTokens) {
    if (srcTokens.has(t)) shared.push(t);
  }
  const overlapScore = claimTokens.size > 0 ? Number((shared.length / claimTokens.size).toFixed(2)) : 0;

  let polarityConflict = false;
  for (const [posRe, negRe] of OPPOSING_POLARITY_PAIRS) {
    if ((posRe.test(claim) && negRe.test(sourceTitleOrAbstract)) || (negRe.test(claim) && posRe.test(sourceTitleOrAbstract))) {
      polarityConflict = true;
      break;
    }
  }

  let claimSupportStatus: ClaimSupportState = 'Evidence insufficient';
  let assessment = 'Low lexical overlap; source metadata or abstract is insufficient to verify this claim.';

  if (polarityConflict && shared.length >= 2) {
    claimSupportStatus = 'Claim contradicted';
    assessment = 'Polarity conflict detected between manuscript claim and retrieved source text on shared concepts.';
  } else if (overlapScore >= 0.35 && shared.length >= 3) {
    claimSupportStatus = 'Claim supported';
    assessment = 'Substantial conceptual alignment between claim and source text without polarity contradiction.';
  } else if (overlapScore >= 0.15) {
    claimSupportStatus = 'Evidence insufficient';
    assessment = 'Moderate topical alignment only; consult full-text methods/results before asserting support.';
  }

  return { overlapScore, sharedConcepts: shared, claimSupportStatus, assessment };
}
