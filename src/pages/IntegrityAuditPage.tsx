import React, { useEffect, useState } from 'react';
import { ShieldCheck, Download } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiDownload, apiFetch } from '../lib/api';

interface DocumentOption {
  id: string;
  title: string;
  project_id?: string | null;
}

interface ProjectOption {
  id: string;
  title: string;
}

interface AuditResponse {
  auditId: string;
  title: string;
  audit: {
    overallStatus: string;
    counts: { verified: number; needsReview: number; unverified: number; notEvaluated: number };
    findings: Array<{
      area: string;
      classification: string;
      summary: string;
      evidenceDetail: string;
      remediation: string;
    }>;
    auditSummary: string;
  };
}

export function IntegrityAuditPage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AuditResponse | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ documents: DocumentOption[] }>('/api/documents'),
      apiFetch<{ projects: ProjectOption[] }>('/api/projects'),
    ])
      .then(([dRes, pRes]) => {
        setDocuments(dRes.documents);
        setProjects(pRes.projects);
        if (dRes.documents.length > 0) {
          setDocumentId(dRes.documents[0].id);
          setProjectId(dRes.documents[0].project_id || '');
        }
      })
      .catch(() => {});
  }, []);

  const handleRunAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!documentId) return;
    setError('');
    setRunning(true);
    try {
      const res = await apiFetch<AuditResponse>('/api/integrity-audit/run', {
        method: 'POST',
        body: JSON.stringify({ documentId, projectId: projectId || undefined }),
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
      title="Final Research Integrity Audit"
      subtitle="Unify similarity scans, citation verification, code-to-paper cross-checks, methodological completeness, writing consistency, and corpus transparency into one 6-pillar audit."
      primaryAction={
        result && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                apiDownload(`/api/integrity-audit/${result.auditId}/export?format=md`, `integrity-audit-${result.auditId}.md`)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export .md</span>
            </button>
            <button
              type="button"
              onClick={() =>
                apiDownload(`/api/integrity-audit/${result.auditId}/export?format=json`, `integrity-audit-${result.auditId}.json`)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export .json</span>
            </button>
          </div>
        )
      }
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleRunAudit} className="bg-white border border-slate-200 rounded-xl p-6 mb-8 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="aud-doc" className="block text-xs font-medium text-slate-700 mb-1">
              Target manuscript
            </label>
            <select
              id="aud-doc"
              value={documentId}
              onChange={(e) => {
                setDocumentId(e.target.value);
                const d = documents.find((x) => x.id === e.target.value);
                if (d?.project_id) setProjectId(d.project_id);
              }}
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

          <div>
            <label htmlFor="aud-proj" className="block text-xs font-medium text-slate-700 mb-1">
              Linked source repository for code cross-check (optional)
            </label>
            <select
              id="aud-proj"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">None linked</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={!documentId || running}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
        >
          <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          <span>{running ? 'Compiling 6-pillar audit...' : 'Generate Final Integrity Audit'}</span>
        </button>
      </form>

      {result && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs text-slate-500">Unified 6-Pillar Audit Verdict</div>
              <h2 className="font-display text-lg font-bold text-slate-900 mt-1">{result.title}</h2>
              <p className="text-sm text-slate-600 mt-1">{result.audit.auditSummary}</p>
            </div>
            <div className="flex items-center gap-6">
              <StatusLabel status={result.audit.overallStatus} />
              <div className="text-xs font-mono text-slate-600 tabular-nums">
                {result.audit.counts.verified} Verified · {result.audit.counts.needsReview} Review ·{' '}
                {result.audit.counts.unverified} Unverified · {result.audit.counts.notEvaluated} Not Evaluated
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {result.audit.findings.map((f, i) => (
              <div key={i} className="p-6 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-sm font-semibold text-slate-900">{f.area}</h3>
                  <StatusLabel status={f.classification} />
                </div>
                <p className="text-sm text-slate-800">{f.summary}</p>
                <p className="text-xs text-slate-600">
                  <span className="font-medium text-slate-800">Evidence:</span> {f.evidenceDetail}
                </p>
                <p className="text-xs text-blue-900">
                  <span className="font-medium">Recommended action:</span> {f.remediation}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
