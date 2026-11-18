export interface CorpusDocument {
  id: string;
  title: string;
  source: string;
  authors?: string;
  year?: string;
  url?: string;
  text: string;
}

export type MatchCategory =
  | 'Exact Match'
  | 'Paraphrase / Near Match'
  | 'Semantic Overlap'
  | 'Properly Quoted Material'
  | 'Common Academic Terminology'
  | 'Potentially Uncited Passage';

export interface PassageMatch {
  id: string;
  inputSentence: string;
  matchedSourceTitle: string;
  matchedSourceType: string;
  matchedSourceAuthors?: string;
  matchedSourceYear?: string;
  matchedSourceUrl?: string;
  matchedExcerpt: string;
  exactScore: number;
  ngramScore: number;
  fuzzyScore: number;
  tfidfCosine: number;
  bm25Score: number;
  semanticScore: number;
  combinedScore: number;
  category: MatchCategory;
  hasCitation: boolean;
  isQuoted: boolean;
  explanation: string;
}

export interface SimilarityAnalysisResult {
  overallSimilarityPercent: number;
  exactMatchPercent: number;
  paraphrasePercent: number;
  semanticOverlapPercent: number;
  quotedPercent: number;
  uncitedFlagCount: number;
  corpusCoverage: {
    indexedDocuments: number;
    indexedChunks: number;
    arxivAbstractsQueried: number;
    openAlexAbstractsQueried: number;
    limitationNotice: string;
  };
  matches: PassageMatch[];
  algorithmBreakdown: {
    meanExact: number;
    meanNgramJaccard: number;
    meanFuzzyDice: number;
    meanTfidfCosine: number;
    meanBm25Normalized: number;
    meanSemanticOverlap: number;
  };
}

export const BUILTIN_REFERENCE_CORPUS: CorpusDocument[] = [
  {
    id: 'ref_fedavg_2017',
    title: 'Communication-Efficient Learning of Deep Networks from Decentralized Data (McMahan et al., AISTATS 2017)',
    source: 'Open-Access arXiv:1602.05629',
    authors: 'H. B. McMahan, E. Moore, D. Ramage, S. Hampson, B. A. y Arcas',
    year: '2017',
    url: 'https://arxiv.org/abs/1602.05629',
    text: 'Modern mobile devices have access to a wealth of data suitable for learning models, which in turn can greatly improve the user experience on the device. We advocate an alternative that leaves the training data distributed on the mobile devices, and learns a shared model by aggregating locally-computed updates. We term this decentralized approach Federated Learning.',
  },
  {
    id: 'ref_vaswani_2017',
    title: 'Attention Is All You Need (Vaswani et al., NeurIPS 2017)',
    source: 'Open-Access arXiv:1706.03762',
    authors: 'A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. Gomez, L. Kaiser, I. Polosukhin',
    year: '2017',
    url: 'https://arxiv.org/abs/1706.03762',
    text: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
  },
  {
    id: 'ref_splade_2021',
    title: 'SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking (Formal et al., SIGIR 2021)',
    source: 'Open-Access arXiv:2107.05720',
    authors: 'T. Formal, B. Piwowarski, S. Clinchant',
    year: '2021',
    url: 'https://arxiv.org/abs/2107.05720',
    text: 'Learned sparse representations have recently emerged as an attractive alternative to dense bi-encoders for first-stage retrieval. Sparse models inherit desirable properties from inverted index pipelines such as exact term matching while bridging vocabulary mismatch via contextual term expansion.',
  },
  {
    id: 'ref_resnet_2016',
    title: 'Deep Residual Learning for Image Recognition (He et al., CVPR 2016)',
    source: 'Open-Access arXiv:1512.03385',
    authors: 'K. He, X. Zhang, S. Ren, J. Sun',
    year: '2016',
    url: 'https://arxiv.org/abs/1512.03385',
    text: 'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs.',
  },
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
  'this', 'these', 'those', 'it', 'its', 'which', 'we', 'our', 'can', 'may', 'have',
  'has', 'had', 'not', 'also', 'such', 'into', 'than', 'using', 'used', 'based',
]);

const ACADEMIC_BOILERPLATE_PHRASES = [
  'in recent years',
  'experimental results show',
  'future work will',
  'to the best of our knowledge',
  'widely used in',
  'state of the art',
  'plays a crucial role',
  'has attracted considerable attention',
];

const SYNONYM_CANONICAL: Record<string, string> = {
  utilize: 'use',
  utilized: 'use',
  employs: 'use',
  employed: 'use',
  evaluate: 'assess',
  evaluated: 'assess',
  demonstrates: 'show',
  demonstrate: 'show',
  propose: 'present',
  proposed: 'present',
  novel: 'new',
  methodology: 'method',
  architecture: 'structure',
  framework: 'system',
  decentralized: 'distributed',
  federated: 'distributed',
  ecg: 'electrocardiogram',
  arrhythmia: 'cardiac',
  retrieval: 'search',
  dense: 'neural',
  lexical: 'keyword',
  sparse: 'inverted',
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => SYNONYM_CANONICAL[t] ?? t);
}

export function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < n) {
    if (tokens.length > 0) out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function diceBigramSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().replace(/\s+/g, ' ').trim();
  const s2 = b.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams1 = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    bigrams1.set(bg, (bigrams1.get(bg) ?? 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = bigrams1.get(bg) ?? 0;
    if (count > 0) {
      bigrams1.set(bg, count - 1);
      matches++;
    }
  }
  return (2 * matches) / (s1.length - 1 + (s2.length - 1));
}

export function computeTfidfCosine(queryTokens: string[], docTokens: string[], idf: Map<string, number>): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const qTf = new Map<string, number>();
  const dTf = new Map<string, number>();
  for (const t of queryTokens) qTf.set(t, (qTf.get(t) ?? 0) + 1);
  for (const t of docTokens) dTf.set(t, (dTf.get(t) ?? 0) + 1);

  let dot = 0;
  let qNorm = 0;
  let dNorm = 0;

  for (const [term, tf] of qTf.entries()) {
    const w = tf * (idf.get(term) ?? 1.0);
    qNorm += w * w;
    const dCount = dTf.get(term) ?? 0;
    if (dCount > 0) {
      const dw = dCount * (idf.get(term) ?? 1.0);
      dot += w * dw;
    }
  }
  for (const [term, tf] of dTf.entries()) {
    const w = tf * (idf.get(term) ?? 1.0);
    dNorm += w * w;
  }

  const denom = Math.sqrt(qNorm) * Math.sqrt(dNorm);
  return denom === 0 ? 0 : dot / denom;
}

export function computeBm25(
  queryTokens: string[],
  docTokens: string[],
  avgDocLen: number,
  idf: Map<string, number>,
  k1 = 1.5,
  b = 0.75
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const dTf = new Map<string, number>();
  for (const t of docTokens) dTf.set(t, (dTf.get(t) ?? 0) + 1);

  let score = 0;
  const uniqueQ = new Set(queryTokens);
  for (const term of uniqueQ) {
    const tf = dTf.get(term) ?? 0;
    if (tf === 0) continue;
    const termIdf = idf.get(term) ?? 0.5;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docTokens.length / Math.max(avgDocLen, 1)));
    score += termIdf * (numerator / denominator);
  }
  return 1 - Math.exp(-score / Math.max(uniqueQ.size, 1));
}

export function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(\\])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 6);
}

export async function fetchArxivRelatedAbstracts(queryText: string, maxResults = 5): Promise<CorpusDocument[]> {
  try {
    const keywords = contentTokens(queryText).slice(0, 6).join('+AND+');
    if (!keywords) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(keywords)}&start=0&max_results=${maxResults}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    const entries = xml.split('<entry>').slice(1);
    const docs: CorpusDocument[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const publishedMatch = entry.match(/<published>(\d{4})/);
      const authors = Array.from(entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
      if (titleMatch && summaryMatch) {
        docs.push({
          id: `arxiv_${i}`,
          title: titleMatch[1].replace(/\s+/g, ' ').trim(),
          source: 'arXiv Open Access',
          authors: authors.slice(0, 4).join(', '),
          year: publishedMatch ? publishedMatch[1] : undefined,
          url: idMatch ? idMatch[1].trim() : undefined,
          text: summaryMatch[1].replace(/\s+/g, ' ').trim(),
        });
      }
    }
    return docs;
  } catch {
    return [];
  }
}

export function analyzeTextSimilarity(
  inputText: string,
  corpus: CorpusDocument[],
  arxivCount = 0,
  openAlexCount = 0
): SimilarityAnalysisResult {
  const inputSentences = splitIntoSentences(inputText);
  if (inputSentences.length === 0) {
    return {
      overallSimilarityPercent: 0,
      exactMatchPercent: 0,
      paraphrasePercent: 0,
      semanticOverlapPercent: 0,
      quotedPercent: 0,
      uncitedFlagCount: 0,
      corpusCoverage: {
        indexedDocuments: corpus.length,
        indexedChunks: 0,
        arxivAbstractsQueried: arxivCount,
        openAlexAbstractsQueried: openAlexCount,
        limitationNotice:
          'Similarity computed against indexed workspace manuscripts, built-in open-access corpus, and live arXiv/OpenAlex abstracts. Not equivalent to proprietary publisher databases.',
      },
      matches: [],
      algorithmBreakdown: {
        meanExact: 0,
        meanNgramJaccard: 0,
        meanFuzzyDice: 0,
        meanTfidfCosine: 0,
        meanBm25Normalized: 0,
        meanSemanticOverlap: 0,
      },
    };
  }

  const corpusUnits: Array<{
    doc: CorpusDocument;
    excerpt: string;
    rawTokens: string[];
    semTokens: string[];
    trigrams: Set<string>;
  }> = [];

  for (const doc of corpus) {
    for (const sent of splitIntoSentences(doc.text)) {
      const rawT = tokenize(sent);
      const semT = contentTokens(sent);
      corpusUnits.push({
        doc,
        excerpt: sent,
        rawTokens: rawT,
        semTokens: semT,
        trigrams: ngrams(rawT, 3),
      });
    }
    // Also include paragraph-level units for multi-sentence paraphrase sensitivity
    const paragraphs = doc.text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 18);
    for (const para of paragraphs) {
      const rawT = tokenize(para);
      const semT = contentTokens(para);
      corpusUnits.push({
        doc,
        excerpt: para.slice(0, 320),
        rawTokens: rawT,
        semTokens: semT,
        trigrams: ngrams(rawT, 3),
      });
    }
  }

  const docFreq = new Map<string, number>();
  const allTokenSets = [
    ...corpusUnits.map((c) => new Set(c.semTokens)),
    ...inputSentences.map((s) => new Set(contentTokens(s))),
  ];
  for (const tSet of allTokenSets) {
    for (const t of tSet) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }
  const N = Math.max(allTokenSets.length, 1);
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq.entries()) {
    idf.set(term, Math.log((N + 1) / (df + 0.5)) + 1);
  }
  const avgLen = corpusUnits.reduce((sum, c) => sum + c.semTokens.length, 0) / Math.max(corpusUnits.length, 1);

  const matches: PassageMatch[] = [];
  let sumExact = 0;
  let sumNgram = 0;
  let sumFuzzy = 0;
  let sumTfidf = 0;
  let sumBm25 = 0;
  let sumSem = 0;
  let exactHits = 0;
  let paraphraseHits = 0;
  let semanticHits = 0;
  let quotedHits = 0;
  let uncitedFlags = 0;

  for (let idx = 0; idx < inputSentences.length; idx++) {
    const sent = inputSentences[idx];
    const normInput = sent.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const rawT = tokenize(sent);
    const semT = contentTokens(sent);
    const tri = ngrams(rawT, 3);

    const hasCitation = /\[\d+(?:\s*[-,]\s*\d+)*\]|\([A-Z][a-zA-Z-]+.*?(?:19|20)\d{2}\)|\\cite/.test(sent);
    const isQuoted = /"[^"]{15,}"|“[^”]{15,}”/.test(sent);
    const isBoilerplate = ACADEMIC_BOILERPLATE_PHRASES.some((p) => normInput.includes(p));

    let best: PassageMatch | null = null;

    for (const target of corpusUnits) {
      const normTarget = target.excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const exactScore =
        normInput === normTarget || normTarget.includes(normInput) || (normInput.length > 40 && normInput.includes(normTarget))
          ? 1
          : 0;
      const ngramScore = jaccardSimilarity(tri, target.trigrams);
      const fuzzyScore = diceBigramSimilarity(sent, target.excerpt);
      const tfidfCosine = computeTfidfCosine(semT, target.semTokens, idf);
      const bm25Score = computeBm25(semT, target.semTokens, avgLen, idf);
      const semanticScore = jaccardSimilarity(new Set(semT), new Set(target.semTokens));

      const combinedScore = Math.min(
        1,
        exactScore * 0.4 + ngramScore * 0.2 + fuzzyScore * 0.1 + tfidfCosine * 0.15 + semanticScore * 0.1 + bm25Score * 0.05
      );

      if (!best || combinedScore > best.combinedScore) {
        let category: MatchCategory = 'Common Academic Terminology';
        if (isQuoted && combinedScore >= 0.25) {
          category = 'Properly Quoted Material';
        } else if (exactScore >= 0.9 || ngramScore >= 0.55) {
          category = hasCitation ? 'Exact Match' : 'Potentially Uncited Passage';
        } else if (fuzzyScore >= 0.55 && semanticScore >= 0.35 && exactScore < 0.9) {
          category = hasCitation ? 'Paraphrase / Near Match' : 'Potentially Uncited Passage';
        } else if (combinedScore >= 0.26 || semanticScore >= 0.32 || tfidfCosine >= 0.38) {
          category = isBoilerplate
            ? 'Common Academic Terminology'
            : hasCitation
            ? 'Semantic Overlap'
            : 'Potentially Uncited Passage';
        }

        const explanation =
          category === 'Exact Match'
            ? 'High contiguous n-gram / verbatim match detected with an accompanying in-text citation.'
            : category === 'Paraphrase / Near Match'
            ? 'Close structural rephrasing with elevated Dice bigram and canonical concept similarity.'
            : category === 'Properly Quoted Material'
            ? 'Passage uses explicit quotation marks matching source phrasing.'
            : category === 'Potentially Uncited Passage'
            ? 'Elevated lexical, paraphrase, or conceptual overlap without a detected in-text citation in the sentence.'
            : category === 'Semantic Overlap'
            ? 'Shared topical terminology and TF-IDF concept alignment with indexed literature.'
            : 'Standard academic phrasing or common technical terminology.';

        best = {
          id: `pm_${idx + 1}`,
          inputSentence: sent,
          matchedSourceTitle: target.doc.title,
          matchedSourceType: target.doc.source,
          matchedSourceAuthors: target.doc.authors,
          matchedSourceYear: target.doc.year,
          matchedSourceUrl: target.doc.url,
          matchedExcerpt: target.excerpt,
          exactScore: Number(exactScore.toFixed(3)),
          ngramScore: Number(ngramScore.toFixed(3)),
          fuzzyScore: Number(fuzzyScore.toFixed(3)),
          tfidfCosine: Number(tfidfCosine.toFixed(3)),
          bm25Score: Number(bm25Score.toFixed(3)),
          semanticScore: Number(semanticScore.toFixed(3)),
          combinedScore: Number(combinedScore.toFixed(3)),
          category,
          hasCitation,
          isQuoted,
          explanation,
        };
      }
    }

    if (best && best.combinedScore >= 0.22) {
      matches.push(best);
      sumExact += best.exactScore;
      sumNgram += best.ngramScore;
      sumFuzzy += best.fuzzyScore;
      sumTfidf += best.tfidfCosine;
      sumBm25 += best.bm25Score;
      sumSem += best.semanticScore;

      if (best.category === 'Properly Quoted Material') quotedHits++;
      else if (best.category === 'Exact Match') exactHits++;
      else if (best.category === 'Paraphrase / Near Match') paraphraseHits++;
      else if (best.category === 'Potentially Uncited Passage') {
        uncitedFlags++;
        if (best.exactScore >= 0.8) exactHits++;
        else if (best.fuzzyScore >= 0.55) paraphraseHits++;
        else semanticHits++;
      } else if (best.category === 'Semantic Overlap') semanticHits++;
    }
  }

  const total = inputSentences.length;
  const weightedRatio =
    matches.reduce((acc, m) => acc + (m.category === 'Common Academic Terminology' ? 0.15 * m.combinedScore : m.combinedScore), 0) /
    total;
  const divisor = Math.max(matches.length, 1);

  return {
    overallSimilarityPercent: Number(Math.min(100, weightedRatio * 100).toFixed(1)),
    exactMatchPercent: Number(((exactHits / total) * 100).toFixed(1)),
    paraphrasePercent: Number(((paraphraseHits / total) * 100).toFixed(1)),
    semanticOverlapPercent: Number(((semanticHits / total) * 100).toFixed(1)),
    quotedPercent: Number(((quotedHits / total) * 100).toFixed(1)),
    uncitedFlagCount: uncitedFlags,
    corpusCoverage: {
      indexedDocuments: corpus.length,
      indexedChunks: corpusUnits.length,
      arxivAbstractsQueried: arxivCount,
      openAlexAbstractsQueried: openAlexCount,
      limitationNotice:
        'Similarity is measured against your workspace corpus, pgvector/sentence chunks, built-in open-access research corpus, and live arXiv abstracts. This engine does not access proprietary publisher databases (e.g., Turnitin/iThenticate).',
    },
    matches: matches.sort((a, b) => b.combinedScore - a.combinedScore),
    algorithmBreakdown: {
      meanExact: Number((sumExact / divisor).toFixed(3)),
      meanNgramJaccard: Number((sumNgram / divisor).toFixed(3)),
      meanFuzzyDice: Number((sumFuzzy / divisor).toFixed(3)),
      meanTfidfCosine: Number((sumTfidf / divisor).toFixed(3)),
      meanBm25Normalized: Number((sumBm25 / divisor).toFixed(3)),
      meanSemanticOverlap: Number((sumSem / divisor).toFixed(3)),
    },
  };
}
