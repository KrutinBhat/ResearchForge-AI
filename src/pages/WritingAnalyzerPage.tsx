import React, { useEffect, useState } from 'react';
import { BarChart3, Info } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface DocumentOption {
  id: string;
  title: string;
}

interface WritingAnalysisResponse {
  title: string;
  analysis: {
    metrics: {
      wordCount: number;
      sentenceCount: number;
      paragraphCount: number;
      meanSentenceLength: number;
      sentenceLengthStdDev: number;
      burstinessFanoFactor: number;
      lexicalDiversityTTR: number;
      mattr50?: number;
      guiraudRootTTR: number;
      hapaxLegomenaRatio: number;
      shannonEntropyBits?: number;
      zipfSlope?: number;
      trigramRepetitionRate?: number;
      transitionDensityPer100Words: number;
      paragraphUniformityStdDev: number;
      estimatedPerplexityProxy: number;
      sentenceLengthDistribution: Array<{ bucket: string; count: number }>;
      repetitivePhrases: Array<{ phrase: string; count: number }>;
      transitionWordBreakdown: Array<{ word: string; count: number }>;
    };
    observations: Array<{ dimension: string; signal: string; observation: string }>;
    styleConsistencyNote: string;
    benchmarkEvaluation: {
      datasetDescription: string;
      validationProtocol?: string;
      sampleCount: number;
      precision: number;
      recall: number;
      f1Score: number;
      accuracy: number;
      falsePositiveRate?: number;
      confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
      falsePositiveNotes: string[];
    };
  };
}

export function WritingAnalyzerPage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [customText, setCustomText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<WritingAnalysisResponse | null>(null);

  useEffect(() => {
    apiFetch<{ documents: DocumentOption[] }>('/api/documents')
      .then((res) => {
        setDocuments(res.documents);
        if (res.documents.length > 0) setDocumentId(res.documents[0].id);
      })
      .catch(() => {});
  }, []);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<WritingAnalysisResponse>('/api/writing-analysis/analyze', {
        method: 'POST',
        body: JSON.stringify({
          documentId: customText.trim() ? undefined : documentId,
          text: customText.trim() || undefined,
        }),
      });
      setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <WorkspaceLayout
      title="AI-Writing Pattern & Stylometric Analyzer"
      subtitle="Examine sentence-length burstiness, lexical diversity, trigram perplexity proxy, repetitive phrasing, and an experimental classifier benchmark—providing linguistic observations rather than authorship claims."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleAnalyze} className="bg-white border border-slate-200 rounded-xl p-6 mb-8 space-y-4">
        <div>
          <label htmlFor="wrt-doc" className="block text-xs font-medium text-slate-700 mb-1">
            Select workspace manuscript
          </label>
          <select
            id="wrt-doc"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            className="w-full max-w-xl px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="">-- Select manuscript --</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="wrt-text" className="block text-xs font-medium text-slate-700 mb-1">
            Or paste prose excerpt directly
          </label>
          <textarea
            id="wrt-text"
            rows={4}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Paste manuscript prose to compute stylometric telemetry..."
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="submit"
          disabled={loading || (!documentId && !customText.trim())}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
        >
          <BarChart3 className="w-4 h-4" aria-hidden="true" />
          <span>{loading ? 'Analyzing stylometrics...' : 'Run Linguistic Analysis'}</span>
        </button>
      </form>

      {result && (
        <div className="space-y-6">
          <div className="p-4 rounded-xl border border-slate-200 bg-slate-100/70 flex items-start gap-3 text-xs text-slate-700">
            <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div>{result.analysis.styleConsistencyNote}</div>
          </div>

          {/* Key Stylometric Telemetry */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Burstiness (Fano)</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.analysis.metrics.burstinessFanoFactor}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">SD {result.analysis.metrics.sentenceLengthStdDev}w</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Lexical Richness (MATTR-50)</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.analysis.metrics.mattr50 ?? result.analysis.metrics.lexicalDiversityTTR}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                TTR {result.analysis.metrics.lexicalDiversityTTR} · Zipf {result.analysis.metrics.zipfSlope ?? '—'}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Entropy & Perplexity</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.analysis.metrics.shannonEntropyBits ?? '—'}b
              </div>
              <div className="text-xs text-slate-400 mt-0.5">Bigram Ppl {result.analysis.metrics.estimatedPerplexityProxy}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Transition Density</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.analysis.metrics.transitionDensityPer100Words}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">per 100 words</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Paragraph Uniformity</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.analysis.metrics.paragraphUniformityStdDev}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">word count SD</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="font-display text-sm font-semibold text-slate-900 mb-4">
                Sentence Length Distribution (Words per Sentence)
              </h2>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={result.analysis.metrics.sentenceLengthDistribution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: '#475569' }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#475569' }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#4338ca" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="font-display text-sm font-semibold text-slate-900">Linguistic Observations</h2>
              <ul className="space-y-3">
                {result.analysis.observations.map((obs, i) => (
                  <li key={i} className="pb-3 border-b border-slate-100 last:border-b-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold text-slate-900">{obs.dimension}</span>
                      <StatusLabel status={obs.signal} />
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{obs.observation}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Repetitive Phrases & Experimental Model Evaluation Dashboard */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="font-display text-sm font-semibold text-slate-900 mb-3">
                Repetitive Expressions & Discourse Markers
              </h2>
              <div className="space-y-4 text-xs">
                <div>
                  <div className="font-medium text-slate-700 mb-1.5">Repeated 3-gram sequences</div>
                  {result.analysis.metrics.repetitivePhrases.length > 0 ? (
                    <ul className="space-y-1 font-mono text-slate-700">
                      {result.analysis.metrics.repetitivePhrases.map((p, i) => (
                        <li key={i} className="flex justify-between">
                          <span>“{p.phrase}”</span>
                          <span className="tabular-nums text-slate-500">x{p.count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-slate-500">No repeated trigrams above threshold.</p>
                  )}
                </div>
                <div className="pt-3 border-t border-slate-100">
                  <div className="font-medium text-slate-700 mb-1.5">Formal transitions detected</div>
                  {result.analysis.metrics.transitionWordBreakdown.length > 0 ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-slate-700">
                      {result.analysis.metrics.transitionWordBreakdown.map((t) => (
                        <span key={t.word}>
                          {t.word}: <strong className="tabular-nums">{t.count}</strong>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500">Minimal stacked formal connectives.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="font-display text-sm font-semibold text-slate-900 mb-1">
                Experimental Stylometric Classifier Benchmark
              </h2>
              <p className="text-xs text-slate-500 mb-4">{result.analysis.benchmarkEvaluation.datasetDescription}</p>

              <div className="grid grid-cols-5 gap-3 mb-5">
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-xs text-slate-500">Precision</div>
                  <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {result.analysis.benchmarkEvaluation.precision}
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-xs text-slate-500">Recall</div>
                  <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {result.analysis.benchmarkEvaluation.recall}
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-xs text-slate-500">F1-Score</div>
                  <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {result.analysis.benchmarkEvaluation.f1Score}
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-xs text-slate-500">Accuracy</div>
                  <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {result.analysis.benchmarkEvaluation.accuracy}
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-xs text-slate-500">FPR</div>
                  <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    {result.analysis.benchmarkEvaluation.falsePositiveRate ?? 0}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-semibold text-slate-800 mb-2">Confusion Matrix (n={result.analysis.benchmarkEvaluation.sampleCount})</div>
                  <table className="w-full border border-slate-200 text-center font-mono tabular-nums">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="p-1.5 text-left font-sans font-medium text-slate-500">Actual \ Pred</th>
                        <th className="p-1.5">Synthetic</th>
                        <th className="p-1.5">Human</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-slate-200">
                        <td className="p-1.5 text-left font-sans font-medium text-slate-700">Synthetic</td>
                        <td className="p-1.5 bg-emerald-50 text-emerald-900 font-semibold">
                          TP: {result.analysis.benchmarkEvaluation.confusionMatrix.tp}
                        </td>
                        <td className="p-1.5 text-amber-800">
                          FN: {result.analysis.benchmarkEvaluation.confusionMatrix.fn}
                        </td>
                      </tr>
                      <tr>
                        <td className="p-1.5 text-left font-sans font-medium text-slate-700">Human</td>
                        <td className="p-1.5 text-red-700">
                          FP: {result.analysis.benchmarkEvaluation.confusionMatrix.fp}
                        </td>
                        <td className="p-1.5 bg-emerald-50 text-emerald-900 font-semibold">
                          TN: {result.analysis.benchmarkEvaluation.confusionMatrix.tn}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <div className="font-semibold text-slate-800 mb-1.5">False-Positive Risk Analysis</div>
                  <ul className="space-y-1 text-slate-600 list-disc pl-4">
                    {result.analysis.benchmarkEvaluation.falsePositiveNotes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
