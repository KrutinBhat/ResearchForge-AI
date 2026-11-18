import React, { useEffect, useState } from 'react';
import { FolderGit2, Upload, GitBranch, ShieldCheck, Trash2 } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface ProjectRecord {
  id: string;
  title: string;
  description: string;
  domain: string;
  source_type: string;
  source_url: string;
  analysis: {
    projectName: string;
    languages: string[];
    fileCount: number;
    totalLines: number;
    frameworks: string[];
    dependencies: string[];
    architecture: {
      backend: string[];
      frontend: string[];
      database: string[];
      tests: string[];
      configs: string[];
    };
    endpoints: Array<{ method: string; path: string; file: string }>;
    models: Array<{ name: string; type: string; file: string; details: string }>;
    algorithms: string[];
    databases: Array<{ table: string; columns: string[]; file: string }>;
    evaluationEvidence: Array<{ source: string; metrics: Record<string, any> }>;
    datasetsDetected: string[];
    reproducibilityNotes: string[];
    securityWarnings?: string[];
  };
}

interface DocumentSummary {
  id: string;
  title: string;
}

interface CrossCheckFinding {
  id: string;
  category: string;
  status: string;
  claimExcerpt: string;
  codeEvidence: string;
  explanation: string;
}

export function ProjectAnalyzerPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  // Cross-check state
  const [checkDocId, setCheckDocId] = useState('');
  const [customPaperText, setCustomPaperText] = useState('');
  const [crossFindings, setCrossFindings] = useState<CrossCheckFinding[]>([]);
  const [checking, setChecking] = useState(false);

  const loadData = async () => {
    try {
      const [pRes, dRes] = await Promise.all([
        apiFetch<{ projects: ProjectRecord[] }>('/api/projects'),
        apiFetch<{ documents: DocumentSummary[] }>('/api/documents'),
      ]);
      setProjects(pRes.projects);
      setDocuments(dRes.documents);
      if (pRes.projects.length > 0 && !selectedProjectId) {
        setSelectedProjectId(pRes.projects[0].id);
      }
      if (dRes.documents.length > 0 && !checkDocId) {
        setCheckDocId(dRes.documents[0].id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleZipUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!zipFile) return;
    setError('');
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('archive', zipFile);
      if (projectTitle.trim()) fd.append('title', projectTitle.trim());
      const res = await apiFetch<{ project: ProjectRecord }>('/api/projects/analyze-zip', {
        method: 'POST',
        body: fd,
      });
      setProjects((prev) => [res.project, ...prev]);
      setSelectedProjectId(res.project.id);
      setZipFile(null);
      setProjectTitle('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleGithubAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim()) return;
    setError('');
    setAnalyzing(true);
    try {
      const res = await apiFetch<{ project: ProjectRecord }>('/api/projects/analyze-github', {
        method: 'POST',
        body: JSON.stringify({ repoUrl: githubUrl.trim(), title: projectTitle.trim() }),
      });
      setProjects((prev) => [res.project, ...prev]);
      setSelectedProjectId(res.project.id);
      setGithubUrl('');
      setProjectTitle('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCrossCheck = async () => {
    if (!selectedProjectId) return;
    setError('');
    setChecking(true);
    try {
      const res = await apiFetch<{ findings: CrossCheckFinding[] }>('/api/project-analysis/crosscheck', {
        method: 'POST',
        body: JSON.stringify({
          projectId: selectedProjectId,
          documentId: customPaperText.trim() ? undefined : checkDocId,
          customText: customPaperText.trim() || undefined,
        }),
      });
      setCrossFindings(res.findings);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (selectedProjectId === id) setSelectedProjectId('');
  };

  const selected = projects.find((p) => p.id === selectedProjectId);

  return (
    <WorkspaceLayout
      title="Technical Project-to-Paper Analyzer"
      subtitle="Statically parse ZIP archives and GitHub repositories (Python, JS/TS, Java, C/C++, SQL, configs) without executing untrusted code, and cross-check paper claims against real implementation."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Upload & GitHub Ingestion */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <form onSubmit={handleZipUpload} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 font-display text-sm font-semibold text-slate-900">
            <Upload className="w-4 h-4 text-blue-800" aria-hidden="true" />
            <span>Analyze Project ZIP Archive</span>
          </div>
          <div>
            <label htmlFor="proj-title" className="block text-xs font-medium text-slate-700 mb-1">
              Project title (optional)
            </label>
            <input
              id="proj-title"
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              placeholder="e.g., Distributed Telemetry Engine"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="zip-input" className="block text-xs font-medium text-slate-700 mb-1">
              Select .zip source repository (max 25 MB)
            </label>
            <input
              id="zip-input"
              type="file"
              accept=".zip"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border file:border-slate-300 file:text-xs file:font-medium file:bg-slate-50 hover:file:bg-slate-100"
            />
          </div>
          <button
            type="submit"
            disabled={!zipFile || analyzing}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
          >
            {analyzing ? 'Extracting statically...' : 'Upload & Extract Project'}
          </button>
        </form>

        <form onSubmit={handleGithubAnalyze} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2 font-display text-sm font-semibold text-slate-900">
            <GitBranch className="w-4 h-4 text-blue-800" aria-hidden="true" />
            <span>Analyze Public GitHub Repository</span>
          </div>
          <div>
            <label htmlFor="github-url" className="block text-xs font-medium text-slate-700 mb-1">
              Repository URL
            </label>
            <input
              id="github-url"
              type="url"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <p className="text-xs text-slate-500">
            Reads repository tree and source files statically via GitHub API. No uploaded code is ever executed.
          </p>
          <button
            type="submit"
            disabled={!githubUrl.trim() || analyzing}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {analyzing ? 'Inspecting repository...' : 'Inspect GitHub Repository'}
          </button>
        </form>
      </div>

      {/* Analyzed Projects Selector & Evidence Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="font-display text-sm font-semibold text-slate-900 mb-3">Analyzed Projects</h2>
          {loading ? (
            <div className="text-xs text-slate-500">Loading projects...</div>
          ) : projects.length === 0 ? (
            <div className="text-xs text-slate-500">No analyzed projects yet. Upload a ZIP or inspect a GitHub URL.</div>
          ) : (
            <ul className="space-y-2">
              {projects.map((proj) => (
                <li key={proj.id}>
                  <div
                    className={`p-3 rounded-lg border transition-colors flex items-start justify-between gap-2 ${
                      selectedProjectId === proj.id ? 'border-blue-600 bg-blue-50/50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedProjectId(proj.id)}
                      className="text-left flex-1 min-w-0"
                    >
                      <div className="text-sm font-medium text-slate-900 truncate">{proj.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        {proj.analysis.fileCount} files · {proj.analysis.languages.join(', ') || 'Source'}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteProject(proj.id)}
                      aria-label={`Delete project ${proj.title}`}
                      className="p-1 text-slate-400 hover:text-red-700"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6">
          {selected ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">{selected.title}</h2>
                  <p className="text-xs text-slate-500 mt-1">
                    {selected.analysis.fileCount} files · {selected.analysis.totalLines.toLocaleString()} LOC ·{' '}
                    {selected.analysis.frameworks.join(', ') || 'Standard runtime'}
                  </p>
                </div>
                <StatusLabel status="Verified" />
              </div>

              {selected.analysis.securityWarnings && selected.analysis.securityWarnings.length > 0 && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
                  <div className="font-semibold">Static Archive Safety Notices</div>
                  {selected.analysis.securityWarnings.map((w, idx) => (
                    <div key={idx}>{w}</div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
                <div>
                  <h3 className="font-semibold text-slate-900 mb-2">Extracted Models & Algorithms</h3>
                  {selected.analysis.models.length > 0 ? (
                    <ul className="space-y-1.5 text-slate-700">
                      {selected.analysis.models.map((m, i) => (
                        <li key={i} className="font-mono bg-slate-50 border border-slate-200 rounded p-2">
                          <div className="font-semibold text-slate-900">{m.name}</div>
                          <div className="text-slate-500">{m.type} · {m.file}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-slate-500">No explicit ML model classes detected.</p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900 mb-2">API Endpoints & SQL Schemas</h3>
                  {selected.analysis.endpoints.length > 0 && (
                    <ul className="space-y-1 font-mono text-slate-700 mb-3">
                      {selected.analysis.endpoints.slice(0, 5).map((ep, i) => (
                        <li key={i} className="truncate">
                          {ep.method} {ep.path} <span className="text-slate-400">({ep.file})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.analysis.databases.length > 0 && (
                    <ul className="space-y-1 font-mono text-slate-700">
                      {selected.analysis.databases.map((db, i) => (
                        <li key={i}>
                          TABLE {db.table} ({db.columns.slice(0, 5).join(', ')})
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.analysis.endpoints.length === 0 && selected.analysis.databases.length === 0 && (
                    <p className="text-slate-500">No REST endpoints or SQL CREATE TABLE definitions found.</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs pt-2 border-t border-slate-100">
                <div>
                  <h3 className="font-semibold text-slate-900 mb-1.5">Evaluation Artifacts & Datasets</h3>
                  <div className="text-slate-600 space-y-1">
                    <div>Datasets: {selected.analysis.datasetsDetected.join(', ') || 'None explicitly matched'}</div>
                    <div>
                      Metrics:{' '}
                      {selected.analysis.evaluationEvidence.length > 0
                        ? selected.analysis.evaluationEvidence.map((e) => `${e.source}: ${JSON.stringify(e.metrics)}`).join('; ')
                        : 'No JSON evaluation log found'}
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900 mb-1.5">Reproducibility & Test Coverage</h3>
                  <div className="text-slate-600 space-y-1">
                    <div>Test files: {selected.analysis.architecture.tests.join(', ') || 'None detected'}</div>
                    <div>Notes: {selected.analysis.reproducibilityNotes.join('; ') || 'No seed/pinned config found'}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">
              <FolderGit2 className="w-8 h-8 text-slate-300 mx-auto mb-2" aria-hidden="true" />
              Select an analyzed project to inspect extracted architecture and code evidence.
            </div>
          )}
        </div>
      </div>

      {/* Paper-vs-Code Cross-Check Runner */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-center gap-2 font-display text-base font-semibold text-slate-900 mb-2">
          <ShieldCheck className="w-4 h-4 text-blue-800" aria-hidden="true" />
          <span>Cross-Check Research Paper Against Source Code</span>
        </div>
        <p className="text-xs text-slate-600 mb-4">
          Compare a manuscript against the selected project to detect unsupported accuracy claims, unimplemented models, or missing reproducibility details.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label htmlFor="cc-doc" className="block text-xs font-medium text-slate-700 mb-1">
              Select workspace manuscript
            </label>
            <select
              id="cc-doc"
              value={checkDocId}
              onChange={(e) => setCheckDocId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">-- Select document --</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cc-custom" className="block text-xs font-medium text-slate-700 mb-1">
              Or paste manuscript excerpt to verify
            </label>
            <input
              id="cc-custom"
              type="text"
              value={customPaperText}
              onChange={(e) => setCustomPaperText(e.target.value)}
              placeholder="e.g., Our XGBoost model achieved 98.5% accuracy..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleCrossCheck}
          disabled={!selectedProjectId || checking}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
        >
          {checking ? 'Cross-checking claims...' : 'Run Code-to-Paper Cross-Check'}
        </button>

        {crossFindings.length > 0 && (
          <div className="mt-6 border-t border-slate-200 pt-5 space-y-3">
            {crossFindings.map((f) => (
              <div key={f.id} className="p-4 rounded-lg border border-slate-200 bg-slate-50/70">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <span className="text-xs font-semibold text-slate-900">{f.category}</span>
                  <StatusLabel status={f.status} />
                </div>
                <div className="text-xs text-slate-700 mb-1">
                  <span className="font-medium">Paper statement:</span> {f.claimExcerpt}
                </div>
                <div className="text-xs text-slate-600 mb-1">
                  <span className="font-medium">Repository evidence:</span> {f.codeEvidence}
                </div>
                <div className="text-xs text-slate-500">{f.explanation}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </WorkspaceLayout>
  );
}
