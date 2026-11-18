import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  FolderGit2,
  Sparkles,
  ShieldCheck,
  ScanSearch,
  BookCheck,
  BarChart3,
  ClipboardCheck,
  ArrowRight,
} from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface DashboardSummary {
  stats: {
    documentsProcessed: number;
    researchProjects: number;
    pendingAudits: number;
    citationVerification: { verified: number; total: number };
  };
  geminiConfigured: boolean;
  recentActivity: Array<{
    id: string;
    module: string;
    action: string;
    entity_title: string;
    status: string;
    created_at: string;
  }>;
  recentDocuments: Array<{
    id: string;
    title: string;
    format: string;
    word_count: number;
    status: string;
    updated_at: string;
  }>;
  recentAudits: Array<{
    id: string;
    title: string;
    overall_status: string;
    created_at: string;
  }>;
}

const MODULE_CARDS = [
  { to: '/generator', title: 'Research Paper Generator', desc: 'Generate 12-section IEEE drafts grounded in project code', icon: FileText },
  { to: '/refinement', title: 'Paper Refinement Engine', desc: 'Upload existing papers for clarity, flow & diff review', icon: Sparkles },
  { to: '/project-analyzer', title: 'Technical Project Analyzer', desc: 'Static ZIP/GitHub extraction & code-to-paper cross-check', icon: FolderGit2 },
  { to: '/similarity', title: 'Similarity Checker', desc: 'N-gram, fuzzy, TF-IDF cosine & BM25 overlap analysis', icon: ScanSearch },
  { to: '/citations', title: 'Citation Intelligence', desc: 'Verify DOIs & titles via Crossref, OpenAlex, S2 & arXiv', icon: BookCheck },
  { to: '/writing-analysis', title: 'AI-Writing Analyzer', desc: 'Burstiness, lexical diversity, perplexity & benchmark', icon: BarChart3 },
  { to: '/quality', title: 'Quality Evaluator', desc: '13-dimension methodology & reproducibility audit', icon: ClipboardCheck },
  { to: '/audit', title: 'Research Integrity Audit', desc: 'Unified multi-engine verification & remediation report', icon: ShieldCheck },
];

export function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<DashboardSummary>('/api/dashboard/summary')
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <WorkspaceLayout
      title="Research Workspace"
      subtitle="Database-backed telemetry across your manuscripts, static repository analyses, citation checks, and integrity audits."
      primaryAction={
        <Link
          to="/refinement"
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 transition-colors whitespace-nowrap"
        >
          <span>Refine Existing Paper</span>
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
      }
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Database-Driven Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Documents Processed</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 mt-2 tabular-nums">
            {loading ? '—' : data?.stats.documentsProcessed ?? 0}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Research Projects</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 mt-2 tabular-nums">
            {loading ? '—' : data?.stats.researchProjects ?? 0}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Pending Audits</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 mt-2 tabular-nums">
            {loading ? '—' : data?.stats.pendingAudits ?? 0}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Verified Citations</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 mt-2 tabular-nums">
            {loading
              ? '—'
              : data && data.stats.citationVerification.total > 0
              ? `${data.stats.citationVerification.verified}/${data.stats.citationVerification.total}`
              : '0 audited'}
          </div>
        </div>
      </div>

      {/* Quick-Access Module Cards */}
      <section className="mb-8">
        <h2 className="font-display text-base font-semibold text-slate-900 mb-3">Research Intelligence Modules</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {MODULE_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.to}
                to={card.to}
                className="group bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors flex flex-col justify-between"
              >
                <div>
                  <Icon className="w-4 h-4 text-blue-800 mb-3" aria-hidden="true" />
                  <h3 className="font-display text-sm font-semibold text-slate-900 group-hover:text-blue-900">
                    {card.title}
                  </h3>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{card.desc}</p>
                </div>
                <div className="mt-4 text-xs font-medium text-blue-800 inline-flex items-center gap-1">
                  <span>Open module</span>
                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Recent Documents & Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Document Processing History</h2>
            <Link to="/studio" className="text-xs font-medium text-blue-800 hover:underline">
              Open Studio
            </Link>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Loading documents...</div>
          ) : data && data.recentDocuments.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500 bg-slate-50/70">
                    <th className="py-2.5 px-5 font-medium">Title</th>
                    <th className="py-2.5 px-3 font-medium">Format</th>
                    <th className="py-2.5 px-3 font-medium text-right">Words</th>
                    <th className="py-2.5 px-5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {data.recentDocuments.map((doc) => (
                    <tr key={doc.id} className="hover:bg-slate-50">
                      <td className="py-3 px-5 font-medium text-slate-900 max-w-[260px] truncate">
                        <Link to={`/studio?doc=${doc.id}`} className="hover:text-blue-800">
                          {doc.title}
                        </Link>
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600 uppercase">{doc.format}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-700 text-right tabular-nums">
                        {doc.word_count}
                      </td>
                      <td className="py-3 px-5">
                        <StatusLabel status={doc.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 text-sm text-slate-500">
              No manuscripts yet. Upload a document in Paper Refinement or generate one from a project.
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Recent Activity</h2>
            <Link to="/reports" className="text-xs font-medium text-blue-800 hover:underline">
              All reports
            </Link>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Loading activity...</div>
          ) : data && data.recentActivity.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {data.recentActivity.map((act) => (
                <li key={act.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-500">{act.module}</span>
                    <StatusLabel status={act.status} />
                  </div>
                  <div className="text-sm font-medium text-slate-900 mt-1 truncate">{act.action}</div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {act.entity_title} · {new Date(act.created_at).toLocaleDateString()}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-6 text-sm text-slate-500">No logged activity yet.</div>
          )}
        </section>
      </div>
    </WorkspaceLayout>
  );
}
