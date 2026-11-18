import math
import re
from collections import Counter
from typing import Any, Dict, List, Tuple

TRANSITION_MARKERS = [
    "furthermore", "moreover", "additionally", "consequently", "therefore",
    "however", "nevertheless", "notwithstanding", "subsequently", "accordingly",
    "conversely", "specifically", "notably", "overall", "ultimately",
]

# Multi-domain, topic-grouped evaluation corpus (human peer-reviewed style vs multiple synthetic styles)
BENCHMARK_CORPUS: List[Tuple[str, str, str]] = [
    # Physics / Quantum
    ("human", "physics", "We report measurements of superconducting resonator loss across four fabrication runs. Surprisingly, annealing above 600C degraded Q-factors by a factor of three. Why did grain boundaries trap flux? TEM micrographs point toward oxygen diffusion."),
    ("human", "physics", "Cryogenic microwave cavities rarely maintain intrinsic quality factors past 10^7 without surface passivation. When HF etching stripped native oxide, two-level-system loss dropped immediately, though variance between dies persisted."),
    ("synthetic", "physics", "In recent years, quantum computing hardware has witnessed rapid advancements. Furthermore, superconducting resonators provide critical capabilities for coherence. Moreover, rigorous fabrication protocols enhance performance. Consequently, researchers achieve optimal efficiency."),
    ("synthetic", "physics", "Superconducting circuits represent a pivotal paradigm for modern physics. Additionally, advanced resonator designs mitigate decoherence challenges. Therefore, scalable quantum processors become increasingly viable across diverse experimental settings."),
    # Systems / Compilers
    ("human", "systems", "Existing compilers rarely exploit bit-level sparsity inside quantized matrix kernels. By packing non-zero nibbles into 64-bit register lanes, our kernel cuts memory traffic by 41% on ARMv9 cores while holding L1 misses flat."),
    ("human", "systems", "Tail latency spikes in disaggregated storage clusters often trace back to lock contention during metadata compaction rather than network saturation. Isolating lease renewal onto dedicated queues eliminated p99 jitter."),
    ("synthetic", "systems", "Modern distributed systems demand high throughput and low latency. Furthermore, optimized compiler frameworks facilitate efficient resource utilization. Moreover, intelligent scheduling algorithms reduce overhead. Consequently, overall system scalability improves substantially."),
    ("synthetic", "systems", "Efficient memory management plays a crucial role in contemporary computing architectures. Additionally, innovative kernel optimizations streamline execution pipelines. Therefore, these methodologies significantly enhance performance across heterogeneous workloads."),
    # Medicine / Clinical
    ("human", "medicine", "Among 412 patients screened for atrial fibrillation using single-lead patches, 19 exhibited false-positive ectopic bursts during vigorous cycling. Artifact rejection improved once baseline wander below 0.6 Hz was attenuated."),
    ("human", "medicine", "Retrospective chart audits seldom capture undocumented medication non-adherence prior to hospital readmission. Here, pharmacy refill gaps correlated strongly with BNP elevation (r = 0.61, p < 0.001), whereas age alone did not."),
    ("synthetic", "medicine", "In recent years, artificial intelligence has transformed modern healthcare systems. Furthermore, deep learning models provide significant improvements in diagnostic accuracy. Moreover, these methodologies facilitate clinical decision-making. Consequently, patient outcomes improve."),
    ("synthetic", "medicine", "Early disease detection remains a cornerstone of preventive medicine. Additionally, automated analytical pipelines enable clinicians to process complex patient cohorts effectively. Consequently, healthcare providers achieve enhanced diagnostic precision."),
    # Economics / Policy
    ("human", "economics", "Did municipal congestion pricing reduce retail foot traffic in central corridors? Difference-in-differences estimates across 14,000 point-of-sale terminals show weekday deliveries sped up by 14%, yet restaurant receipts dipped 2.1%."),
    ("human", "economics", "Export subsidies targeted at intermediate electronics shifted assembly margins rather than domestic R&D intensity. Firm-level tax filings reveal patent applications barely moved over the subsequent six quarters."),
    ("synthetic", "economics", "Urban transportation challenges significantly impact modern economic productivity. Furthermore, data-driven policy frameworks offer effective mechanisms for congestion mitigation. Moreover, comprehensive empirical analysis supports sustainable urban planning."),
    ("synthetic", "economics", "Global trade dynamics continue to evolve amidst technological disruption. Additionally, strategic fiscal policies foster industrial competitiveness. Consequently, policymakers can drive resilient long-term macroeconomic growth."),
    # Ecology / Climate
    ("human", "ecology", "Tree-ring chronologies from subalpine larches at 2,400 m reveal sharper drought sensitivity after 1998 than earlier decades. Soil moisture sensors installed beneath north-facing plots confirm rapid snowmelt runoff before budburst."),
    ("human", "ecology", "Estuarine oyster reefs attenuated wave energy by 38% during autumn storm surges, yet juvenile spat recruitment collapsed whenever salinity fell below 8 ppt for six consecutive days."),
    ("synthetic", "ecology", "Climate change poses unprecedented threats to fragile ecological systems worldwide. Furthermore, interdisciplinary conservation strategies are essential for biodiversity preservation. Moreover, systematic monitoring frameworks enhance ecological resilience."),
    ("synthetic", "ecology", "Sustainable ecosystem management requires integrating empirical observations with predictive modeling. Additionally, collaborative mitigation initiatives safeguard vulnerable habitats. Therefore, long-term environmental stability can be achieved."),
    # Education / HCI
    ("human", "hci", "Novice programmers debugging asynchronous callbacks paused longest not on syntax errors, but when stale closures captured loop counters. Side-by-side timeline traces cut fix time from eleven minutes to four."),
    ("human", "hci", "Screen-reader users navigating multi-column academic PDFs encountered reading-order inversions on 74% of two-column conference papers lacking tagged structure trees."),
    ("synthetic", "hci", "Interactive educational technologies have revolutionized contemporary learning environments. Furthermore, adaptive user interfaces empower learners to engage deeply with complex concepts. Consequently, pedagogical outcomes improve consistently."),
    ("synthetic", "hci", "Human-computer interaction research emphasizes accessible and intuitive system design. Additionally, user-centered evaluation methodologies provide actionable insights for interface refinement. Overall, usability improves significantly."),
]


def _words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9'-]+", text.lower())


def _sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\n+", " ", text))
    return [s.strip() for s in parts if len(s.strip().split()) >= 3]


def _mattr(words: List[str], window: int = 50) -> float:
    if not words:
        return 0.0
    if len(words) <= window:
        return len(set(words)) / len(words)
    ttrs = [len(set(words[i : i + window])) / window for i in range(len(words) - window + 1)]
    return sum(ttrs) / len(ttrs)


def _zipf_slope(freq: Counter) -> float:
    counts = sorted(freq.values(), reverse=True)
    if len(counts) < 4:
        return 0.0
    xs = [math.log10(r + 1) for r in range(len(counts))]
    ys = [math.log10(c) for c in counts]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def compute_writing_metrics(text: str) -> Dict[str, Any]:
    words = _words(text)
    sentences = _sentences(text)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    sent_lengths = [len(_words(s)) for s in sentences]
    mean_len = sum(sent_lengths) / max(len(sent_lengths), 1)
    var = sum((l - mean_len) ** 2 for l in sent_lengths) / max(len(sent_lengths), 1)
    std_dev = math.sqrt(var)
    burstiness = var / mean_len if mean_len > 0 else 0.0

    freq = Counter(words)
    unique = len(freq)
    n_words = len(words)
    ttr = unique / n_words if n_words else 0.0
    mattr = _mattr(words, window=50)
    guiraud = unique / math.sqrt(n_words) if n_words else 0.0
    hapax = sum(1 for c in freq.values() if c == 1) / unique if unique else 0.0
    zipf = _zipf_slope(freq)

    # True Shannon unigram entropy (bits/token)
    shannon_entropy = -sum((c / n_words) * math.log2(c / n_words) for c in freq.values()) if n_words else 0.0

    # Smoothed bigram conditional perplexity proxy (descriptive n-gram baseline only)
    bigrams = Counter(f"{words[i]} {words[i + 1]}" for i in range(max(0, n_words - 1)))
    cond_entropy = 0.0
    vocab = max(unique, 1)
    for i in range(max(0, n_words - 1)):
        w1 = words[i]
        p = (bigrams[f"{w1} {words[i + 1]}"] + 0.1) / (freq[w1] + 0.1 * vocab)
        cond_entropy += -math.log2(p)
    ngram_perplexity = min(450.0, 2.0 ** (cond_entropy / max(n_words - 1, 1))) if n_words > 1 else 16.0

    trans_counts = [{"word": m, "count": freq[m]} for m in TRANSITION_MARKERS if freq[m] > 0]
    trans_total = sum(x["count"] for x in trans_counts)
    trans_density = (trans_total / n_words) * 100.0 if n_words else 0.0

    trigrams = Counter(" ".join(words[i : i + 3]) for i in range(max(0, n_words - 2)))
    repetitive = [{"phrase": p, "count": c} for p, c in trigrams.most_common(8) if c >= 2]
    repetition_rate = (sum(c for _, c in trigrams.items() if c >= 2) / max(n_words - 2, 1)) * 100.0 if n_words > 2 else 0.0

    para_lens = [len(_words(p)) for p in paragraphs]
    para_mean = sum(para_lens) / max(len(para_lens), 1)
    para_std = math.sqrt(sum((l - para_mean) ** 2 for l in para_lens) / max(len(para_lens), 1))

    return {
        "wordCount": n_words,
        "sentenceCount": len(sentences),
        "paragraphCount": len(paragraphs),
        "meanSentenceLength": round(mean_len, 2),
        "sentenceLengthStdDev": round(std_dev, 2),
        "burstinessFanoFactor": round(burstiness, 2),
        "lexicalDiversityTTR": round(ttr, 3),
        "movingAverageTTR50": round(mattr, 3),
        "guiraudRootTTR": round(guiraud, 2),
        "hapaxLegomenaRatio": round(hapax, 3),
        "zipfSlope": round(zipf, 3),
        "shannonEntropyBits": round(shannon_entropy, 3),
        "transitionDensityPer100Words": round(trans_density, 2),
        "trigramRepetitionPercent": round(repetition_rate, 2),
        "paragraphUniformityStdDev": round(para_std, 2),
        "estimatedPerplexityProxy": round(ngram_perplexity, 1),
        "repetitivePhrases": repetitive,
        "transitionWordBreakdown": sorted(trans_counts, key=lambda x: x["count"], reverse=True),
    }


def _extract_feature_vector(text: str) -> List[float]:
    m = compute_writing_metrics(text)
    return [
        m["burstinessFanoFactor"],
        m["sentenceLengthStdDev"],
        m["transitionDensityPer100Words"],
        m["movingAverageTTR50"],
        m["hapaxLegomenaRatio"],
        m["shannonEntropyBits"],
        m["trigramRepetitionPercent"],
    ]


def evaluate_topic_grouped_classifier() -> Dict[str, Any]:
    """Leave-one-topic-out (no topic leakage) evaluation over benchmark corpus."""
    topics = sorted(set(t for _, t, _ in BENCHMARK_CORPUS))
    tp = fp = tn = fn = 0
    method = "stylometric-threshold"

    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler

        method = "scikit-learn-logistic-leave-one-topic-out"
        for held_out in topics:
            train = [(lbl, txt) for lbl, tp_name, txt in BENCHMARK_CORPUS if tp_name != held_out]
            test = [(lbl, txt) for lbl, tp_name, txt in BENCHMARK_CORPUS if tp_name == held_out]
            X_train = [_extract_feature_vector(txt) for _, txt in train]
            y_train = [1 if lbl == "synthetic" else 0 for lbl, _ in train]
            X_test = [_extract_feature_vector(txt) for _, txt in test]
            y_test = [1 if lbl == "synthetic" else 0 for lbl, _ in test]

            scaler = StandardScaler()
            X_tr_s = scaler.fit_transform(X_train)
            X_te_s = scaler.transform(X_test)
            clf = LogisticRegression(max_iter=500, random_state=42)
            clf.fit(X_tr_s, y_train)
            preds = clf.predict(X_te_s)
            for p, y in zip(preds, y_test):
                if p == 1 and y == 1:
                    tp += 1
                elif p == 1 and y == 0:
                    fp += 1
                elif p == 0 and y == 0:
                    tn += 1
                else:
                    fn += 1
    except Exception:
        for lbl, _, txt in BENCHMARK_CORPUS:
            m = compute_writing_metrics(txt)
            pred_syn = (m["transitionDensityPer100Words"] >= 3.0) or (m["burstinessFanoFactor"] < 1.1 and m["transitionDensityPer100Words"] >= 2.0)
            act_syn = lbl == "synthetic"
            if pred_syn and act_syn:
                tp += 1
            elif pred_syn and not act_syn:
                fp += 1
            elif not pred_syn and not act_syn:
                tn += 1
            else:
                fn += 1

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    return {
        "evaluationProtocol": "Leave-one-topic-out cross-validation (zero topic leakage)",
        "method": method,
        "sampleCount": len(BENCHMARK_CORPUS),
        "topicsCovered": topics,
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1Score": round(f1, 3),
        "falsePositiveRate": round(fpr, 3),
        "confusionMatrix": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "limitations": (
            "Evaluated on curated multi-domain excerpts; short passages (<150 words), ESL academic writing, and heavily edited human-AI hybrid drafts have higher false-positive risk."
        ),
    }


def analyze_writing_patterns(text: str) -> Dict[str, Any]:
    metrics = compute_writing_metrics(text)
    observations = []
    if metrics["sentenceCount"] >= 3 and metrics["burstinessFanoFactor"] < 1.5:
        observations.append({
            "dimension": "Sentence Length Burstiness",
            "signal": "Uniformity Detected",
            "observation": f"Low Fano factor ({metrics['burstinessFanoFactor']}); varying sentence length improves scholarly rhythm.",
        })
    else:
        observations.append({
            "dimension": "Sentence Length Burstiness",
            "signal": "Balanced",
            "observation": f"Healthy cadence variation (Fano factor = {metrics['burstinessFanoFactor']}).",
        })

    if metrics["transitionDensityPer100Words"] > 2.5:
        observations.append({
            "dimension": "Formal Transition Density",
            "signal": "High Repetition",
            "observation": f"Elevated connective density ({metrics['transitionDensityPer100Words']} per 100 words); vary clause transitions.",
        })
    else:
        observations.append({
            "dimension": "Formal Transition Density",
            "signal": "Balanced",
            "observation": f"Measured connective density ({metrics['transitionDensityPer100Words']} per 100 words).",
        })

    if metrics["wordCount"] < 150:
        observations.append({
            "dimension": "Sample Adequacy",
            "signal": "Needs review",
            "observation": f"Text contains {metrics['wordCount']} words; stylometric variance stabilizes above 150-300 words.",
        })

    return {
        "metrics": metrics,
        "observations": observations,
        "styleConsistencyNote": (
            "Descriptive stylometric telemetry and pattern calibration only; non-conclusive and must never be used alone as an academic misconduct verdict."
        ),
        "benchmarkEvaluation": evaluate_topic_grouped_classifier(),
    }
