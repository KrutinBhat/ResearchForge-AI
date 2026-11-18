import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, AlertTriangle, ArrowRight } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { apiFetch } from '../lib/api';

interface ProjectOption {
  id: string;
  title: string;
  domain: string;
  analysis: {
    fileCount: number;
    languages: string[];
    models: Array<{ name: string }>;
  };
}

interface GeneratedResult {
  documentId: string;
  generated: {
    title: string;
    keywords: string[];
    sections: Array<{ id: string; heading: string; content: string }>;
    references: string[];
    missingInformationPrompts: string[];
    groundingSummary: string;
    engineUsed: string;
  };
}

export function PaperGeneratorPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [synopsis, setSynopsis] = useState('');
  const [datasetNotes, setDatasetNotes] = useState('');
  const [experimentalResults, setExperimentalResults] = useState('');
  const [literatureNotes, setLiteratureNotes] = useState('');
  const [paperFormat, setPaperFormat] = useState<'IEEE' | 'APA'>('IEEE');
  const [engineMode, setEngineMode] = useState<'gemini' | 'local'>('gemini');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GeneratedResult | null>(null);

  useEffect(() => {
    apiFetch<{ projects: ProjectOption[] }>('/api/projects')
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) {
          setProjectId(res.projects[0].id);
          setTitle(res.projects[0].title);
        }
      })
      .catch(() => {});
  }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setGenerating(true);
    try {
      const data = await apiFetch<GeneratedResult>('/api/research-generator/generate', {
        method: 'POST',
        body: JSON.stringify({
          projectId: projectId || undefined,
          title,
          synopsis,
          datasetNotes,
          experimentalResults,
          literatureNotes,
          paperFormat,
          engineMode,
        }),
      });
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <WorkspaceLayout
      title="AI Research Paper Generator"
      subtitle="Generate structured 12-section IEEE manuscripts grounded strictly in extracted project architecture and verified experimental evidence. Missing evidence is explicitly flagged rather than fabricated."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form onSubmit={handleGenerate} className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4 h-fit">
          <div>
            <label htmlFor="gen-proj" className="block text-xs font-medium text-slate-700 mb-1">
              Ground in analyzed project (optional)
            </label>
            <select
              id="gen-proj"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                const p = projects.find((x) => x.id === e.target.value);
                if (p && !title) setTitle(p.title);
              }}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Standalone (synopsis & notes only)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.analysis.fileCount} files)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="gen-title" className="block text-xs font-medium text-slate-700 mb-1">
              Manuscript title
            </label>
            <input
              id="gen-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Privacy-Preserving Arrhythmia Classification via Federated 1D-ResNet"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="gen-synopsis" className="block text-xs font-medium text-slate-700 mb-1">
              Project synopsis & research objective
            </label>
            <textarea
              id="gen-synopsis"
              rows={3}
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="Describe the core research question, system design, and engineering motivation..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="gen-dataset" className="block text-xs font-medium text-slate-700 mb-1">
              Dataset documentation (splits, sample counts, provenance)
            </label>
            <textarea
              id="gen-dataset"
              rows={2}
              value={datasetNotes}
              onChange={(e) => setDatasetNotes(e.target.value)}
              placeholder="Leave blank to trigger missing-input prompt if undetected in code..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="gen-exp" className="block text-xs font-medium text-slate-700 mb-1">
              Verified experimental results & baseline metrics
            </label>
            <textarea
              id="gen-exp"
              rows={2}
              value={experimentalResults}
              onChange={(e) => setExperimentalResults(e.target.value)}
              placeholder="e.g., Macro F1 = 0.914, AUROC = 0.968 across 30 rounds..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="gen-lit" className="block text-xs font-medium text-slate-700 mb-1">
              Reference notes / citations (one per line)
            </label>
            <textarea
              id="gen-lit"
              rows={2}
              value={literatureNotes}
              onChange={(e) => setLiteratureNotes(e.target.value)}
              placeholder="[1] B. McMahan et al., Communication-Efficient Learning..., AISTATS 2017."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">Manuscript template format</span>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-3">
              <button
                type="button"
                onClick={() => setPaperFormat('IEEE')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  paperFormat === 'IEEE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                IEEE Two-Column
              </button>
              <button
                type="button"
                onClick={() => setPaperFormat('APA')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  paperFormat === 'APA' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                APA 7th Edition
              </button>
            </div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">Synthesis engine</span>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setEngineMode('gemini')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  engineMode === 'gemini' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Gemini AI (Grounded)
              </button>
              <button
                type="button"
                onClick={() => setEngineMode('local')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  engineMode === 'local' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Local Structural (Offline)
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={generating || !title.trim()}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
          >
            {generating ? `Synthesizing grounded ${paperFormat} paper...` : `Generate ${paperFormat} Research Paper`}
          </button>
        </form>

        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          {result ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    Engine: {result.generated.engineUsed} · {result.generated.groundingSummary}
                  </div>
                  <h2 className="font-display text-xl font-bold text-slate-900 mt-1">{result.generated.title}</h2>
                </div>
                <Link
                  to={`/studio?doc=${result.documentId}`}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 whitespace-nowrap"
                >
                  <span>Edit in Writing Studio</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              </div>

              {result.generated.missingInformationPrompts.length > 0 && (
                <div className="p-4 rounded-lg border border-amber-200 bg-amber-50 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                    <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Missing Information Detected (Not Fabricated)</span>
                  </div>
                  <ul className="list-disc pl-5 text-xs text-amber-800 space-y-1">
                    {result.generated.missingInformationPrompts.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-5">
                {result.generated.sections.map((sec) => (
                  <article key={sec.id} className="border-b border-slate-100 pb-4 last:border-b-0">
                    <h3 className="font-display text-sm font-bold text-slate-900 mb-1.5">{sec.heading}</h3>
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{sec.content}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-slate-500">
              <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" aria-hidden="true" />
              Configure your project source and research notes on the left to generate a grounded IEEE draft.
            </div>
          )}
        </div>
      </div>
    </WorkspaceLayout>
  );
}
