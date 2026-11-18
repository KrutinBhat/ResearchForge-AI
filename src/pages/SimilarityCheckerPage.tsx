import React, { useEffect, useState } from 'react';
import { ScanSearch, Info } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface DocumentOption {
  id: string;
  title: string;
}

interface SimilarityResult {
  overallSimilarityPercent: number;
  exactMatchPercent: number;
  paraphrasePercent?: number;
  semanticOverlapPercent: number;
  quotedPercent: number;
  uncitedFlagCount: number;
  corpusCoverage: {
    indexedDocuments: number;
    indexedChunks?: number;
    arxivAbstractsQueried: number;
    limitationNotice: string;
  };
  matches: Array<{
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
    category: string;
    hasCitation: boolean;
    explanation: string;
  }>;
  algorithmBreakdown: {
    meanExact: number;
    meanNgramJaccard: number;
    meanFuzzyDice: number;
    meanTfidfCosine: number;
    meanBm25Normalized: number;
    meanSemanticOverlap: number;
  };
}

export function SimilarityCheckerPage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [customText, setCustomText] = useState('');
  const [queryArxiv, setQueryArxiv] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<{ title: string; result: SimilarityResult } | null>(null);

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
    setRunning(true);
    try {
      const res = await apiFetch<{ title: string; result: SimilarityResult }>('/api/similarity/analyze', {
        method: 'POST',
        body: JSON.stringify({
          documentId: customText.trim() ? undefined : documentId,
          text: customText.trim() || undefined,
          queryArxiv,
        }),
      });
      setReport(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const chartData = report
    ? [
        { layer: 'Exact', score: Math.round(report.result.algorithmBreakdown.meanExact * 100) },
        { layer: '3-Gram', score: Math.round(report.result.algorithmBreakdown.meanNgramJaccard * 100) },
        { layer: 'Fuzzy Dice', score: Math.round(report.result.algorithmBreakdown.meanFuzzyDice * 100) },
        { layer: 'TF-IDF', score: Math.round(report.result.algorithmBreakdown.meanTfidfCosine * 100) },
        { layer: 'BM25', score: Math.round(report.result.algorithmBreakdown.meanBm25Normalized * 100) },
        { layer: 'Semantic', score: Math.round(report.result.algorithmBreakdown.meanSemanticOverlap * 100) },
      ]
    : [];

  return (
    <WorkspaceLayout
      title="Plagiarism & Multi-Layer Similarity Engine"
      subtitle="Evaluate exact matching, 3-gram shingling, Dice fuzzy matching, TF-IDF cosine, BM25, and semantic overlap across indexed workspace manuscripts and live arXiv abstracts."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleAnalyze} className="bg-white border border-slate-200 rounded-xl p-6 mb-8 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="sim-doc" className="block text-xs font-medium text-slate-700 mb-1">
              Workspace manuscript
            </label>
            <select
              id="sim-doc"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">-- Select manuscript --</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={queryArxiv}
                onChange={(e) => setQueryArxiv(e.target.checked)}
                className="rounded border-slate-300 text-blue-800"
              />
              <span>Fetch live related arXiv open-access abstracts during scan</span>
            </label>
          </div>
        </div>

        <div>
          <label htmlFor="sim-custom" className="block text-xs font-medium text-slate-700 mb-1">
            Or paste passage / full manuscript text directly
          </label>
          <textarea
            id="sim-custom"
            rows={4}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Paste academic text here to override the workspace manuscript selector..."
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="submit"
          disabled={running || (!documentId && !customText.trim())}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
        >
          <ScanSearch className="w-4 h-4" aria-hidden="true" />
          <span>{running ? 'Running multi-layer similarity scan...' : 'Run Similarity Analysis'}</span>
        </button>
      </form>

      {report && (
        <div className="space-y-6">
          {/* Corpus Scope & Limitation Notice */}
          <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/70 flex items-start gap-3 text-xs text-blue-950">
            <Info className="w-4 h-4 text-blue-800 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <span className="font-semibold">
                Corpus Scope ({report.result.corpusCoverage.indexedDocuments} indexed sources ·{' '}
                {report.result.corpusCoverage.arxivAbstractsQueried} live arXiv abstracts):{' '}
              </span>
              {report.result.corpusCoverage.limitationNotice}
            </div>
          </div>

          {/* Metrics Row */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Composite Overlap</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {report.result.overallSimilarityPercent}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Exact Match</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {report.result.exactMatchPercent}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Paraphrase / Near</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {report.result.paraphrasePercent ?? 0}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Semantic Overlap</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {report.result.semanticOverlapPercent}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Quoted Material</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {report.result.quotedPercent}%
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Uncited Passages</div>
              <div className="font-mono text-2xl font-semibold text-amber-700 mt-1 tabular-nums">
                {report.result.uncitedFlagCount}
              </div>
            </div>
          </div>

          {/* Algorithm Breakdown Chart */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="font-display text-sm font-semibold text-slate-900 mb-4">
              Mean Similarity Signal Across Matching Algorithms (%)
            </h2>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="layer" tick={{ fontSize: 12, fill: '#475569' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#475569' }} />
                  <Tooltip />
                  <Bar dataKey="score" fill="#1e40af" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Passage-Level Report */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">
                Passage-Level Similarity Findings ({report.result.matches.length})
              </h2>
            </div>
            {report.result.matches.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                No passages exceeded the overlap threshold against the indexed corpus.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {report.result.matches.map((m) => (
                  <div key={m.id} className="p-6 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <StatusLabel status={m.category === 'Potentially Uncited Passage' ? 'Needs review' : 'Verified'} />
                      <div className="text-xs font-mono text-slate-600 tabular-nums">
                        {m.category} · Combined {Math.round(m.combinedScore * 100)}% · TF-IDF {Math.round(m.tfidfCosine * 100)}% · BM25 {Math.round(m.bm25Score * 100)}%
                      </div>
                    </div>
                    <p className="text-sm text-slate-900 bg-amber-50/60 border border-amber-200/70 rounded-lg p-3">
                      {m.inputSentence}
                    </p>
                    <div className="text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">Matched Source:</span> {m.matchedSourceTitle} ({m.matchedSourceType})
                      {m.matchedSourceAuthors ? ` · ${m.matchedSourceAuthors}` : ''}
                      {m.matchedSourceYear ? ` (${m.matchedSourceYear})` : ''}
                      {m.matchedSourceUrl && (
                        <>
                          {' '}
                          ·{' '}
                          <a href={m.matchedSourceUrl} target="_blank" rel="noreferrer" className="text-blue-800 hover:underline">
                            Source
                          </a>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 italic">“{m.matchedExcerpt}”</p>
                    <p className="text-xs text-slate-600">{m.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
