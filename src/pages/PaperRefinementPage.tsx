import React, { useEffect, useState } from 'react';
import { Upload, Sparkles, CheckCircle2, Download, AlertTriangle, FileUp } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiDownload, apiFetch } from '../lib/api';

interface Section {
  id: string;
  heading: string;
  content: string;
}

interface DocumentOption {
  id: string;
  title: string;
  format: string;
  word_count: number;
}

interface RefinementJobResponse {
  id: string;
  documentId: string;
  mode: string;
  scope: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  errorMessage?: string;
  retries?: number;
  originalSections: Section[];
  refinedSections: Section[];
  metrics: {
    error?: string;
    engineUsed?: string;
    preMetrics?: { burstinessFanoFactor: number; transitionDensityPer100Words: number; lexicalDiversityTTR: number };
    postMetrics?: { burstinessFanoFactor: number; transitionDensityPer100Words: number; lexicalDiversityTTR: number };
    validations?: Array<{
      sectionId: string;
      heading: string;
      citationsPreserved: boolean;
      equationsPreserved: boolean;
      numbersPreserved?: boolean;
      missingNumbers?: string[];
      addedNumbers?: string[];
      termsPreserved?: boolean;
      missingTerms?: string[];
      meaningRetentionScore: number;
      semanticDriftWarning?: boolean;
      wordDelta: number;
      changesSummary: string[];
    }>;
  };
}

const REFINEMENT_MODES = [
  'Academic Clarity',
  'Technical Precision',
  'Concise Academic Writing',
  'Formal Research Style',
  'Readability Improvement',
] as const;

const PIPELINE_STEPS = [
  'Upload & Format Detection',
  'Text & Math Extraction',
  'Section Segmentation',
  'Stylometric Analysis',
  'Academic Refinement',
  'Citation & Meaning Validation',
];

function computeWordDiff(orig: string, rev: string): Array<{ text: string; type: 'same' | 'added' }> {
  const origSet = new Set(
    orig
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
  );
  return rev.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return { text: token, type: 'same' };
    const clean = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean && !origSet.has(clean)) {
      return { text: token, type: 'added' };
    }
    return { text: token, type: 'same' };
  });
}

export function PaperRefinementPage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [selectedDocId, setSelectedDocId] = useState('');
  const [docSections, setDocSections] = useState<Section[]>([]);
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([]);
  const [scope, setScope] = useState<'whole_paper' | 'selected_sections' | 'selected_paragraphs'>('whole_paper');
  const [paragraphText, setParagraphText] = useState('');
  const [mode, setMode] = useState<(typeof REFINEMENT_MODES)[number]>('Academic Clarity');
  const [engineMode, setEngineMode] = useState<'gemini' | 'local'>('gemini');
  const [preserveTerms, setPreserveTerms] = useState('');

  // Drag & drop upload state
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState('');

  // Job polling state
  const [job, setJob] = useState<RefinementJobResponse | null>(null);
  const [activeDiffIdx, setActiveDiffIdx] = useState(0);
  const [approving, setApproving] = useState(false);
  const [approvedBanner, setApprovedBanner] = useState('');
  const [error, setError] = useState('');

  const loadDocuments = async (selectId?: string) => {
    const res = await apiFetch<{ documents: DocumentOption[] }>('/api/documents');
    setDocuments(res.documents);
    const targetId = selectId || selectedDocId || res.documents[0]?.id;
    if (targetId) {
      setSelectedDocId(targetId);
      const detail = await apiFetch<{ document: { sections: Section[] } }>(`/api/documents/${targetId}`);
      setDocSections(detail.document.sections);
      setSelectedSectionIds(detail.document.sections.map((s) => s.id));
    }
  };

  useEffect(() => {
    loadDocuments().catch((e) => setError(e.message));
  }, []);

  const handleDocumentSelect = async (id: string) => {
    setSelectedDocId(id);
    setJob(null);
    setApprovedBanner('');
    if (!id) return;
    const detail = await apiFetch<{ document: { sections: Section[] } }>(`/api/documents/${id}`);
    setDocSections(detail.document.sections);
    setSelectedSectionIds(detail.document.sections.map((s) => s.id));
  };

  const processFileUpload = async (file: File) => {
    setError('');
    setUploadNotice('');
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch<{
        document: { id: string; title: string; format: string; word_count: number };
        parseMeta: { ocrRequired: boolean; warnings: string[]; citationsFound: string[]; equationsFound: string[] };
      }>('/api/documents/upload', { method: 'POST', body: fd });

      setUploadNotice(
        `Parsed ${res.document.format.toUpperCase()} (${res.document.word_count} words · ${res.parseMeta.citationsFound.length} citations · ${res.parseMeta.equationsFound.length} equations detected).${
          res.parseMeta.ocrRequired ? ' Note: PDF appears scanned and needs OCR text input.' : ''
        }`
      );
      await loadDocuments(res.document.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFileUpload(file);
  };

  const pollJob = async (jobId: string) => {
    const status = await apiFetch<RefinementJobResponse>(`/api/paper-refinement/jobs/${jobId}`);
    setJob(status);
    if (status.status === 'processing' || status.status === 'queued') {
      setTimeout(() => pollJob(jobId), 700);
    } else if (status.status === 'failed') {
      setError(status.errorMessage || status.metrics?.error || 'Refinement pipeline failed.');
    } else if (status.status === 'cancelled') {
      setError('Refinement job was cancelled.');
    } else {
      setActiveDiffIdx(0);
    }
  };

  const handleStartRefinement = async () => {
    if (!selectedDocId) return;
    setError('');
    setApprovedBanner('');
    try {
      const { jobId } = await apiFetch<{ jobId: string }>('/api/paper-refinement/start', {
        method: 'POST',
        body: JSON.stringify({
          documentId: selectedDocId,
          mode,
          scope,
          sectionIds: scope !== 'whole_paper' ? selectedSectionIds : undefined,
          paragraphText: scope === 'selected_paragraphs' ? paragraphText : undefined,
          preserveTerms,
          engineMode,
        }),
      });
      await pollJob(jobId);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCancelJob = async () => {
    if (!job) return;
    await apiFetch(`/api/paper-refinement/jobs/${job.id}/cancel`, { method: 'POST' });
    setJob((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
  };

  const handleRetryJob = async () => {
    if (!job) return;
    setError('');
    await apiFetch(`/api/paper-refinement/jobs/${job.id}/retry`, { method: 'POST' });
    await pollJob(job.id);
  };

  const handleApproveRevision = async () => {
    if (!job) return;
    setApproving(true);
    try {
      const res = await apiFetch<{ versionNumber: number }>(`/api/paper-refinement/approve/${job.id}`, {
        method: 'POST',
        body: JSON.stringify({ approvedSections: job.refinedSections }),
      });
      setApprovedBanner(`Approved & saved as Revision v${res.versionNumber}.`);
      await handleDocumentSelect(job.documentId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  };

  const handleExport = async (fmt: 'docx' | 'pdf') => {
    if (!selectedDocId) return;
    await apiDownload(`/api/documents/${selectedDocId}/export?format=${fmt}`, `refined-paper.${fmt}`);
  };

  const toggleSectionId = (id: string) => {
    setSelectedSectionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const activeOrig = job?.originalSections[activeDiffIdx];
  const activeRef = job?.refinedSections[activeDiffIdx];
  const activeVal = job?.metrics?.validations?.find((v) => v.sectionId === activeOrig?.id);

  return (
    <WorkspaceLayout
      title="Paper Humanization & Academic Refinement"
      subtitle="Upload existing manuscripts (PDF, DOCX, DOC, TXT, RTF, Markdown, LaTeX) and refine clarity, structure, and flow while preserving original meaning, equations, and citations."
      primaryAction={
        selectedDocId && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleExport('docx')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export DOCX</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('pdf')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export PDF</span>
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
      {uploadNotice && (
        <div className="mb-6 p-4 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-950">{uploadNotice}</div>
      )}
      {approvedBanner && (
        <div className="mb-6 p-4 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{approvedBanner}</span>
        </div>
      )}

      {/* Drag & Drop Upload + Refinement Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        <div className="lg:col-span-5 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`bg-white border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
              dragActive ? 'border-blue-700 bg-blue-50/60' : 'border-slate-300'
            }`}
          >
            <FileUp className="w-7 h-7 text-blue-800 mx-auto mb-2" aria-hidden="true" />
            <div className="font-display text-sm font-semibold text-slate-900">
              {uploading ? 'Extracting manuscript...' : 'Drop existing research paper here'}
            </div>
            <p className="text-xs text-slate-500 mt-1 mb-4">
              Supported: PDF · DOCX · DOC · TXT · RTF · Markdown · LaTeX (.tex)
            </p>
            <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 cursor-pointer">
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Browse manuscript file</span>
              <input
                type="file"
                accept=".pdf,.docx,.doc,.txt,.md,.rtf,.tex"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) processFileUpload(f);
                }}
              />
            </label>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <label htmlFor="ref-doc" className="block text-xs font-semibold text-slate-700">
              Active manuscript in workspace
            </label>
            <select
              id="ref-doc"
              value={selectedDocId}
              onChange={(e) => handleDocumentSelect(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} ({d.format.toUpperCase()} · {d.word_count}w)
                </option>
              ))}
            </select>

            {docSections.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-medium text-slate-600 mb-1.5">
                  Detected sections ({docSections.length})
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {docSections.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={scope === 'whole_paper'}
                        checked={scope === 'whole_paper' || selectedSectionIds.includes(s.id)}
                        onChange={() => toggleSectionId(s.id)}
                        className="rounded border-slate-300"
                      />
                      <span className="truncate">{s.heading}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-base font-semibold text-slate-900">Refinement Pipeline Settings</h2>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setEngineMode('gemini')}
                className={`px-3 py-1 text-xs font-medium rounded-md ${
                  engineMode === 'gemini' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Gemini AI
              </button>
              <button
                type="button"
                onClick={() => setEngineMode('local')}
                className={`px-3 py-1 text-xs font-medium rounded-md ${
                  engineMode === 'local' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Local Structural
              </button>
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-slate-700 mb-2">Refinement Mode</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {REFINEMENT_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border text-left transition-colors ${
                    mode === m
                      ? 'border-blue-700 bg-blue-50 text-blue-900'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium text-slate-700 mb-1.5">Processing Scope</div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setScope('whole_paper')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
                    scope === 'whole_paper' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  Whole Paper
                </button>
                <button
                  type="button"
                  onClick={() => setScope('selected_sections')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
                    scope === 'selected_sections' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  Sections
                </button>
                <button
                  type="button"
                  onClick={() => setScope('selected_paragraphs')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
                    scope === 'selected_paragraphs' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  Paragraph
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="preserve-terms" className="block text-xs font-medium text-slate-700 mb-1.5">
                Protected technical terms (comma-separated)
              </label>
              <input
                id="preserve-terms"
                type="text"
                value={preserveTerms}
                onChange={(e) => setPreserveTerms(e.target.value)}
                placeholder="e.g., Residual1DCNN, FedAvg, MIT-BIH"
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {scope === 'selected_paragraphs' && (
            <div>
              <label htmlFor="para-excerpt" className="block text-xs font-medium text-slate-700 mb-1">
                Target paragraph excerpt from selected section
              </label>
              <textarea
                id="para-excerpt"
                rows={3}
                value={paragraphText}
                onChange={(e) => setParagraphText(e.target.value)}
                placeholder="Paste the exact paragraph from the document to refine independently..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          )}

          {/* Pipeline Progress Indicator */}
          <div className="pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
              <span>Processing Pipeline</span>
              <span className="font-mono tabular-nums">{job ? `${job.progress}% (${job.status})` : 'Ready'}</span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-blue-800 transition-all duration-300"
                style={{ width: `${job ? job.progress : 0}%` }}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] text-slate-500">
              {PIPELINE_STEPS.map((step, i) => {
                const threshold = Math.round(((i + 1) / PIPELINE_STEPS.length) * 100);
                const done = job && job.progress >= threshold;
                return (
                  <div key={step} className={done ? 'text-blue-900 font-medium' : ''}>
                    {i + 1}. {step}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleStartRefinement}
              disabled={!selectedDocId || job?.status === 'processing' || job?.status === 'queued'}
              className="flex-1 py-2.5 px-4 text-sm font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              <span>
                {job?.status === 'processing' || job?.status === 'queued'
                  ? 'Refining manuscript...'
                  : `Run Academic Refinement (${mode})`}
              </span>
            </button>
            {(job?.status === 'processing' || job?.status === 'queued') && (
              <button
                type="button"
                onClick={handleCancelJob}
                className="py-2.5 px-4 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
              >
                Cancel Job
              </button>
            )}
            {(job?.status === 'failed' || job?.status === 'cancelled') && (
              <button
                type="button"
                onClick={handleRetryJob}
                className="py-2.5 px-4 text-xs font-medium text-blue-900 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100"
              >
                Retry Job
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Original vs. Revised Side-by-Side Comparison Workspace */}
      {job && job.status === 'completed' && activeOrig && activeRef && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                Original vs. Refined Side-by-Side Review
              </h2>
              <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                Engine: {job.metrics.engineUsed} · Pre-Burstiness: {job.metrics.preMetrics?.burstinessFanoFactor} → Post:{' '}
                {job.metrics.postMetrics?.burstinessFanoFactor} · Pre-Transitions:{' '}
                {job.metrics.preMetrics?.transitionDensityPer100Words}/100w → Post:{' '}
                {job.metrics.postMetrics?.transitionDensityPer100Words}/100w
              </div>
            </div>
            <button
              type="button"
              onClick={handleApproveRevision}
              disabled={approving}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50"
            >
              {approving ? 'Saving...' : 'Approve & Save to Document'}
            </button>
          </div>

          {/* Section Tabs */}
          <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center gap-2">
            {job.originalSections.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveDiffIdx(idx)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeDiffIdx === idx
                    ? 'bg-white text-slate-900 border border-slate-300 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {s.heading}
              </button>
            ))}
          </div>

          {/* Preservation Validation Banner */}
          {activeVal && (
            <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/50 flex flex-wrap items-center gap-6 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Citations:</span>
                <StatusLabel status={activeVal.citationsPreserved ? 'Verified' : 'Needs review'} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Equations:</span>
                <StatusLabel status={activeVal.equationsPreserved ? 'Verified' : 'Needs review'} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Numbers:</span>
                <StatusLabel status={activeVal.numbersPreserved !== false ? 'Verified' : 'Needs review'} />
              </div>
              <div className="font-mono text-slate-700 tabular-nums">
                Meaning retention: {Math.round(activeVal.meaningRetentionScore * 100)}% · Word delta:{' '}
                {activeVal.wordDelta >= 0 ? `+${activeVal.wordDelta}` : activeVal.wordDelta}
              </div>
            </div>
          )}

          {/* Side-by-Side Panes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            <div className="p-6">
              <div className="text-xs font-semibold text-slate-500 mb-2">Original ({activeOrig.heading})</div>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{activeOrig.content}</p>
            </div>
            <div className="p-6 bg-blue-50/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-blue-900">Refined ({activeRef.heading})</span>
                <span className="text-[11px] text-slate-500">Modified vocabulary highlighted</span>
              </div>
              <p className="text-sm text-slate-900 leading-relaxed whitespace-pre-wrap">
                {computeWordDiff(activeOrig.content, activeRef.content).map((part, idx) =>
                  part.type === 'added' ? (
                    <mark key={idx} className="bg-blue-100 text-blue-950 px-0.5 rounded">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={idx}>{part.text}</span>
                  )
                )}
              </p>
            </div>
          </div>

          {(!activeVal?.citationsPreserved ||
            activeVal?.numbersPreserved === false ||
            activeVal?.termsPreserved === false ||
            activeVal?.semanticDriftWarning) && (
            <div className="px-6 py-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                Preservation guard triggered:{' '}
                {!activeVal?.citationsPreserved && 'citation marker shifted; '}
                {activeVal?.numbersPreserved === false &&
                  `numeric delta (added: ${activeVal.addedNumbers?.join(', ') || 'none'}, missing: ${activeVal.missingNumbers?.join(', ') || 'none'}); `}
                {activeVal?.termsPreserved === false &&
                  `omitted protected terms (${activeVal.missingTerms?.join(', ')}); `}
                {activeVal?.semanticDriftWarning && 'elevated lexical drift detected.'}
              </span>
            </div>
          )}
        </section>
      )}
    </WorkspaceLayout>
  );
}
