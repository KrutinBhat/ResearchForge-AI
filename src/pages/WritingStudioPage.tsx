import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Save, Download, Plus, Sparkles, History } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { apiDownload, apiFetch } from '../lib/api';

interface Section {
  id: string;
  heading: string;
  content: string;
}

interface DocumentDetail {
  id: string;
  title: string;
  format: string;
  citation_style: string;
  sections: Section[];
  references: string[];
  word_count: number;
}

interface VersionEntry {
  id: string;
  version_number: number;
  label: string;
  sections: Section[];
  created_at: string;
}

export function WritingStudioPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [documents, setDocuments] = useState<Array<{ id: string; title: string }>>([]);
  const [activeDoc, setActiveDoc] = useState<DocumentDetail | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [activeSecIdx, setActiveSecIdx] = useState(0);
  const [newRef, setNewRef] = useState('');
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  const loadList = async () => {
    const res = await apiFetch<{ documents: Array<{ id: string; title: string }> }>('/api/documents');
    setDocuments(res.documents);
    const paramId = searchParams.get('doc') || res.documents[0]?.id;
    if (paramId) {
      await loadDocument(paramId);
    }
  };

  const loadDocument = async (id: string) => {
    try {
      const res = await apiFetch<{ document: DocumentDetail; versions: VersionEntry[] }>(`/api/documents/${id}`);
      setActiveDoc(res.document);
      setVersions(res.versions);
      setActiveSecIdx(0);
      setSearchParams({ doc: id }, { replace: true });
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    loadList().catch((e) => setError(e.message));
  }, []);

  const handleSectionChange = (idx: number, field: 'heading' | 'content', val: string) => {
    if (!activeDoc) return;
    const next = [...activeDoc.sections];
    next[idx] = { ...next[idx], [field]: val };
    setActiveDoc({ ...activeDoc, sections: next });
  };

  const handleAddSection = () => {
    if (!activeDoc || !newSectionTitle.trim()) return;
    const next = [
      ...activeDoc.sections,
      { id: `sec_${Date.now()}`, heading: newSectionTitle.trim(), content: '' },
    ];
    setActiveDoc({ ...activeDoc, sections: next });
    setActiveSecIdx(next.length - 1);
    setNewSectionTitle('');
  };

  const handleAddReference = () => {
    if (!activeDoc || !newRef.trim()) return;
    const idx = activeDoc.references.length + 1;
    const formatted = /^\[\d+\]/.test(newRef.trim()) ? newRef.trim() : `[${idx}] ${newRef.trim()}`;
    setActiveDoc({ ...activeDoc, references: [...activeDoc.references, formatted] });
    setNewRef('');
  };

  const handleToneCleanup = () => {
    if (!activeDoc) return;
    const sec = activeDoc.sections[activeSecIdx];
    if (!sec) return;
    const cleaned = sec.content
      .replace(/\butilize\b/gi, 'use')
      .replace(/\butilized\b/gi, 'used')
      .replace(/\bin order to\b/gi, 'to')
      .replace(/\bdue to the fact that\b/gi, 'because')
      .replace(/\bvery\s+/gi, '');
    handleSectionChange(activeSecIdx, 'content', cleaned);
    setStatusMsg('Applied concise academic phrasing check to current section.');
  };

  const handleSave = async () => {
    if (!activeDoc) return;
    setSaving(true);
    setStatusMsg('');
    setError('');
    try {
      const res = await apiFetch<{ versionNumber: number; wordCount: number }>(`/api/documents/${activeDoc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: activeDoc.title,
          citationStyle: activeDoc.citation_style,
          sections: activeDoc.sections,
          references: activeDoc.references,
          versionLabel: 'Studio Edit',
        }),
      });
      setStatusMsg(`Saved Revision v${res.versionNumber} (${res.wordCount} words).`);
      await loadDocument(activeDoc.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async (fmt: 'docx' | 'pdf' | 'tex' | 'md') => {
    if (!activeDoc) return;
    try {
      await apiDownload(`/api/documents/${activeDoc.id}/export?format=${fmt}`, `manuscript.${fmt}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const currentSection = activeDoc?.sections[activeSecIdx];

  return (
    <WorkspaceLayout
      title="Academic Writing Studio"
      subtitle="Structured IEEE and APA manuscript editor with section navigation, citation insertion, version history, and binary DOCX, PDF, and LaTeX export."
      primaryAction={
        activeDoc && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50 whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{saving ? 'Saving...' : 'Save Revision'}</span>
          </button>
        )
      }
    >
      {error && (
        <div role="alert" className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800">
          {error}
        </div>
      )}
      {statusMsg && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900">
          {statusMsg}
        </div>
      )}

      {/* Top Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Select manuscript"
            value={activeDoc?.id || ''}
            onChange={(e) => loadDocument(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white max-w-xs"
          >
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>

          {activeDoc && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['IEEE', 'APA'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setActiveDoc({ ...activeDoc, citation_style: st })}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                    activeDoc.citation_style === st ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          )}
        </div>

        {activeDoc && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleExport('docx')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>DOCX</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('pdf')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>PDF</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('tex')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              <span>LaTeX</span>
            </button>
          </div>
        )}
      </div>

      {activeDoc ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Outline & Version History */}
          <div className="lg:col-span-3 space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="font-display text-xs font-semibold text-slate-500 mb-3">Sections</h2>
              <ul className="space-y-1">
                {activeDoc.sections.map((sec, idx) => (
                  <li key={sec.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSecIdx(idx)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium truncate transition-colors ${
                        activeSecIdx === idx ? 'bg-blue-50 text-blue-900' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {sec.heading}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 pt-3 border-t border-slate-200 flex gap-1.5">
                <input
                  type="text"
                  value={newSectionTitle}
                  onChange={(e) => setNewSectionTitle(e.target.value)}
                  placeholder="New section..."
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                />
                <button
                  type="button"
                  onClick={handleAddSection}
                  aria-label="Add section"
                  className="p-1.5 bg-slate-900 text-white rounded-md hover:bg-slate-800"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-3">
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Version History</span>
              </div>
              <ul className="space-y-2 text-xs">
                {versions.map((v) => (
                  <li key={v.id} className="pb-2 border-b border-slate-100 last:border-b-0">
                    <div className="font-medium text-slate-900">
                      v{v.version_number} · {v.label}
                    </div>
                    <div className="text-slate-400 mt-0.5 tabular-nums">
                      {new Date(v.created_at).toLocaleString()}
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveDoc({ ...activeDoc, sections: v.sections })}
                      className="text-blue-800 hover:underline mt-1"
                    >
                      Load into editor
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Center Editor */}
          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div>
              <label htmlFor="studio-title" className="block text-xs font-medium text-slate-500 mb-1">
                Document Title
              </label>
              <input
                id="studio-title"
                type="text"
                value={activeDoc.title}
                onChange={(e) => setActiveDoc({ ...activeDoc, title: e.target.value })}
                className="w-full font-display text-lg font-bold text-slate-900 border-b border-slate-200 pb-2 focus:outline-none focus:border-blue-700"
              />
            </div>

            {currentSection && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    aria-label="Section heading"
                    type="text"
                    value={currentSection.heading}
                    onChange={(e) => handleSectionChange(activeSecIdx, 'heading', e.target.value)}
                    className="font-display text-sm font-semibold text-slate-900 border border-slate-200 rounded-lg px-3 py-1.5 flex-1"
                  />
                  <button
                    type="button"
                    onClick={handleToneCleanup}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Concise Tone Check</span>
                  </button>
                </div>

                <textarea
                  aria-label="Section content editor"
                  rows={14}
                  value={currentSection.content}
                  onChange={(e) => handleSectionChange(activeSecIdx, 'content', e.target.value)}
                  className="w-full p-4 text-sm text-slate-800 leading-relaxed border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>
            )}
          </div>

          {/* Right Reference Manager */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-4 space-y-4 h-fit">
            <h2 className="font-display text-xs font-semibold text-slate-700">
              Bibliography ({activeDoc.references.length})
            </h2>
            <div className="space-y-2">
              <textarea
                rows={2}
                value={newRef}
                onChange={(e) => setNewRef(e.target.value)}
                placeholder="Add formatted IEEE/APA reference..."
                className="w-full p-2 text-xs border border-slate-300 rounded-lg"
              />
              <button
                type="button"
                onClick={handleAddReference}
                className="w-full py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800"
              >
                Append Reference
              </button>
            </div>
            <ul className="space-y-2 max-h-96 overflow-y-auto text-xs text-slate-600">
              {activeDoc.references.map((r, i) => (
                <li key={i} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="break-words">{r}</div>
                  {currentSection && (
                    <button
                      type="button"
                      onClick={() =>
                        handleSectionChange(activeSecIdx, 'content', `${currentSection.content} [${i + 1}]`)
                      }
                      className="text-blue-800 hover:underline mt-1 font-mono"
                    >
                      + Insert [{i + 1}]
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-sm text-slate-500">
          No manuscripts in workspace. Upload a paper or generate one first.
        </div>
      )}
    </WorkspaceLayout>
  );
}
