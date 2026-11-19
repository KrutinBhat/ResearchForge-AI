import math
import re
from collections import Counter
from typing import Any, Dict, List, Set

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "as", "is", "are", "was", "were", "be", "been", "being", "that",
    "this", "these", "those", "it", "its", "which", "we", "our", "can", "may", "have",
    "has", "had", "not", "also", "such", "into", "than", "using", "used", "based",
}

SYNONYM_MAP = {
    "utilize": "use", "utilized": "use", "employs": "use", "evaluate": "assess",
    "evaluated": "assess", "demonstrates": "show", "propose": "present",
    "proposed": "present", "novel": "new", "methodology": "method",
    "architecture": "structure", "framework": "system",
    "decentralized": "distributed", "federated": "distributed",
}

BUILTIN_CORPUS = [
    {
        "id": "ref_fedavg_2017",
        "title": "Communication-Efficient Learning of Deep Networks from Decentralized Data",
        "authors": "McMahan, B., Moore, E., Ramage, D., Hampson, S., & y Arcas, B. A.",
        "year": "2017",
        "url": "https://arxiv.org/abs/1602.05629",
        "source": "Open-Access arXiv:1602.05629",
        "text": (
            "Modern mobile devices have access to a wealth of data suitable for learning models, "
            "which in turn can greatly improve the user experience on the device. We advocate an "
            "alternative that leaves the training data distributed on the mobile devices, and learns "
            "a shared model by aggregating locally-computed updates."
        ),
    },
    {
        "id": "ref_vaswani_2017",
        "title": "Attention Is All You Need",
        "authors": "Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., et al.",
        "year": "2017",
        "url": "https://arxiv.org/abs/1706.03762",
        "source": "Open-Access arXiv:1706.03762",
        "text": (
            "We propose a new simple network architecture, the Transformer, based solely on attention "
            "mechanisms, dispensing with recurrence and convolutions entirely."
        ),
    },
    {
        "id": "ref_devlin_2018",
        "title": "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        "authors": "Devlin, J., Chang, M.-W., Lee, K., & Toutanova, K.",
        "year": "2019",
        "url": "https://arxiv.org/abs/1810.04805",
        "source": "Open-Access arXiv:1810.04805",
        "text": (
            "Unlike recent language representation models, BERT is designed to pre-train deep bidirectional "
            "representations from unlabeled text by jointly conditioning on both left and right context in all layers."
        ),
    },
]

_EMBEDDER = None
_EMBEDDER_FAILED = False


def _get_sentence_embedder():
    global _EMBEDDER, _EMBEDDER_FAILED
    if _EMBEDDER_FAILED:
        return None
    if _EMBEDDER is not None:
        return _EMBEDDER
    try:
        from sentence_transformers import SentenceTransformer

        _EMBEDDER = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        return _EMBEDDER
    except Exception:
        _EMBEDDER_FAILED = True
        return None


def compute_semantic_embeddings(texts: List[str]) -> List[List[float]] | None:
    model = _get_sentence_embedder()
    if model is None or not texts:
        return None
    try:
        vecs = model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vecs]
    except Exception:
        return None


def query_pgvector_similar_chunks(db, user_id: str, query_text: str, exclude_document_id: str | None = None, limit: int = 8) -> List[Dict[str, Any]]:
    """Query native pgvector cosine distance on PostgreSQL when embeddings exist."""
    from ..models.entities import CorpusChunk

    vecs = compute_semantic_embeddings([query_text[:1500]])
    if not vecs or not vecs[0]:
        return []
    bind = db.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return []

    try:
        q = db.query(CorpusChunk).filter(CorpusChunk.user_id == user_id, CorpusChunk.embedding.isnot(None))
        if exclude_document_id:
            q = q.filter(CorpusChunk.document_id != exclude_document_id)
        rows = q.order_by(CorpusChunk.embedding.cosine_distance(vecs[0])).limit(limit).all()
        return [
            {
                "id": r.document_id or r.id,
                "title": r.title,
                "authors": r.authors,
                "year": r.year,
                "url": r.url,
                "source": "Workspace pgvector Chunk",
                "text": r.content,
            }
            for r in rows
        ]
    except Exception:
        return []


def tokenize(text: str) -> List[str]:
    cleaned = re.sub(r"[^a-z0-9\s-]", " ", text.lower())
    return [t for t in cleaned.split() if len(t) > 1]


def content_tokens(text: str) -> List[str]:
    return [SYNONYM_MAP.get(t, t) for t in tokenize(text) if t not in STOPWORDS]


def ngrams(tokens: List[str], n: int) -> Set[str]:
    if len(tokens) < n:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def jaccard(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def dice_bigram_similarity(a: str, b: str) -> float:
    s1 = re.sub(r"\s+", " ", a.lower().strip())
    s2 = re.sub(r"\s+", " ", b.lower().strip())
    if not s1 or not s2:
        return 0.0
    if s1 == s2:
        return 1.0
    if len(s1) < 2 or len(s2) < 2:
        return 0.0
    bg1 = Counter(s1[i : i + 2] for i in range(len(s1) - 1))
    matches = 0
    for i in range(len(s2) - 1):
        bg = s2[i : i + 2]
        if bg1[bg] > 0:
            bg1[bg] -= 1
            matches += 1
    return (2.0 * matches) / (len(s1) - 1 + len(s2) - 1)


def split_sentences(text: str) -> List[str]:
    normalized = re.sub(r"\n+", " ", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"(\[])", normalized)
    return [p.strip() for p in parts if len(p.strip().split()) >= 6]


def split_paragraphs(text: str) -> List[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if len(p.strip().split()) >= 15]


def tfidf_cosine(q_tokens: List[str], d_tokens: List[str], idf: Dict[str, float]) -> float:
    if not q_tokens or not d_tokens:
        return 0.0
    q_tf = Counter(q_tokens)
    d_tf = Counter(d_tokens)
    dot = sum(tf * idf.get(t, 1.0) * d_tf.get(t, 0) * idf.get(t, 1.0) for t, tf in q_tf.items())
    q_norm = math.sqrt(sum((tf * idf.get(t, 1.0)) ** 2 for t, tf in q_tf.items()))
    d_norm = math.sqrt(sum((tf * idf.get(t, 1.0)) ** 2 for t, tf in d_tf.items()))
    return dot / (q_norm * d_norm) if q_norm and d_norm else 0.0


def bm25_score(q_tokens: List[str], d_tokens: List[str], avg_len: float, idf: Dict[str, float], k1: float = 1.5, b: float = 0.75) -> float:
    if not q_tokens or not d_tokens:
        return 0.0
    d_tf = Counter(d_tokens)
    uniq_q = set(q_tokens)
    raw = 0.0
    for term in uniq_q:
        tf = d_tf.get(term, 0)
        if tf == 0:
            continue
        term_idf = idf.get(term, 0.5)
        raw += term_idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len(d_tokens) / max(avg_len, 1.0)))))
    return 1.0 - math.exp(-raw / max(len(uniq_q), 1))


def _dense_cosine(u: List[float], v: List[float]) -> float:
    return max(0.0, min(1.0, sum(a * b for a, b in zip(u, v))))


def analyze_text_similarity(input_text: str, corpus: List[Dict[str, Any]], arxiv_count: int = 0) -> Dict[str, Any]:
    input_sents = split_sentences(input_text)
    input_paras = split_paragraphs(input_text)
    if not input_sents:
        return {
            "overallSimilarityPercent": 0.0,
            "exactMatchPercent": 0.0,
            "nearMatchPercent": 0.0,
            "paraphrasePercent": 0.0,
            "semanticOverlapPercent": 0.0,
            "quotedPercent": 0.0,
            "uncitedFlagCount": 0,
            "engineMethod": "tfidf+bm25+ngram",
            "corpusCoverage": {
                "indexedDocuments": len(corpus),
                "indexedChunks": 0,
                "arxivAbstractsQueried": arxiv_count,
                "limitationNotice": (
                    "Similarity measured against workspace documents, pgvector chunks, open-access baseline papers, and arXiv abstracts; "
                    "not equivalent to proprietary Turnitin/CrossCheck databases."
                ),
            },
            "algorithmBreakdown": {
                "meanExact": 0.0,
                "meanNgramJaccard": 0.0,
                "meanFuzzyDice": 0.0,
                "meanTfidfCosine": 0.0,
                "meanBm25Normalized": 0.0,
                "meanSemanticOverlap": 0.0,
            },
            "paragraphMatches": [],
            "matches": [],
        }

    corpus_sents = []
    for doc in corpus:
        for s in split_sentences(doc["text"]):
            raw_t = tokenize(s)
            sem_t = content_tokens(s)
            corpus_sents.append({"doc": doc, "sentence": s, "raw_t": raw_t, "sem_t": sem_t, "tri": ngrams(raw_t, 3)})

    dense_in = compute_semantic_embeddings(input_sents)
    dense_corpus = compute_semantic_embeddings([c["sentence"] for c in corpus_sents]) if dense_in is not None else None
    engine_method = "sentence-transformers+pgvector+bm25" if (dense_in is not None and dense_corpus is not None) else "tfidf+bm25+ngram"

    all_sets = [set(c["sem_t"]) for c in corpus_sents] + [set(content_tokens(s)) for s in input_sents]
    df = Counter()
    for tset in all_sets:
        for t in tset:
            df[t] += 1
    n_docs = max(len(all_sets), 1)
    idf = {t: math.log((n_docs + 1) / (freq + 0.5)) + 1.0 for t, freq in df.items()}
    avg_len = sum(len(c["sem_t"]) for c in corpus_sents) / max(len(corpus_sents), 1)

    matches = []
    uncited_flags = 0
    exact_hits = 0
    near_hits = 0
    semantic_hits = 0
    quoted_hits = 0

    for idx, sent in enumerate(input_sents):
        norm_in = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", sent.lower())).strip()
        raw_t = tokenize(sent)
        sem_t = content_tokens(sent)
        tri = ngrams(raw_t, 3)
        has_citation = bool(re.search(r"\[\d+(?:\s*[-,]\s*\d+)*\]|\([A-Z][a-zA-Z-]+.*?(?:19|20)\d{2}\)|\\cite", sent))
        is_quoted = bool(re.search(r'"[^"]{15,}"|“[^”]{15,}”', sent))

        best = None
        for t_idx, target in enumerate(corpus_sents):
            norm_tgt = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", target["sentence"].lower())).strip()
            exact = 1.0 if (norm_in == norm_tgt or norm_in in norm_tgt) else 0.0
            ng = jaccard(tri, target["tri"])
            fz = dice_bigram_similarity(sent, target["sentence"])
            tf = tfidf_cosine(sem_t, target["sem_t"], idf)
            bm = bm25_score(sem_t, target["sem_t"], avg_len, idf)
            lex_sem = jaccard(set(sem_t), set(target["sem_t"]))
            dense_sem = _dense_cosine(dense_in[idx], dense_corpus[t_idx]) if (dense_in and dense_corpus) else lex_sem
            sem = max(lex_sem, dense_sem)
            combined = min(1.0, exact * 0.40 + ng * 0.18 + fz * 0.10 + tf * 0.12 + sem * 0.15 + bm * 0.05)

            if best is None or combined > best["combinedScore"]:
                if is_quoted and combined >= 0.28:
                    cat = "Properly Quoted Material"
                elif exact >= 0.9:
                    cat = "Exact Match" if has_citation else "Potentially Uncited Passage"
                elif ng >= 0.45 or fz >= 0.65:
                    cat = "Paraphrase / Near Match" if has_citation else "Potentially Uncited Passage"
                elif combined >= 0.28 or sem >= 0.42 or tf >= 0.38:
                    cat = "Semantic Overlap" if has_citation else "Potentially Uncited Passage"
                else:
                    cat = "Common Academic Terminology"

                best = {
                    "id": f"pm_{idx + 1}",
                    "inputSentence": sent,
                    "matchedSourceTitle": target["doc"]["title"],
                    "matchedSourceAuthors": target["doc"].get("authors", ""),
                    "matchedSourceYear": target["doc"].get("year", ""),
                    "matchedSourceUrl": target["doc"].get("url", ""),
                    "matchedSourceType": target["doc"].get("source", "Corpus"),
                    "matchedExcerpt": target["sentence"],
                    "exactScore": round(exact, 3),
                    "ngramScore": round(ng, 3),
                    "fuzzyScore": round(fz, 3),
                    "tfidfCosine": round(tf, 3),
                    "bm25Score": round(bm, 3),
                    "semanticScore": round(sem, 3),
                    "combinedScore": round(combined, 3),
                    "category": cat,
                    "hasCitation": has_citation,
                    "explanation": (
                        f"Classification '{cat}' driven by exact={round(exact, 2)}, 3-gram={round(ng, 2)}, "
                        f"TF-IDF={round(tf, 2)}, BM25={round(bm, 2)}, semantic={round(sem, 2)}."
                    ),
                }

        if best and best["combinedScore"] >= 0.22:
            matches.append(best)
            if best["category"] == "Properly Quoted Material":
                quoted_hits += 1
            elif best["category"] == "Exact Match":
                exact_hits += 1
            elif best["category"] == "Paraphrase / Near Match":
                near_hits += 1
            elif best["category"] == "Potentially Uncited Passage":
                uncited_flags += 1
                if best["exactScore"] >= 0.8:
                    exact_hits += 1
                else:
                    semantic_hits += 1
            elif best["category"] == "Semantic Overlap":
                semantic_hits += 1

    para_matches = []
    for p_idx, para in enumerate(input_paras[:20]):
        p_tokens = content_tokens(para)
        best_p = None
        for doc in corpus:
            score = bm25_score(p_tokens, content_tokens(doc["text"]), max(len(p_tokens), 20), idf)
            if best_p is None or score > best_p["score"]:
                best_p = {
                    "paragraphIndex": p_idx + 1,
                    "excerpt": para[:200],
                    "matchedSourceTitle": doc["title"],
                    "matchedSourceUrl": doc.get("url", ""),
                    "score": round(score, 3),
                }
        if best_p and best_p["score"] >= 0.25:
            para_matches.append(best_p)

    total = len(input_sents)
    weighted = sum(
        0.15 * m["combinedScore"] if m["category"] == "Common Academic Terminology" else m["combinedScore"]
        for m in matches
    ) / total

    denom = max(len(matches), 1)
    algorithm_breakdown = {
        "meanExact": round(sum(m["exactScore"] for m in matches) / denom, 3) if matches else 0.0,
        "meanNgramJaccard": round(sum(m["ngramScore"] for m in matches) / denom, 3) if matches else 0.0,
        "meanFuzzyDice": round(sum(m["fuzzyScore"] for m in matches) / denom, 3) if matches else 0.0,
        "meanTfidfCosine": round(sum(m["tfidfCosine"] for m in matches) / denom, 3) if matches else 0.0,
        "meanBm25Normalized": round(sum(m["bm25Score"] for m in matches) / denom, 3) if matches else 0.0,
        "meanSemanticOverlap": round(sum(m["semanticScore"] for m in matches) / denom, 3) if matches else 0.0,
    }
    near_pct = round((near_hits / total) * 100.0, 1)

    return {
        "overallSimilarityPercent": round(min(100.0, weighted * 100.0), 1),
        "exactMatchPercent": round((exact_hits / total) * 100.0, 1),
        "nearMatchPercent": near_pct,
        "paraphrasePercent": near_pct,
        "semanticOverlapPercent": round((semantic_hits / total) * 100.0, 1),
        "quotedPercent": round((quoted_hits / total) * 100.0, 1),
        "uncitedFlagCount": uncited_flags,
        "engineMethod": engine_method,
        "corpusCoverage": {
            "indexedDocuments": len(corpus),
            "indexedChunks": len(corpus_sents),
            "arxivAbstractsQueried": arxiv_count,
            "limitationNotice": (
                "Similarity is measured against workspace documents, pgvector chunks, built-in open-access references, and live arXiv abstracts; "
                "not equivalent to proprietary publisher databases."
            ),
        },
        "algorithmBreakdown": algorithm_breakdown,
        "paragraphMatches": sorted(para_matches, key=lambda x: x["score"], reverse=True)[:10],
        "matches": sorted(matches, key=lambda x: x["combinedScore"], reverse=True),
    }
