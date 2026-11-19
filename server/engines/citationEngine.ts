import { diceBigramSimilarity, tokenize } from './similarityEngine';

export type VerificationStatus = 'Verified' | 'Needs review' | 'Unverified';
export type BibliographicState = 'Bibliographic metadata verified' | 'Verification unavailable';
export type ClaimSupportState =
  | 'Source retrieved'
  | 'Claim supported'
  | 'Claim contradicted'
  | 'Evidence insufficient'
  | 'Verification unavailable';

export type BibtexEntryType = 'article' | 'inproceedings' | 'book' | 'techreport' | 'misc';

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
    volume?: string;
    issue?: string;
    pages?: string;
    publisher?: string;
    isbn?: string;
    entryType?: BibtexEntryType;
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

function inferEntryType(rawType?: string, venue?: string, hasIsbn?: boolean): BibtexEntryType {
  const t = (rawType || '').toLowerCase();
  if (t === 'journal-article' || t === 'article-journal') return 'article';
  if (t === 'proceedings-article' || t === 'paper-conference') return 'inproceedings';
  if (t === 'book' || t === 'monograph' || t === 'edited-book' || t === 'book-chapter' || hasIsbn) return 'book';
  if (t === 'report' || t === 'working-paper') return 'techreport';
  if (t === 'posted-content' || t === 'preprint') return 'misc';
  const v = (venue || '').toLowerCase();
  if (/proceedings|conference|symposium|workshop|neurips|icml|iclr|cvpr|aaai|acl|emnlp|kdd|sigir/.test(v)) {
    return 'inproceedings';
  }
  if (/arxiv|preprint/.test(v)) return 'misc';
  return venue ? 'article' : 'misc';
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
  const isbn = Array.isArray(msg.ISBN) && msg.ISBN.length > 0 ? String(msg.ISBN[0]) : undefined;
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
      volume: msg.volume ? String(msg.volume) : undefined,
      issue: msg.issue ? String(msg.issue) : undefined,
      pages: msg.page ? String(msg.page) : undefined,
      publisher: msg.publisher ? String(msg.publisher) : undefined,
      isbn,
      entryType: inferEntryType(msg.type, venue, Boolean(isbn)),
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
  const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : undefined;
  const isbn = Array.isArray(item.ISBN) && item.ISBN.length > 0 ? String(item.ISBN[0]) : undefined;
  return {
    reachable: true,
    record: {
      provider: 'Crossref' as const,
      title: matchedTitle ?? '',
      authors,
      year,
      venue,
      doi: item.DOI,
      url: item.URL,
      volume: item.volume ? String(item.volume) : undefined,
      issue: item.issue ? String(item.issue) : undefined,
      pages: item.page ? String(item.page) : undefined,
      publisher: item.publisher ? String(item.publisher) : undefined,
      isbn,
      entryType: inferEntryType(item.type, venue, Boolean(isbn)),
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
  const source = work.primary_location?.source;
  const venue = source?.display_name ?? undefined;
  const bib = work.biblio || {};
  const pages = bib.first_page && bib.last_page ? `${bib.first_page}-${bib.last_page}` : bib.first_page ? String(bib.first_page) : undefined;
  return {
    reachable: true,
    record: {
      provider: 'OpenAlex' as const,
      title: work.title ?? '',
      authors,
      year: work.publication_year ?? null,
      venue,
      doi: work.doi ? String(work.doi).replace('https://doi.org/', '') : undefined,
      url: work.doi ?? work.id,
      volume: bib.volume ? String(bib.volume) : undefined,
      issue: bib.issue ? String(bib.issue) : undefined,
      pages,
      publisher: source?.host_organization_name ? String(source.host_organization_name) : undefined,
      isbn: undefined,
      entryType: inferEntryType(work.type, venue, false),
      citationCount: work.cited_by_count ?? undefined,
    },
  };
}

async function querySemanticScholar(title: string) {
  const r = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=title,authors,year,venue,journal,publicationTypes,citationCount,externalIds,url`
  );
  const p = r.data?.data?.[0];
  if (!p) return { record: null, reachable: r.reachable };
  const venue = p.journal?.name || p.venue || undefined;
  const pubTypes: string[] = Array.isArray(p.publicationTypes) ? p.publicationTypes.map((x: any) => String(x).toLowerCase()) : [];
  return {
    reachable: true,
    record: {
      provider: 'Semantic Scholar' as const,
      title: p.title ?? '',
      authors: Array.isArray(p.authors) ? p.authors.map((a: any) => a.name).filter(Boolean) : [],
      year: p.year ?? null,
      venue,
      doi: p.externalIds?.DOI,
      url: p.url,
      volume: p.journal?.volume ? String(p.journal.volume) : undefined,
      issue: undefined,
      pages: p.journal?.pages ? String(p.journal.pages) : undefined,
      publisher: undefined,
      isbn: undefined,
      entryType: pubTypes.includes('conference') ? ('inproceedings' as const) : inferEntryType(undefined, venue, false),
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
        volume: undefined,
        issue: undefined,
        pages: undefined,
        publisher: 'arXiv',
        isbn: undefined,
        entryType: 'misc' as const,
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
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  isbn?: string;
  entryType?: BibtexEntryType;
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
    if (!extractedDoi && !extractedArxiv && titleMatchScore < 0.45) {
      candidate = null;
      titleMatchScore = 0;
    }
  }

  if (candidate && candidate.title) {
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
          volume: candidate.volume,
          issue: candidate.issue,
          pages: candidate.pages,
          publisher: candidate.publisher,
          isbn: candidate.isbn,
          entryType: candidate.entryType,
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

const BIBTEX_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'for', 'to', 'with', 'and', 'by', 'via', 'from', 'using',
]);
const ALLOWED_BIBTEX_TYPES = new Set<BibtexEntryType>(['article', 'inproceedings', 'book', 'techreport', 'misc']);

export interface BibtexEntryResult {
  id?: string;
  key: string;
  entryType: BibtexEntryType;
  bibtex: string;
  isVerified: boolean;
  isComplete: boolean;
  warnings: string[];
}

export interface BibtexValidationResult {
  valid: boolean;
  entryCount: number;
  keys: string[];
  errors: string[];
}

export interface BibtexExportResult {
  bibtex: string;
  includeUnverified: boolean;
  includedCount: number;
  skippedCount: number;
  skippedEntries: Array<{ id: string; rawReference: string; reason: string }>;
  entries: BibtexEntryResult[];
  validation: BibtexValidationResult;
}

export function escapeBibtexValue(value: string): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\s{2,}/g, ' ');
}

function asciiSlug(text: string): string {
  return String(text || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function generateCitationKey(
  authors: string[],
  year: string | number | null | undefined,
  title: string,
  existingKeys: Set<string> = new Set()
): string {
  let surname = 'ref';
  if (authors.length > 0) {
    const first = String(authors[0] || '').trim();
    if (first.includes(',')) {
      surname = asciiSlug(first.split(',')[0]) || 'ref';
    } else {
      const parts = first.split(/\s+/);
      surname = asciiSlug(parts[parts.length - 1] || '') || 'ref';
    }
  }
  const yrStr = String(year ?? '').trim();
  const yr = /^(?:19|20)\d{2}$/.test(yrStr) ? yrStr : 'nd';
  const words = (title || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((w) => !BIBTEX_STOPWORDS.has(w) && w.length > 2) ?? [];
  const keyword = words[0] || 'work';
  const base = `${surname.slice(0, 18)}${yr}${keyword.slice(0, 14)}`;

  let candidate = base;
  let idx = 0;
  while (existingKeys.has(candidate)) {
    const suffix = idx < 26 ? String.fromCharCode(97 + idx) : `_${idx}`;
    candidate = `${base}${suffix}`;
    idx += 1;
  }
  existingKeys.add(candidate);
  return candidate;
}

function normalizeCitationForBibtex(item: Record<string, any>) {
  const meta = item.verifiedMetadata || {};
  const raw = String(item.rawReference || item.raw || '');
  const title = String(
    meta.title || item.matchedTitle || item.extractedTitle || extractQuotedOrGuessedTitle(raw) || raw
  ).trim();
  const authors: string[] = Array.isArray(meta.authors)
    ? meta.authors.map((a: any) => String(a).trim()).filter(Boolean)
    : Array.isArray(item.authors)
    ? item.authors.map((a: any) => String(a).trim()).filter(Boolean)
    : [];
  const rawYear = meta.year ?? item.year ?? item.extractedYear ?? extractYear(raw);
  const year = rawYear ? String(rawYear).trim() : null;
  const venue = String(meta.venue || item.venue || '').trim() || null;
  const doi = String(meta.doi || item.doi || item.extractedDoi || extractDoi(raw) || '').trim() || null;
  const url = String(meta.url || item.url || '').trim() || null;
  const volume = String(meta.volume || item.volume || '').trim() || null;
  const issue = String(meta.issue || item.issue || '').trim() || null;
  const pages = String(meta.pages || item.pages || '').trim() || null;
  const publisher = String(meta.publisher || item.publisher || '').trim() || null;
  const isbn = String(meta.isbn || item.isbn || '').trim() || null;
  const arxivId = String(item.arxivId || item.extractedArxiv || extractArxiv(raw) || '').trim() || null;

  const rawType = String(meta.entryType || item.entryType || '').toLowerCase().trim() as BibtexEntryType;
  const entryType: BibtexEntryType = ALLOWED_BIBTEX_TYPES.has(rawType)
    ? rawType
    : inferEntryType(undefined, venue || undefined, Boolean(isbn));

  const status = String(item.status || 'Unverified');
  const bibStatus = String(item.bibliographicStatus || item.detailedStatus || '');
  const isVerified =
    status === 'Verified' || (status !== 'Unverified' && bibStatus === 'Bibliographic metadata verified');

  const warnings: string[] = [];
  if (!isVerified) {
    warnings.push(`Citation verification status is '${status}' (registry metadata not fully confirmed).`);
  }
  if (!title) warnings.push('Missing verified title.');
  if (authors.length === 0) warnings.push('Missing author list.');
  if (!year) warnings.push('Missing publication year.');
  if ((entryType === 'article' || entryType === 'inproceedings') && !venue) {
    warnings.push('Missing journal or proceedings venue.');
  }

  return {
    id: String(item.id || ''),
    raw,
    status,
    isVerified,
    isComplete: Boolean(title && authors.length > 0 && year),
    title,
    authors,
    year,
    venue,
    doi,
    url,
    volume,
    issue,
    pages,
    publisher,
    isbn,
    arxivId,
    entryType,
    warnings,
  };
}

export function formatBibtexEntry(
  item: Record<string, any>,
  existingKeys: Set<string> = new Set(),
  annotateUnverified = true
): BibtexEntryResult {
  const f = normalizeCitationForBibtex(item);
  const key = generateCitationKey(f.authors, f.year, f.title, existingKeys);
  const lines: string[] = [];

  if (annotateUnverified && (!f.isVerified || !f.isComplete)) {
    lines.push(`% WARNING: ${f.warnings.join('; ') || 'Unverified metadata — check before publication.'}`);
  }

  const fields: Array<[string, string]> = [];
  if (f.authors.length > 0) {
    fields.push(['author', f.authors.map((a) => escapeBibtexValue(a)).join(' and ')]);
  }
  if (f.title) {
    fields.push(['title', `{${escapeBibtexValue(f.title)}}`]);
  }
  if (f.venue) {
    if (f.entryType === 'article') fields.push(['journal', escapeBibtexValue(f.venue)]);
    else if (f.entryType === 'inproceedings') fields.push(['booktitle', escapeBibtexValue(f.venue)]);
    else if (f.entryType === 'techreport') fields.push(['institution', escapeBibtexValue(f.venue)]);
    else if (f.entryType === 'misc') fields.push(['howpublished', escapeBibtexValue(f.venue)]);
  }
  if (f.year) fields.push(['year', escapeBibtexValue(f.year)]);
  if (f.volume) fields.push(['volume', escapeBibtexValue(f.volume)]);
  if (f.issue) fields.push(['number', escapeBibtexValue(f.issue)]);
  if (f.pages) fields.push(['pages', escapeBibtexValue(f.pages)]);
  if (f.publisher) fields.push(['publisher', escapeBibtexValue(f.publisher)]);
  if (f.isbn) fields.push(['isbn', escapeBibtexValue(f.isbn)]);
  if (f.doi) fields.push(['doi', escapeBibtexValue(f.doi)]);
  if (f.arxivId) {
    fields.push(['eprint', escapeBibtexValue(f.arxivId)]);
    fields.push(['archivePrefix', 'arXiv']);
  }
  if (f.url) fields.push(['url', escapeBibtexValue(f.url)]);
  if (annotateUnverified && f.warnings.length > 0) {
    fields.push(['note', escapeBibtexValue(`Verification notice: ${f.warnings[0]}`)]);
  }

  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
  lines.push(body ? `@${f.entryType}{${key},\n${body}\n}` : `@${f.entryType}{${key},\n}`);

  return {
    id: f.id,
    key,
    entryType: f.entryType,
    bibtex: lines.join('\n'),
    isVerified: f.isVerified,
    isComplete: f.isComplete,
    warnings: f.warnings,
  };
}

export function validateBibtexSyntax(bibtexText: string): BibtexValidationResult {
  const errors: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();

  if (!bibtexText || !bibtexText.trim()) {
    return { valid: false, entryCount: 0, keys: [], errors: ['BibTeX output is empty.'] };
  }

  const noComments = bibtexText
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('%'))
    .join('\n');

  let depth = 0;
  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    const prev = i > 0 ? noComments[i - 1] : '';
    if (ch === '{' && prev !== '\\') {
      depth += 1;
    } else if (ch === '}' && prev !== '\\') {
      depth -= 1;
      if (depth < 0) {
        errors.push(`Unmatched closing brace '}' at character ${i}.`);
        break;
      }
    }
  }
  if (depth !== 0) {
    errors.push(`Unbalanced BibTeX braces (net brace depth = ${depth}).`);
  }

  const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s{}]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(noComments)) !== null) {
    const etype = match[1].toLowerCase() as BibtexEntryType;
    const key = match[2].trim();
    if (!ALLOWED_BIBTEX_TYPES.has(etype)) {
      errors.push(`Unsupported BibTeX entry type '@${etype}' on key '${key}'.`);
    }
    if (seen.has(key)) {
      errors.push(`Duplicate BibTeX citation key '${key}'.`);
    }
    seen.add(key);
    keys.push(key);
  }

  if (keys.length === 0) {
    errors.push("No valid '@type{key,' BibTeX entries found.");
  }

  return { valid: errors.length === 0, entryCount: keys.length, keys, errors };
}

export function exportBibtexCollection(
  citations: Array<Record<string, any> | string>,
  includeUnverified = false
): BibtexExportResult {
  const usedKeys = new Set<string>();
  const includedEntries: BibtexEntryResult[] = [];
  const skippedEntries: Array<{ id: string; rawReference: string; reason: string }> = [];

  citations.forEach((rawItem, idx) => {
    const item =
      typeof rawItem === 'string'
        ? { id: `ref_${idx + 1}`, rawReference: rawItem, status: 'Unverified' }
        : rawItem;
    const norm = normalizeCitationForBibtex(item);
    const eligible = norm.isVerified && norm.isComplete;
    if (!includeUnverified && !eligible) {
      skippedEntries.push({
        id: norm.id,
        rawReference: norm.raw.slice(0, 120),
        reason: norm.warnings.join('; ') || 'Unverified metadata',
      });
      return;
    }
    includedEntries.push(formatBibtexEntry(item, usedKeys, true));
  });

  const header = `% ResearchForge AI BibTeX Export — ${includedEntries.length} included, ${skippedEntries.length} skipped (${
    includeUnverified ? 'verified + unverified' : 'verified only'
  })`;
  const bibtex =
    includedEntries.length > 0
      ? `${[header, ...includedEntries.map((e) => e.bibtex)].join('\n\n').trim()}\n`
      : `${header}\n`;
  const validation =
    includedEntries.length > 0
      ? validateBibtexSyntax(bibtex)
      : { valid: true, entryCount: 0, keys: [], errors: [] };

  return {
    bibtex,
    includeUnverified,
    includedCount: includedEntries.length,
    skippedCount: skippedEntries.length,
    skippedEntries,
    entries: includedEntries,
    validation,
  };
}

export interface ParsedBibtexEntry {
  rawEntry: string;
  entryType: string;
  citeKey: string;
  fields: Record<string, string>;
  title: string;
  authors: string[];
  year: string | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  parseErrors: string[];
}

export interface BibtexDiscrepancy {
  field: 'title' | 'author' | 'year' | 'doi' | 'venue';
  declared: string;
  registry: string;
  severity: 'error' | 'warning';
}

export interface VerifiedBibtexEntry {
  id: string;
  citeKey: string;
  entryType: string;
  rawReference: string;
  declared: {
    title: string;
    authors: string[];
    year: string | null;
    venue: string | null;
    doi: string | null;
    arxivId: string | null;
    url: string | null;
  };
  status: VerificationStatus;
  bibliographicStatus: BibliographicState;
  matchedProvider: 'Crossref' | 'OpenAlex' | 'Semantic Scholar' | 'arXiv' | 'None';
  titleMatchScore: number;
  doiMatched: boolean | null;
  yearMatched: boolean | null;
  authorMatched: boolean | null;
  venueMatchScore: number | null;
  discrepancies: BibtexDiscrepancy[];
  verifiedMetadata: VerifiedCitation['verifiedMetadata'];
  matchedTitle: string | null;
  authors: string[];
  year: string | null;
  venue: string | null;
  doi: string | null;
  url: string;
  flags: string[];
}

export interface BibtexVerificationReport {
  syntax: BibtexValidationResult;
  summary: {
    totalEntries: number;
    verifiedCount: number;
    needsReviewCount: number;
    unverifiedCount: number;
    discrepancyCount: number;
  };
  entries: VerifiedBibtexEntry[];
  correctedBibtex: BibtexExportResult;
}

function cleanBibtexFieldText(val: string): string {
  let s = (val || '').trim();
  while (s.length >= 2 && ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '"' && s[s.length - 1] === '"'))) {
    if (s[0] === '{') {
      let depth = 0;
      let balancedWrap = true;
      for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        const prev = i > 0 ? s[i - 1] : '';
        if (ch === '{' && prev !== '\\') depth += 1;
        else if (ch === '}' && prev !== '\\') {
          depth -= 1;
          if (depth === 0 && i < s.length - 1) {
            balancedWrap = false;
            break;
          }
        }
      }
      if (!balancedWrap) break;
    }
    s = s.slice(1, -1).trim();
  }
  return s.replace(/\{([^{}]+)\}/g, '$1').replace(/\s+/g, ' ').trim();
}

function splitBibtexAuthors(authorRaw: string): string[] {
  if (!authorRaw) return [];
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let i = 0;
  while (i < authorRaw.length) {
    const ch = authorRaw[i];
    const prev = i > 0 ? authorRaw[i - 1] : '';
    if (ch === '{' && prev !== '\\') {
      depth += 1;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '}' && prev !== '\\') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const m = authorRaw.slice(i).match(/^\s+and\s+/i);
      if (m) {
        const cleaned = cleanBibtexFieldText(buf);
        if (cleaned) parts.push(cleaned);
        buf = '';
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  const tail = cleanBibtexFieldText(buf);
  if (tail) parts.push(tail);
  return parts;
}

function parseBibtexFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const n = body.length;
  let i = 0;
  while (i < n) {
    while (i < n && (/\s/.test(body[i]) || body[i] === ',')) i += 1;
    if (i >= n) break;
    if (body[i] === '%') {
      const nl = body.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    const nameStart = i;
    while (i < n && /[A-Za-z0-9_:-]/.test(body[i])) i += 1;
    const fieldName = body.slice(nameStart, i).trim().toLowerCase();
    while (i < n && /\s/.test(body[i])) i += 1;
    if (!fieldName || i >= n || body[i] !== '=') {
      const comma = body.indexOf(',', i);
      i = comma === -1 ? n : comma + 1;
      continue;
    }
    i += 1;

    const segments: string[] = [];
    while (i < n) {
      while (i < n && /\s/.test(body[i])) i += 1;
      if (i >= n) break;
      if (body[i] === '{') {
        const start = i;
        let depth = 0;
        while (i < n) {
          const prev = i > start ? body[i - 1] : '';
          if (body[i] === '{' && prev !== '\\') depth += 1;
          else if (body[i] === '}' && prev !== '\\') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
          i += 1;
        }
        segments.push(cleanBibtexFieldText(body.slice(start, i)));
      } else if (body[i] === '"') {
        const start = i + 1;
        i += 1;
        let depth = 0;
        while (i < n) {
          const prev = body[i - 1];
          if (body[i] === '{' && prev !== '\\') depth += 1;
          else if (body[i] === '}' && prev !== '\\') depth = Math.max(0, depth - 1);
          else if (body[i] === '"' && depth === 0 && prev !== '\\') break;
          i += 1;
        }
        segments.push(cleanBibtexFieldText(body.slice(start, i)));
        if (i < n && body[i] === '"') i += 1;
      } else {
        const start = i;
        while (i < n && !',#}\n\r'.includes(body[i])) i += 1;
        segments.push(cleanBibtexFieldText(body.slice(start, i)));
      }

      while (i < n && /\s/.test(body[i])) i += 1;
      if (i < n && body[i] === '#') {
        i += 1;
        continue;
      }
      break;
    }

    if (fieldName) {
      fields[fieldName] = segments.filter(Boolean).join(' ').trim();
    }
    if (i < n && body[i] === ',') i += 1;
  }
  return fields;
}

export function parseBibtexEntries(bibtexText: string): ParsedBibtexEntry[] {
  const entries: ParsedBibtexEntry[] = [];
  if (!bibtexText || !bibtexText.trim()) return entries;

  const n = bibtexText.length;
  let i = 0;
  while (i < n) {
    if (bibtexText[i] === '%') {
      const nl = bibtexText.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (bibtexText[i] !== '@') {
      i += 1;
      continue;
    }

    const atIdx = i;
    i += 1;
    const typeStart = i;
    while (i < n && /[A-Za-z]/.test(bibtexText[i])) i += 1;
    const entryType = bibtexText.slice(typeStart, i).toLowerCase().trim();
    while (i < n && /\s/.test(bibtexText[i])) i += 1;
    if (i >= n || (bibtexText[i] !== '{' && bibtexText[i] !== '(')) continue;

    const openDelim = bibtexText[i];
    const closeDelim = openDelim === '{' ? '}' : ')';
    let depth = 1;
    i += 1;
    const contentStart = i;
    let inQuotes = false;
    while (i < n && depth > 0) {
      const c = bibtexText[i];
      const prev = i > contentStart ? bibtexText[i - 1] : '';
      if (openDelim === '{' && c === '"' && depth === 1 && prev !== '\\') {
        inQuotes = !inQuotes;
      } else if (!inQuotes || openDelim === '{') {
        if (c === openDelim && prev !== '\\') depth += 1;
        else if (c === closeDelim && prev !== '\\') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i += 1;
    }

    const rawEntry = bibtexText.slice(atIdx, Math.min(n, i + 1));
    const inner = bibtexText.slice(contentStart, i);
    if (i < n && bibtexText[i] === closeDelim) i += 1;

    if (!entryType || entryType === 'comment' || entryType === 'preamble' || entryType === 'string') {
      continue;
    }

    const commaIdx = inner.indexOf(',');
    const parseErrors: string[] = [];
    let citeKey = '';
    let fields: Record<string, string> = {};
    if (commaIdx === -1) {
      citeKey = inner.trim() || `entry_${entries.length + 1}`;
      parseErrors.push('Missing comma separator after citation key.');
    } else {
      citeKey = inner.slice(0, commaIdx).trim() || `entry_${entries.length + 1}`;
      fields = parseBibtexFields(inner.slice(commaIdx + 1));
    }
    if (depth !== 0) parseErrors.push('Unclosed brace/parenthesis in BibTeX entry.');

    const rawDoi = (fields.doi || '').trim();
    const doiMatch = extractDoi(rawDoi) || extractDoi(fields.url || '');
    const doi = doiMatch || rawDoi.replace(/^https?:\/\/doi\.org\//i, '').trim() || null;

    const rawEprint = (fields.eprint || '').trim();
    const arxivMatch =
      extractArxiv(rawEprint) ||
      extractArxiv(fields.url || '') ||
      (rawEprint.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/)?.[1] ?? null);

    const yearRaw = (fields.year || '').trim();
    const extractedYr = extractYear(yearRaw);
    const year = extractedYr ? String(extractedYr) : yearRaw || null;

    const authors = splitBibtexAuthors(fields.author || fields.editor || '');
    const title = (fields.title || '').trim();
    const venue = (fields.journal || fields.booktitle || fields.institution || fields.publisher || '').trim() || null;

    entries.push({
      rawEntry,
      entryType,
      citeKey,
      fields,
      title,
      authors,
      year,
      venue,
      doi,
      arxivId: arxivMatch,
      url: (fields.url || '').trim() || null,
      parseErrors,
    });
  }
  return entries;
}

function surnameToken(name: string): string {
  const cleaned = (name || '').trim();
  const part = cleaned.includes(',') ? cleaned.split(',')[0].trim() : cleaned.split(/\s+/).pop() || '';
  return part.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function evaluateBibtexEntryAgainstCandidate(
  entry: ParsedBibtexEntry,
  candidate: RegistryCandidate | null,
  anyReachable = true
): VerifiedBibtexEntry {
  const discrepancies: BibtexDiscrepancy[] = [];
  const registry = candidate ? candidate.provider : 'None';
  const matchedTitle = candidate?.title || '';
  const declaredTitle = entry.title || '';
  const declaredYear = entry.year ? String(entry.year).trim() : null;
  const regYear = candidate?.year ? String(candidate.year).trim() : null;
  const declaredDoi = entry.doi ? entry.doi.trim() : null;
  const regDoi = candidate?.doi ? candidate.doi.trim() : null;
  const declaredAuthors = entry.authors;
  const regAuthors = candidate?.authors ?? [];
  const declaredVenue = entry.venue;
  const regVenue = candidate?.venue ?? null;

  const titleMatchScore =
    declaredTitle && matchedTitle
      ? Number(diceBigramSimilarity(declaredTitle, matchedTitle).toFixed(3))
      : matchedTitle && !declaredTitle
      ? 1.0
      : 0;

  let doiMatched: boolean | null = null;
  if (declaredDoi && regDoi) {
    doiMatched = declaredDoi.toLowerCase() === regDoi.toLowerCase();
    if (!doiMatched) {
      discrepancies.push({ field: 'doi', declared: declaredDoi, registry: regDoi, severity: 'error' });
    }
  }

  let yearMatched: boolean | null = null;
  if (declaredYear && regYear) {
    yearMatched = declaredYear === regYear;
    if (!yearMatched) {
      discrepancies.push({ field: 'year', declared: declaredYear, registry: regYear, severity: 'warning' });
    }
  }

  let authorMatched: boolean | null = null;
  if (declaredAuthors.length > 0 && regAuthors.length > 0) {
    const decSurnames = new Set(declaredAuthors.map(surnameToken).filter(Boolean));
    const regSurnames = new Set(regAuthors.map(surnameToken).filter(Boolean));
    authorMatched = Array.from(decSurnames).some((s) => regSurnames.has(s));
    if (!authorMatched) {
      discrepancies.push({
        field: 'author',
        declared: declaredAuthors.slice(0, 3).join('; '),
        registry: regAuthors.slice(0, 3).join('; '),
        severity: 'error',
      });
    }
  }

  if (declaredTitle && matchedTitle && titleMatchScore < 0.72) {
    discrepancies.push({
      field: 'title',
      declared: declaredTitle,
      registry: matchedTitle,
      severity: titleMatchScore >= 0.48 ? 'warning' : 'error',
    });
  }

  const venueMatchScore =
    declaredVenue && regVenue ? Number(diceBigramSimilarity(declaredVenue, regVenue).toFixed(3)) : null;
  const venueContains =
    declaredVenue && regVenue
      ? regVenue.toLowerCase().includes(declaredVenue.toLowerCase()) ||
        declaredVenue.toLowerCase().includes(regVenue.toLowerCase())
      : false;
  if (declaredVenue && regVenue && venueMatchScore !== null && venueMatchScore < 0.45 && !venueContains) {
    discrepancies.push({ field: 'venue', declared: declaredVenue, registry: regVenue, severity: 'warning' });
  }

  let status: VerificationStatus = 'Unverified';
  let bibliographicStatus: BibliographicState = 'Verification unavailable';
  if (
    candidate &&
    titleMatchScore >= 0.72 &&
    doiMatched !== false &&
    yearMatched !== false &&
    authorMatched !== false
  ) {
    status = 'Verified';
    bibliographicStatus = 'Bibliographic metadata verified';
  } else if (candidate && (titleMatchScore >= 0.48 || doiMatched === true)) {
    status = 'Needs review';
    bibliographicStatus = 'Bibliographic metadata verified';
  } else if (!anyReachable) {
    status = 'Needs review';
    bibliographicStatus = 'Verification unavailable';
  }

  const flags = [...entry.parseErrors];
  for (const d of discrepancies) {
    flags.push(`${d.field.toUpperCase()} mismatch: BibTeX has "${d.declared}", ${registry} reports "${d.registry}".`);
  }
  if (!anyReachable && !candidate) {
    flags.push('External bibliographic registries unreachable (offline/timeout).');
  } else if (status === 'Unverified' && discrepancies.length === 0) {
    flags.push('No matching record confirmed across Crossref, OpenAlex, Semantic Scholar, or arXiv.');
  }

  const verifiedMetadata = candidate
    ? {
        title: candidate.title,
        authors: regAuthors,
        year: candidate.year ?? undefined,
        venue: regVenue ?? undefined,
        doi: regDoi ?? declaredDoi ?? undefined,
        url: candidate.url,
        volume: candidate.volume,
        issue: candidate.issue,
        pages: candidate.pages,
        publisher: candidate.publisher,
        isbn: candidate.isbn,
        entryType: candidate.entryType,
        citationCount: candidate.citationCount,
        credibilityNote: regVenue
          ? `${registry} indexed (${regVenue})${candidate.citationCount !== undefined ? ` · ${candidate.citationCount} citations` : ''}`
          : `${registry} record matched`,
      }
    : null;

  return {
    id: `bib_${entry.citeKey}`,
    citeKey: entry.citeKey,
    entryType: entry.entryType,
    rawReference: entry.rawEntry,
    declared: {
      title: declaredTitle,
      authors: declaredAuthors,
      year: declaredYear,
      venue: declaredVenue,
      doi: declaredDoi,
      arxivId: entry.arxivId,
      url: entry.url,
    },
    status,
    bibliographicStatus,
    matchedProvider: registry,
    titleMatchScore,
    doiMatched,
    yearMatched,
    authorMatched,
    venueMatchScore,
    discrepancies,
    verifiedMetadata,
    matchedTitle: matchedTitle || null,
    authors: regAuthors.length > 0 ? regAuthors : declaredAuthors,
    year: regYear || declaredYear,
    venue: regVenue || declaredVenue,
    doi: regDoi || declaredDoi,
    url: candidate?.url || entry.url || '',
    flags,
  };
}

export async function verifyBibtexEntries(
  bibtexText: string,
  includeUnverified = false
): Promise<BibtexVerificationReport> {
  const syntax = validateBibtexSyntax(bibtexText);
  const parsed = parseBibtexEntries(bibtexText).slice(0, 25);
  if (parsed.length === 0) {
    return {
      syntax,
      summary: { totalEntries: 0, verifiedCount: 0, needsReviewCount: 0, unverifiedCount: 0, discrepancyCount: 0 },
      entries: [],
      correctedBibtex: exportBibtexCollection([], includeUnverified),
    };
  }

  const verifiedEntries = await Promise.all(
    parsed.map(async (entry) => {
      let candidate: RegistryCandidate | null = null;
      let anyReachable = false;

      if (entry.doi) {
        const crDoi = await queryCrossrefByDoi(entry.doi);
        anyReachable = anyReachable || crDoi.reachable;
        candidate = crDoi.record;
      }
      if (!candidate && entry.arxivId) {
        const axId = await queryArxiv(entry.arxivId, true);
        anyReachable = anyReachable || axId.reachable;
        candidate = axId.record;
      }
      const queryTitle = entry.title.trim();
      const acceptableMatch = (rec: RegistryCandidate | null) =>
        Boolean(rec && rec.title && (!queryTitle || diceBigramSimilarity(queryTitle, rec.title) >= 0.45));

      if (!candidate && queryTitle.length >= 6) {
        const cr = await queryCrossrefSearch(queryTitle);
        anyReachable = anyReachable || cr.reachable;
        if (acceptableMatch(cr.record)) candidate = cr.record;

        if (!candidate) {
          const oa = await queryOpenAlex(queryTitle);
          anyReachable = anyReachable || oa.reachable;
          if (acceptableMatch(oa.record)) candidate = oa.record;
        }
        if (!candidate) {
          const s2 = await querySemanticScholar(queryTitle);
          anyReachable = anyReachable || s2.reachable;
          if (acceptableMatch(s2.record)) candidate = s2.record;
        }
        if (!candidate) {
          const ax = await queryArxiv(queryTitle, false);
          anyReachable = anyReachable || ax.reachable;
          if (acceptableMatch(ax.record)) candidate = ax.record;
        }
      }

      return evaluateBibtexEntryAgainstCandidate(entry, candidate, anyReachable);
    })
  );

  const correctedBibtex = exportBibtexCollection(verifiedEntries, includeUnverified);
  return {
    syntax,
    summary: {
      totalEntries: verifiedEntries.length,
      verifiedCount: verifiedEntries.filter((e) => e.status === 'Verified').length,
      needsReviewCount: verifiedEntries.filter((e) => e.status === 'Needs review').length,
      unverifiedCount: verifiedEntries.filter((e) => e.status === 'Unverified').length,
      discrepancyCount: verifiedEntries.reduce((acc, e) => acc + e.discrepancies.length, 0),
    },
    entries: verifiedEntries,
    correctedBibtex,
  };
}

