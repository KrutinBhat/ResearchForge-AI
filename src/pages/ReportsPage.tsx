import { useEffect, useState } from 'react';
import { Download, History } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiDownload, apiFetch } from '../lib/api';

interface ReportsPayload {
  similarity: Array<{ id: string; title: string; overall_similarity: number; created_at: string; results: any }>;
  citations: Array<{ id: string; title: string; summary: any; created_at: string }>;
  writing: Array<{ id: string; title: string; analysis: any; created_at: string }>;
  quality: Array<{ id: string; title: string; evaluation: any; created_at: string }>;
  audits: Array<{ id: string; title: string; overall_status: string; summary: any; created_at: string }>;
  refinementJobs: Array<{ id: string; mode: string; status: string; progress: number; created_at: string }>;
}

export function ReportsPage() {
  const [data, setData] = useState<ReportsPayload | null>(null);
  const [tab, setTab] = useState<'audits' | 'similarity' | 'citations' | 'writing' | 'quality' | 'refinement'>('audits');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<ReportsPayload>('/api/reports')
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const downloadJson = (filename: string, payload: any) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <WorkspaceLayout
      title="Reports & Analysis History"
      subtitle="Inspect persisted integrity audits, similarity scans, citation checks, stylometric profiles, quality evaluations, and refinement jobs."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6 w-fit">
        {(
          [
            ['audits', 'Integrity Audits'],
            ['similarity', 'Similarity'],
            ['citations', 'Citations'],
            ['writing', 'Writing Analysis'],
            ['quality', 'Quality Reviews'],
            ['refinement', 'Refinement Jobs'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading persisted reports...</div>
        ) : !data ? null : (
          <div className="divide-y divide-slate-200">
            {tab === 'audits' &&
              (data.audits.length === 0 ? (
                <EmptyState label="No integrity audits executed yet." />
              ) : (
                data.audits.map((a) => (
                  <div key={a.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{a.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {new Date(a.created_at).toLocaleString()} · {a.summary.verified ?? 0} verified ·{' '}
                        {a.summary.needsReview ?? 0} review · {a.summary.unverified ?? 0} unverified
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusLabel status={a.overall_status} />
                      <button
                        type="button"
                        onClick={() => downloadJson(`audit-${a.id}.json`, a)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => apiDownload(`/api/integrity-audit/${a.id}/export?format=md`, `audit-${a.id}.md`)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>MD</span>
                      </button>
                    </div>
                  </div>
                ))
              ))}

            {tab === 'similarity' &&
              (data.similarity.length === 0 ? (
                <EmptyState label="No similarity reports yet." />
              ) : (
                data.similarity.map((s) => (
                  <div key={s.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{s.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        Composite overlap: {s.overall_similarity}% · {new Date(s.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadJson(`similarity-${s.id}.json`, s)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>JSON</span>
                    </button>
                  </div>
                ))
              ))}

            {tab === 'citations' &&
              (data.citations.length === 0 ? (
                <EmptyState label="No citation verification reports yet." />
              ) : (
                data.citations.map((c) => (
                  <div key={c.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{c.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        Verified: {c.summary.verifiedCount ?? 0}/{c.summary.totalReferences ?? 0} ·{' '}
                        {new Date(c.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadJson(`citations-${c.id}.json`, c)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>JSON</span>
                    </button>
                  </div>
                ))
              ))}

            {tab === 'writing' &&
              (data.writing.length === 0 ? (
                <EmptyState label="No stylometric analyses yet." />
              ) : (
                data.writing.map((w) => (
                  <div key={w.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{w.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        Fano burstiness: {w.analysis?.metrics?.burstinessFanoFactor ?? '—'} · TTR:{' '}
                        {w.analysis?.metrics?.lexicalDiversityTTR ?? '—'} · {new Date(w.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadJson(`writing-${w.id}.json`, w)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>JSON</span>
                    </button>
                  </div>
                ))
              ))}

            {tab === 'quality' &&
              (data.quality.length === 0 ? (
                <EmptyState label="No research quality evaluations yet." />
              ) : (
                data.quality.map((q) => (
                  <div key={q.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{q.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {q.evaluation?.dimensions?.length ?? 0} criteria evaluated ·{' '}
                        {new Date(q.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadJson(`quality-${q.id}.json`, q)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>JSON</span>
                    </button>
                  </div>
                ))
              ))}

            {tab === 'refinement' &&
              (data.refinementJobs.length === 0 ? (
                <EmptyState label="No refinement jobs logged yet." />
              ) : (
                data.refinementJobs.map((j) => (
                  <div key={j.id} className="p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm text-slate-900">Mode: {j.mode}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        Progress: {j.progress}% · {new Date(j.created_at).toLocaleString()}
                      </div>
                    </div>
                    <StatusLabel status={j.status} />
                  </div>
                ))
              ))}
          </div>
        )}
      </div>
    </WorkspaceLayout>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="p-10 text-center text-sm text-slate-500">
      <History className="w-7 h-7 text-slate-300 mx-auto mb-2" aria-hidden="true" />
      {label}
    </div>
  );
}
