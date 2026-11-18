export interface WritingMetrics {
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  meanSentenceLength: number;
  sentenceLengthStdDev: number;
  burstinessFanoFactor: number;
  lexicalDiversityTTR: number;
  mattr50: number;
  guiraudRootTTR: number;
  hapaxLegomenaRatio: number;
  shannonEntropyBits: number;
  zipfSlope: number;
  trigramRepetitionRate: number;
  transitionDensityPer100Words: number;
  paragraphUniformityStdDev: number;
  estimatedPerplexityProxy: number;
  sentenceLengthDistribution: Array<{ bucket: string; count: number }>;
  repetitivePhrases: Array<{ phrase: string; count: number }>;
  transitionWordBreakdown: Array<{ word: string; count: number }>;
}

export interface LinguisticObservation {
  dimension: string;
  signal: 'Balanced' | 'Uniformity Detected' | 'High Repetition' | 'Sparse Variation';
  observation: string;
}

export interface BenchmarkEvaluation {
  datasetDescription: string;
  validationProtocol: string;
  sampleCount: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  falsePositiveRate: number;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
  falsePositiveNotes: string[];
}

export interface WritingAnalysisResult {
  metrics: WritingMetrics;
  observations: LinguisticObservation[];
  styleConsistencyNote: string;
  benchmarkEvaluation: BenchmarkEvaluation;
}

const TRANSITION_MARKERS = [
  'furthermore',
  'moreover',
  'additionally',
  'consequently',
  'therefore',
  'however',
  'nevertheless',
  'notwithstanding',
  'subsequently',
  'accordingly',
  'conversely',
  'specifically',
  'notably',
  'overall',
  'ultimately',
];

function extractSentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 3);
}

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9'-]+/g) ?? []).filter(Boolean);
}

export function computeMattr(words: string[], windowSize = 50): number {
  if (words.length === 0) return 0;
  if (words.length <= windowSize) return new Set(words).size / words.length;
  let sum = 0;
  const steps = words.length - windowSize + 1;
  for (let i = 0; i < steps; i++) {
    sum += new Set(words.slice(i, i + windowSize)).size / windowSize;
  }
  return sum / steps;
}

export function computeZipfSlope(freq: Map<string, number>): number {
  const sorted = Array.from(freq.values()).sort((a, b) => b - a).slice(0, 60);
  if (sorted.length < 3) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < sorted.length; i++) {
    sumX += Math.log(i + 1);
    sumY += Math.log(sorted[i]);
  }
  const meanX = sumX / sorted.length;
  const meanY = sumY / sorted.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < sorted.length; i++) {
    const dx = Math.log(i + 1) - meanX;
    const dy = Math.log(sorted[i]) - meanY;
    num += dx * dy;
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

export function computeWritingMetrics(text: string): WritingMetrics {
  const words = wordsOf(text);
  const sentences = extractSentences(text);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const sentenceLengths = sentences.map((s) => wordsOf(s).length);
  const meanLen = sentenceLengths.reduce((a, b) => a + b, 0) / Math.max(sentenceLengths.length, 1);
  const variance =
    sentenceLengths.reduce((acc, l) => acc + Math.pow(l - meanLen, 2), 0) / Math.max(sentenceLengths.length, 1);
  const stdDev = Math.sqrt(variance);
  const burstiness = meanLen > 0 ? variance / meanLen : 0;

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const uniqueWords = freq.size;
  const ttr = words.length > 0 ? uniqueWords / words.length : 0;
  const mattr50 = computeMattr(words, 50);
  const guiraud = words.length > 0 ? uniqueWords / Math.sqrt(words.length) : 0;

  let hapaxCount = 0;
  let shannonEntropy = 0;
  for (const count of freq.values()) {
    if (count === 1) hapaxCount++;
    const p = count / Math.max(words.length, 1);
    if (p > 0) shannonEntropy -= p * Math.log2(p);
  }
  const hapaxRatio = uniqueWords > 0 ? hapaxCount / uniqueWords : 0;
  const zipfSlope = computeZipfSlope(freq);

  const transitionCounts: Array<{ word: string; count: number }> = [];
  let totalTransitions = 0;
  for (const marker of TRANSITION_MARKERS) {
    const c = freq.get(marker) ?? 0;
    if (c > 0) {
      transitionCounts.push({ word: marker, count: c });
      totalTransitions += c;
    }
  }
  const transitionDensity = words.length > 0 ? (totalTransitions / words.length) * 100 : 0;

  const trigramMap = new Map<string, number>();
  const totalTrigrams = Math.max(words.length - 2, 0);
  for (let i = 0; i <= words.length - 3; i++) {
    const tri = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    trigramMap.set(tri, (trigramMap.get(tri) ?? 0) + 1);
  }
  const repeatedTriTokens = Array.from(trigramMap.values())
    .filter((c) => c >= 2)
    .reduce((acc, c) => acc + (c - 1), 0);
  const trigramRepetitionRate = totalTrigrams > 0 ? repeatedTriTokens / totalTrigrams : 0;

  const repetitivePhrases = Array.from(trigramMap.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([phrase, count]) => ({ phrase, count }));

  const paraLengths = paragraphs.map((p) => wordsOf(p).length);
  const paraMean = paraLengths.reduce((a, b) => a + b, 0) / Math.max(paraLengths.length, 1);
  const paraVar =
    paraLengths.reduce((acc, l) => acc + Math.pow(l - paraMean, 2), 0) / Math.max(paraLengths.length, 1);
  const paragraphUniformityStdDev = Math.sqrt(paraVar);

  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const bg = `${words[i]} ${words[i + 1]}`;
    bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
  }
  let crossEntropySum = 0;
  const vocabSize = Math.max(uniqueWords, 1);
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const bg = `${w1} ${words[i + 1]}`;
    const p = ((bigramCounts.get(bg) ?? 0) + 0.1) / ((freq.get(w1) ?? 0) + 0.1 * vocabSize);
    crossEntropySum += -Math.log2(p);
  }
  const meanEntropy = words.length > 1 ? crossEntropySum / (words.length - 1) : 4;
  const estimatedPerplexityProxy = Math.min(450, Math.pow(2, meanEntropy));

  const buckets = [
    { label: '1-8', min: 1, max: 8, count: 0 },
    { label: '9-15', min: 9, max: 15, count: 0 },
    { label: '16-22', min: 16, max: 22, count: 0 },
    { label: '23-30', min: 23, max: 30, count: 0 },
    { label: '31+', min: 31, max: 999, count: 0 },
  ];
  for (const len of sentenceLengths) {
    const b = buckets.find((bk) => len >= bk.min && len <= bk.max);
    if (b) b.count++;
  }

  return {
    wordCount: words.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    meanSentenceLength: Number(meanLen.toFixed(2)),
    sentenceLengthStdDev: Number(stdDev.toFixed(2)),
    burstinessFanoFactor: Number(burstiness.toFixed(2)),
    lexicalDiversityTTR: Number(ttr.toFixed(3)),
    mattr50: Number(mattr50.toFixed(3)),
    guiraudRootTTR: Number(guiraud.toFixed(2)),
    hapaxLegomenaRatio: Number(hapaxRatio.toFixed(3)),
    shannonEntropyBits: Number(shannonEntropy.toFixed(3)),
    zipfSlope: Number(zipfSlope.toFixed(3)),
    trigramRepetitionRate: Number(trigramRepetitionRate.toFixed(4)),
    transitionDensityPer100Words: Number(transitionDensity.toFixed(2)),
    paragraphUniformityStdDev: Number(paragraphUniformityStdDev.toFixed(2)),
    estimatedPerplexityProxy: Number(estimatedPerplexityProxy.toFixed(1)),
    sentenceLengthDistribution: buckets.map((b) => ({ bucket: b.label, count: b.count })),
    repetitivePhrases,
    transitionWordBreakdown: transitionCounts.sort((a, b) => b.count - a.count),
  };
}

// 24-excerpt 6-topic benchmark corpus evaluated via leave-one-topic-out (zero topic/author leakage)
const STYLOMETRIC_BENCHMARK_CORPUS: Array<{ topic: string; label: 'human' | 'synthetic'; text: string }> = [
  { topic: 'physics', label: 'human', text: 'We report measurements of superconducting resonator loss across four fabrication runs. Surprisingly, annealing above 600C degraded Q-factors by a factor of three, contradicting earlier thin-film models. Why did grain boundaries trap flux? TEM micrographs point toward oxygen diffusion along etched trenches, though batch-to-batch scatter remains stubbornly wide.' },
  { topic: 'physics', label: 'human', text: 'Cryogenic amplifiers often drift when bias resistors heat unevenly across mismatched substrates. In our setup, swapping thick-film terminations for bulk metal foil halved low-frequency 1/f noise! Still, two cool-downs showed unexplained spikes near 4.2 K.' },
  { topic: 'physics', label: 'synthetic', text: 'Quantum computing architectures demonstrate remarkable promise for solving complex physical simulations. Furthermore, superconducting qubits achieve high coherence times under controlled cryogenic environments. Moreover, advanced error mitigation strategies improve computational fidelity significantly. Consequently, researchers can investigate novel quantum phenomena reliably. Additionally, future investigations will explore scalable fault-tolerant hardware.' },
  { topic: 'physics', label: 'synthetic', text: 'Superconducting materials play a critical role in modern instrumentation applications. Furthermore, precise thermal management ensures optimal device performance across operational regimes. Moreover, refined fabrication pipelines reduce structural defects effectively. Consequently, experimental measurements exhibit enhanced stability and repeatability. Additionally, ongoing studies will continue optimizing material interfaces.' },
  { topic: 'compilers', label: 'human', text: 'Existing compilers rarely exploit bit-level sparsity inside quantized matrix kernels. By packing non-zero nibbles into 64-bit register lanes, our kernel cuts memory traffic by 41% on ARMv9 cores. While register pressure increases slightly on small tiles, throughput improves consistently across all tested batch sizes.' },
  { topic: 'compilers', label: 'human', text: 'Register allocators struggle when vector masks spill mid-loop! Rather than inserting reload instructions at every basic block boundary, we hoist predicate reconstruction outside cold branches—saving 11% cycle count on SPECint kernels.' },
  { topic: 'compilers', label: 'synthetic', text: 'Modern compiler optimizations significantly enhance execution efficiency across heterogeneous processor architectures. Furthermore, automated loop transformations maximize parallel hardware utilization effectively. Moreover, sophisticated register allocation algorithms minimize memory access overhead. Consequently, compiled programs achieve substantial throughput gains across workloads. Additionally, future compiler frameworks will integrate adaptive machine learning heuristics.' },
  { topic: 'compilers', label: 'synthetic', text: 'Code generation pipelines require careful orchestration to balance latency and energy consumption. Furthermore, intermediate representation passes streamline target-specific instruction selection. Moreover, static analysis techniques identify optimization opportunities reliably. Consequently, software developers attain superior runtime performance consistently. Additionally, continued advancements will further strengthen compilation scalability.' },
  { topic: 'hydrology', label: 'human', text: 'Field surveys across 19 alpine catchments reveal sharp divergence between snowmelt timing and peak nitrate export. Early melt events flush soil pores before microbial uptake accelerates! Yet late-season storms produce noisy dilution curves that resist simple linear regression.' },
  { topic: 'hydrology', label: 'human', text: 'Piezometer readings along braided glacial outwash plains rarely obey steady-state Darcy assumptions. When diurnal melt surges arrive around 16:00, bank storage reverses hydraulic gradients within minutes—leaving static grab samples biased low.' },
  { topic: 'hydrology', label: 'synthetic', text: 'Watershed hydrological modeling provides vital insights into seasonal nutrient transport dynamics. Furthermore, distributed sensor networks capture high-resolution precipitation and runoff measurements continuously. Moreover, data-driven calibration frameworks improve streamflow prediction accuracy markedly. Consequently, water resource managers formulate effective conservation strategies. Additionally, future research will incorporate broader climate scenarios.' },
  { topic: 'hydrology', label: 'synthetic', text: 'Alpine ecosystems face increasing hydrological variability due to shifting temperature patterns. Furthermore, integrated monitoring systems track snowpack accumulation and meltwater discharge systematically. Moreover, numerical simulation models evaluate biogeochemical cycling reliably. Consequently, environmental agencies strengthen downstream water quality protection. Additionally, upcoming studies will expand longitudinal catchment observations.' },
  { topic: 'systems', label: 'human', text: 'Wait-free queues typically trade spatial locality for progress guarantees. Here we revisit ring-buffer batching on dual-socket EPYC servers, showing that cache-line alignment matters more than atomic instruction counts once contention exceeds eight threads.' },
  { topic: 'systems', label: 'human', text: 'NUMA-aware lock cohorts help only until cross-socket page migrations saturate UPI links. On 128-core nodes, pinning slab arenas per CCX domain shaved p99 tail latency from 4.8 ms down to 610 microseconds!' },
  { topic: 'systems', label: 'synthetic', text: 'Distributed systems architectures rely on concurrent data structures to deliver high throughput. Furthermore, lock-free synchronization primitives minimize thread blocking under heavy contention workloads. Moreover, careful memory layout optimizations enhance cache efficiency substantially. Consequently, multi-core server applications achieve predictable latency bounds. Additionally, future engineering efforts will investigate heterogeneous accelerator integration.' },
  { topic: 'systems', label: 'synthetic', text: 'Scalable cloud infrastructure demands resilient coordination mechanisms across partitioned compute nodes. Furthermore, asynchronous communication protocols reduce unnecessary network serialization delays. Moreover, adaptive load balancing algorithms distribute incoming requests evenly. Consequently, distributed services maintain robust availability targets continuously. Additionally, ongoing enhancements will optimize multi-region replication overhead.' },
  { topic: 'vision', label: 'human', text: 'Can compact vision transformers run under 15ms on embedded DSPs without losing boundary sharpness? Pruning attention heads uniformly smears small road signs. Instead, keeping full resolution in stage two while dropping late MLP channels preserves 94.2% mIoU.' },
  { topic: 'vision', label: 'human', text: 'Event cameras output microsecond-resolution polarity streams that blur standard frame-based optical flow labels. Warping sparse edge patches over 8 ms windows cut end-point error by half on night driving sequences, though static backgrounds remain dark.' },
  { topic: 'vision', label: 'synthetic', text: 'Computer vision architectures have achieved remarkable breakthroughs in real-time semantic segmentation tasks. Furthermore, transformer-based backbone networks capture long-range spatial dependencies effectively. Moreover, structured model compression techniques reduce edge inference latency noticeably. Consequently, autonomous perception systems operate reliably under strict hardware constraints. Additionally, future work will explore multi-modal sensor fusion pipelines.' },
  { topic: 'vision', label: 'synthetic', text: 'Deep neural networks enable accurate visual recognition across diverse industrial inspection domains. Furthermore, hierarchical feature extraction modules preserve fine-grained object boundaries consistently. Moreover, lightweight quantization schemes accelerate embedded hardware deployment markedly. Consequently, intelligent imaging platforms achieve superior accuracy and efficiency. Additionally, forthcoming investigations will evaluate broader environmental robustness.' },
  { topic: 'history', label: 'human', text: 'Historical shipping ledgers from Antwerp contain fragmented tonnage figures written in three currencies. Reconciling Flemish groats against Venetian ducats exposes seasonal arbitrage spikes during winter blockades, even after correcting for missing customs folios.' },
  { topic: 'history', label: 'human', text: 'Notarial contracts from 1580s Genoa list marine insurance premiums side by side with spice cargos—yet gale losses were settled weeks later in private arbitration whose ledgers rarely survive!' },
  { topic: 'history', label: 'synthetic', text: 'Quantitative historical scholarship increasingly utilizes archival digitization to illuminate early modern trade networks. Furthermore, systematic ledger analysis reveals structural patterns in maritime commerce and credit flows. Moreover, comparative methodological frameworks contextualize regional currency fluctuations reliably. Consequently, economic historians gain deeper insight into pre-industrial market integration. Additionally, future archival initiatives will expand cross-regional dataset coverage.' },
  { topic: 'history', label: 'synthetic', text: 'Archival mercantile records offer valuable evidence regarding historical financial instruments and risk management. Furthermore, structured transcription pipelines facilitate transparent cross-referencing across multilingual manuscripts. Moreover, statistical examination uncovers cyclical volatility trends across seasonal shipping corridors. Consequently, researchers establish nuanced interpretations of institutional evolution. Additionally, ongoing collaborations will preserve fragile primary source collections.' },
];

function extractFeatureVector(m: WritingMetrics): number[] {
  return [
    m.burstinessFanoFactor,
    m.sentenceLengthStdDev,
    m.mattr50,
    m.shannonEntropyBits,
    m.transitionDensityPer100Words,
    m.trigramRepetitionRate * 100,
    m.zipfSlope,
  ];
}

function trainCentroidClassifier(trainItems: Array<{ vec: number[]; label: 'human' | 'synthetic' }>) {
  const dim = trainItems[0].vec.length;
  const meanPos = new Array(dim).fill(0);
  const meanNeg = new Array(dim).fill(0);
  let posCount = 0;
  let negCount = 0;

  for (const item of trainItems) {
    if (item.label === 'synthetic') {
      posCount++;
      for (let i = 0; i < dim; i++) meanPos[i] += item.vec[i];
    } else {
      negCount++;
      for (let i = 0; i < dim; i++) meanNeg[i] += item.vec[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    meanPos[i] /= Math.max(posCount, 1);
    meanNeg[i] /= Math.max(negCount, 1);
  }
  const sd = new Array(dim).fill(0);
  for (const item of trainItems) {
    const ref = item.label === 'synthetic' ? meanPos : meanNeg;
    for (let i = 0; i < dim; i++) sd[i] += Math.pow(item.vec[i] - ref[i], 2);
  }
  for (let i = 0; i < dim; i++) {
    sd[i] = Math.max(Math.sqrt(sd[i] / Math.max(trainItems.length, 1)), 0.15);
  }

  return (vec: number[]): boolean => {
    let distPos = 0;
    let distNeg = 0;
    for (let i = 0; i < dim; i++) {
      distPos += Math.pow((vec[i] - meanPos[i]) / sd[i], 2);
      distNeg += Math.pow((vec[i] - meanNeg[i]) / sd[i], 2);
    }
    return distPos < distNeg;
  };
}

export function evaluateExperimentalClassifier(): BenchmarkEvaluation {
  const precomputed = STYLOMETRIC_BENCHMARK_CORPUS.map((item) => ({
    topic: item.topic,
    label: item.label,
    metrics: computeWritingMetrics(item.text),
    vec: extractFeatureVector(computeWritingMetrics(item.text)),
  }));

  const topics = Array.from(new Set(precomputed.map((p) => p.topic)));
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const falsePositiveNotes: string[] = [];

  for (const heldOutTopic of topics) {
    const train = precomputed.filter((p) => p.topic !== heldOutTopic);
    const test = precomputed.filter((p) => p.topic === heldOutTopic);
    const predict = trainCentroidClassifier(train);

    for (const sample of test) {
      const predSynthetic = predict(sample.vec);
      const actualSynthetic = sample.label === 'synthetic';
      if (predSynthetic && actualSynthetic) tp++;
      else if (predSynthetic && !actualSynthetic) {
        fp++;
        falsePositiveNotes.push(
          `Held-out topic "${sample.topic}" human excerpt flagged (burstiness=${sample.metrics.burstinessFanoFactor}, transition=${sample.metrics.transitionDensityPer100Words}/100w).`
        );
      } else if (!predSynthetic && !actualSynthetic) tn++;
      else fn++;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / precomputed.length;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;

  if (falsePositiveNotes.length === 0) {
    falsePositiveNotes.push(
      'Non-native ESL academic prose and standardized IEEE Methods sections often share low burstiness and formal connectives, creating unavoidable false-positive risk outside controlled benchmarks.'
    );
  }

  return {
    datasetDescription:
      '24-excerpt 6-topic controlled stylometric benchmark (12 human multi-domain abstracts, 12 formulaic synthetic abstracts). Evaluated live with leave-one-topic-out cross-validation (zero topic leakage).',
    validationProtocol: '6-fold leave-one-topic-out standardized centroid classifier (Python backend uses scikit-learn LogisticRegression with identical split).',
    sampleCount: precomputed.length,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1Score: Number(f1.toFixed(3)),
    accuracy: Number(accuracy.toFixed(3)),
    falsePositiveRate: Number(fpr.toFixed(3)),
    confusionMatrix: { tp, fp, tn, fn },
    falsePositiveNotes,
  };
}

export function analyzeWritingPatterns(text: string): WritingAnalysisResult {
  const metrics = computeWritingMetrics(text);
  const observations: LinguisticObservation[] = [];

  if (metrics.sentenceCount >= 3 && metrics.burstinessFanoFactor < 1.5) {
    observations.push({
      dimension: 'Sentence Length Burstiness',
      signal: 'Uniformity Detected',
      observation: `Low Fano factor (${metrics.burstinessFanoFactor}) and narrow sentence-length spread (SD = ${metrics.sentenceLengthStdDev} words). Varying clause structures improves scholarly cadence.`,
    });
  } else {
    observations.push({
      dimension: 'Sentence Length Burstiness',
      signal: 'Balanced',
      observation: `Healthy sentence cadence variation (Fano factor = ${metrics.burstinessFanoFactor}, SD = ${metrics.sentenceLengthStdDev} words across ${metrics.sentenceCount} sentences).`,
    });
  }

  if (metrics.transitionDensityPer100Words > 2.5) {
    observations.push({
      dimension: 'Formal Transition Density',
      signal: 'High Repetition',
      observation: `Elevated formal connective density (${metrics.transitionDensityPer100Words} per 100 words). Over-reliance on stacked discourse markers can read formulaically.`,
    });
  } else {
    observations.push({
      dimension: 'Formal Transition Density',
      signal: 'Balanced',
      observation: `Measured connective usage (${metrics.transitionDensityPer100Words} per 100 words) without excessive mechanical transitions.`,
    });
  }

  if (metrics.repetitivePhrases.length > 0 || metrics.trigramRepetitionRate > 0.04) {
    observations.push({
      dimension: 'Phrasal & Trigram Repetition',
      signal: 'High Repetition',
      observation: `Trigram repetition rate ${(metrics.trigramRepetitionRate * 100).toFixed(2)}%${metrics.repetitivePhrases.length > 0 ? ` (top: "${metrics.repetitivePhrases[0].phrase}" x${metrics.repetitivePhrases[0].count})` : ''}.`,
    });
  } else {
    observations.push({
      dimension: 'Phrasal & Trigram Repetition',
      signal: 'Balanced',
      observation: `Low trigram repetition rate (${(metrics.trigramRepetitionRate * 100).toFixed(2)}%).`,
    });
  }

  if (metrics.wordCount > 120 && metrics.mattr50 < 0.62) {
    observations.push({
      dimension: 'Lexical Richness & Entropy',
      signal: 'Sparse Variation',
      observation: `MATTR-50 = ${metrics.mattr50}, Shannon entropy = ${metrics.shannonEntropyBits} bits, Zipf slope = ${metrics.zipfSlope}. Introducing varied domain verbs strengthens prose.`,
    });
  } else {
    observations.push({
      dimension: 'Lexical Richness & Entropy',
      signal: 'Balanced',
      observation: `Well-proportioned vocabulary dynamics (MATTR-50 = ${metrics.mattr50}, Shannon entropy = ${metrics.shannonEntropyBits} bits, Guiraud R = ${metrics.guiraudRootTTR}, Zipf slope = ${metrics.zipfSlope}).`,
    });
  }

  const benchmarkEvaluation = evaluateExperimentalClassifier();

  return {
    metrics,
    observations,
    styleConsistencyNote:
      'Linguistic telemetry reflects measurable statistical prose features (Shannon entropy, MATTR-50, Zipf slope, Fano burstiness). Stylometric patterns cannot prove or disprove authorship and must never be treated as standalone AI-authorship verdicts.',
    benchmarkEvaluation,
  };
}
