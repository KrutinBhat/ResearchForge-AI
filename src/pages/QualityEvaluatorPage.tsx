import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Info } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface DocumentOption {
  id: string;
  title: string;
}

interface QualityResult {
  title: string;
  evaluation: {
    dimensions: Array<{
      dimension: string;
      status: string;
      evidence: string;
      why?: string;
      location?: string;
      recommendation: string;
    }>;
    weaknesses: string[];
    missingElements: string[];
    recommendations: string[];
    llmCritique?: string;
    methodologyNote: string;
  };
}

export function QualityEvaluatorPage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [customText, setCustomText] = useState('');
  const [includeLlmCritique, setIncludeLlmCritique] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<QualityResult | null>(null);

  useEffect(() => {
    apiFetch<{ documents: DocumentOption[] }>('/api/documents')
      .then((res) => {
        setDocuments(res.documents);
        if (res.documents.length > 0) setDocumentId(res.documents[0].id);
      })
      .catch(() => {});
  }, []);

  const handleEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setRunning(true);
    try {
      const res = await apiFetch<QualityResult>('/api/research-quality/evaluate', {
        method: 'POST',
        body: JSON.stringify({
          documentId: customText.trim() ? undefined : documentId,
          text: customText.trim() || undefined,
          includeLlmCritique,
        }),
      });
      setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <WorkspaceLayout
      title="Research Quality Evaluator"
      subtitle="Assess 13 structural and methodological criteria (including abstract, gap, ablations, reproducibility, and ethics) with location-anchored recommendations."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleEvaluate} className="bg-white border border-slate-200 rounded-xl p-6 mb-8 space-y-4">
        <div>
          <label htmlFor="qual-doc" className="block text-xs font-medium text-slate-700 mb-1">
            Select workspace manuscript
          </label>
          <select
            id="qual-doc"
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
          <label htmlFor="qual-text" className="block text-xs font-medium text-slate-700 mb-1">
            Or paste manuscript draft directly
          </label>
          <textarea
            id="qual-text"
            rows={4}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Paste paper sections and references for structural quality review..."
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={includeLlmCritique}
            onChange={(e) => setIncludeLlmCritique(e.target.checked)}
            className="rounded border-slate-300 text-blue-800"
          />
          <span>Include AI peer-reviewer methodological critique (when Gemini is active)</span>
        </label>

        <div>
          <button
            type="submit"
            disabled={running || (!documentId && !customText.trim())}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
          >
            <ClipboardCheck className="w-4 h-4" aria-hidden="true" />
            <span>{running ? 'Evaluating 13 rubric criteria...' : 'Evaluate Research Quality'}</span>
          </button>
        </div>
      </form>

      {result && (
        <div className="space-y-6">
          <div className="p-4 rounded-xl border border-slate-200 bg-slate-100/70 flex items-start gap-3 text-xs text-slate-700">
            <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div>{result.evaluation.methodologyNote}</div>
          </div>

          {result.evaluation.llmCritique && (
            <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-5 text-xs text-blue-950 space-y-1.5">
              <div className="font-semibold text-blue-900">AI Peer-Review Methodological Critique</div>
              <p className="whitespace-pre-wrap leading-relaxed">{result.evaluation.llmCritique}</p>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200">
              <h2 className="font-display text-sm font-semibold text-slate-900">
                Structural & Methodological Rubric ({result.evaluation.dimensions.length} Criteria)
              </h2>
            </div>
            <div className="divide-y divide-slate-200">
              {result.evaluation.dimensions.map((d, i) => (
                <div key={i} className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
                  <div className="lg:col-span-3">
                    <div className="text-sm font-semibold text-slate-900">{d.dimension}</div>
                    {d.location && <div className="text-[11px] font-mono text-slate-500 mt-0.5">{d.location}</div>}
                    <div className="mt-1">
                      <StatusLabel status={d.status} />
                    </div>
                  </div>
                  <div className="lg:col-span-4 text-xs text-slate-700 space-y-1">
                    <div>
                      <span className="font-medium text-slate-900">Observed Evidence: </span>
                      {d.evidence}
                    </div>
                    {d.why && <div className="text-slate-500">{d.why}</div>}
                  </div>
                  <div className="lg:col-span-5 text-xs text-slate-600">
                    <span className="font-medium text-slate-900">Actionable Recommendation: </span>
                    {d.recommendation}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {result.evaluation.recommendations.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">Priority Revision Checklist</h3>
              <ul className="list-disc pl-5 space-y-1.5 text-xs text-slate-700">
                {result.evaluation.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </WorkspaceLayout>
  );
}
