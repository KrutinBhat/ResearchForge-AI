import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  Copy,
  Download,
  FileCode2,
  Sparkles,
  Upload,
} from 'lucide-react';
import { StatusLabel } from './StatusLabel';
import { apiFetch } from '../lib/api';

interface BibtexDiscrepancy {
  field: string;
  declared: string;
  registry: string;
  severity: 'error' | 'warning';
}

interface VerifiedBibtexEntry {
  id: string;
  citeKey: string;
  entryType: string;
  rawReference: string;
  declared: {
    title: string;
    authors: string[];
    year: string | null;
    venue: string | null;
    doi: string | null;
    arxivId: string | null;
    url: string | null;
  };
  status: string;
  bibliographicStatus: string;
  matchedProvider: string;
  titleMatchScore: number;
  doiMatched: boolean | null;
  yearMatched: boolean | null;
  authorMatched: boolean | null;
  venueMatchScore: number | null;
  discrepancies: BibtexDiscrepancy[];
  verifiedMetadata: {
    title?: string;
    authors?: string[];
    year?: number | string;
    venue?: string;
    doi?: string;
    url?: string;
    credibilityNote?: string;
  } | null;
  matchedTitle: string | null;
  authors: string[];
  year: string | null;
  venue: string | null;
  doi: string | null;
  url: string;
  flags: string[];
}

interface BibtexExportBlock {
  bibtex: string;
  includeUnverified: boolean;
  includedCount: number;
  skippedCount: number;
  skippedEntries: Array<{ id: string; rawReference: string; reason: string }>;
  validation: {
    valid: boolean;
    entryCount: number;
    keys: string[];
    errors: string[];
  };
}

interface BibtexVerificationResponse {
  checkId?: string;
  syntax: {
    valid: boolean;
    entryCount: number;
    keys: string[];
    errors: string[];
  };
  summary: {
    totalEntries: number;
    verifiedCount: number;
    needsReviewCount: number;
    unverifiedCount: number;
    discrepancyCount: number;
  };
  entries: VerifiedBibtexEntry[];
  correctedBibtex: BibtexExportBlock;
}

const SAMPLE_BIBTEX = `@inproceedings{he2016deep,
  author = {Kaiming He and Xiangyu Zhang and Shaoqing Ren and Jian Sun},
  title = {Deep Residual Learning for Image Recognition},
  booktitle = {Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition},
  year = {2016},
  doi = {10.1109/CVPR.2016.90}
}

@article{mcmahan2018fedavg,
  author = {H. Brendan McMahan and Eider Moore and Daniel Ramage},
  title = {Communication-Efficient Learning of Deep Networks from Decentralized Data},
  journal = {arXiv preprint},
  year = {2018},
  eprint = {1602.05629}
}

@article{ghost2026hallucinated,
  author = {J. Fabricated and A. Nonexistent},
  title = {Quantum Holographic Zero-Shot Cryptography Without Data},
  journal = {Journal of Imaginary Systems},
  year = {2026},
  doi = {10.9999/fake.doi.2026}
}`;

function fieldBadge(ok: boolean | null, label: string) {
  if (ok === true) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-700">
        <Check className="w-3 h-3" aria-hidden="true" />
        <span>{label}: Match</span>
      </span>
    );
  }
  if (ok === false) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-mono text-red-700 font-medium">
        <AlertTriangle className="w-3 h-3" aria-hidden="true" />
        <span>{label}: Mismatch</span>
      </span>
    );
  }
  return <span className="text-xs font-mono text-slate-400">{label}: N/A</span>;
}

export function BibtexVerificationPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [bibtexText, setBibtexText] = useState('');
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BibtexVerificationResponse | null>(null);
  const [copiedBib, setCopiedBib] = useState(false);
  const [exportRefreshing, setExportRefreshing] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      setBibtexText(text);
    } catch {
      setError('Unable to read the selected .bib file.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleVerifyBibtex = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bibtexText.trim()) return;
    setError('');
    setRunning(true);
    try {
      const data = await apiFetch<BibtexVerificationResponse>('/api/citations/verify-bibtex', {
        method: 'POST',
        body: JSON.stringify({ bibtexText, includeUnverified }),
      });
      setResult(data);
    } catch (err: any) {
      setError(err?.message || 'BibTeX verification failed.');
    } finally {
      setRunning(false);
    }
  };

  const handleToggleIncludeUnverified = async (checked: boolean) => {
    setIncludeUnverified(checked);
    if (!result || result.entries.length === 0) return;
    setExportRefreshing(true);
    try {
      const updated = await apiFetch<BibtexExportBlock>('/api/citations/export-bibtex', {
        method: 'POST',
        body: JSON.stringify({ citations: result.entries, includeUnverified: checked }),
      });
      setResult((prev) => (prev ? { ...prev, correctedBibtex: updated } : prev));
    } catch (err: any) {
      setError(err?.message || 'Unable to regenerate corrected BibTeX.');
    } finally {
      setExportRefreshing(false);
    }
  };

  const handleCopyCorrected = () => {
    const text = result?.correctedBibtex?.bibtex;
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopiedBib(true);
    setTimeout(() => setCopiedBib(false), 1800);
  };

  const handleDownloadCorrected = () => {
    const text = result?.correctedBibtex?.bibtex;
    if (!text) return;
    const blob = new Blob([text], { type: 'application/x-bibtex;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'verified-references.bib';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6" data-testid="bibtex-verification-panel">
      {error && (
        <div role="alert" className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleVerifyBibtex} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-blue-800" aria-hidden="true" />
              <h2 className="font-display text-sm font-semibold text-slate-900">
                BibTeX Registry Cross-Reference Verifier
              </h2>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              Parse raw <code className="font-mono">@article</code> / <code className="font-mono">@inproceedings</code>{' '}
              entries or upload a <code className="font-mono">.bib</code> file to validate DOIs, titles, authors, and
              years directly against Crossref, OpenAlex, Semantic Scholar, and arXiv.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".bib,.txt"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="Upload BibTeX .bib file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Upload .bib</span>
            </button>
            <button
              type="button"
              onClick={() => setBibtexText(SAMPLE_BIBTEX)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Load Sample BibTeX</span>
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="bibtex-input" className="block text-xs font-medium text-slate-700 mb-1">
            BibTeX entries (@article, @inproceedings, @book, @misc)
          </label>
          <textarea
            id="bibtex-input"
            rows={8}
            value={bibtexText}
            onChange={(e) => setBibtexText(e.target.value)}
            placeholder={`@article{vaswani2017attention,\n  author = {Ashish Vaswani and Noam Shazeer},\n  title = {Attention Is All You Need},\n  journal = {Advances in Neural Information Processing Systems},\n  year = {2017}\n}`}
            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-800/20 focus:border-blue-800"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
          <button
            type="submit"
            disabled={running || !bibtexText.trim()}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
          >
            <BookOpenCheck className="w-4 h-4" aria-hidden="true" />
            <span>{running ? 'Cross-Referencing Crossref & Open Registries...' : 'Verify BibTeX Entries'}</span>
          </button>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={includeUnverified}
              onChange={(e) => handleToggleIncludeUnverified(e.target.checked)}
              className="rounded border-slate-300 text-blue-800"
            />
            <span>Include unverified entries in corrected .bib export (annotated)</span>
          </label>
        </div>
      </form>

      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">BibTeX Entries Parsed</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.summary.totalEntries}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Verified</div>
              <div className="font-mono text-2xl font-semibold text-emerald-700 mt-1 tabular-nums">
                {result.summary.verifiedCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Needs Review</div>
              <div className="font-mono text-2xl font-semibold text-amber-700 mt-1 tabular-nums">
                {result.summary.needsReviewCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Unverified ({result.summary.discrepancyCount} field alerts)</div>
              <div className="font-mono text-2xl font-semibold text-red-700 mt-1 tabular-nums">
                {result.summary.unverifiedCount}
              </div>
            </div>
          </div>

          {!result.syntax.valid && result.syntax.errors.length > 0 && (
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
              <div className="font-semibold">BibTeX Structural Syntax Notices</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {result.syntax.errors.map((errMsg, idx) => (
                  <li key={idx}>{errMsg}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {result.entries.map((entry) => (
              <div key={entry.id} className="p-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="text-xs font-mono font-semibold text-slate-900 bg-slate-100 px-2 py-0.5 rounded">
                      @{entry.entryType}
                      {'{'}
                      {entry.citeKey}
                      {'}'}
                    </code>
                    <StatusLabel status={entry.status} />
                  </div>
                  <div className="text-xs font-mono text-slate-500 tabular-nums">
                    Provider: {entry.matchedProvider} · Title match: {Math.round(entry.titleMatchScore * 100)}%
                  </div>
                </div>

                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {entry.declared.title || <span className="italic text-slate-400">Untitled BibTeX entry</span>}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {entry.declared.authors.length > 0 ? entry.declared.authors.join(', ') : 'No author declared'}
                    {entry.declared.venue ? ` · ${entry.declared.venue}` : ''}
                    {entry.declared.year ? ` · ${entry.declared.year}` : ''}
                    {entry.declared.doi ? ` · DOI: ${entry.declared.doi}` : ''}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  {fieldBadge(entry.yearMatched, 'Year')}
                  {fieldBadge(entry.authorMatched, 'Authors')}
                  {fieldBadge(entry.doiMatched, 'DOI')}
                </div>

                {entry.verifiedMetadata && (
                  <div className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                    <div>
                      <span className="font-semibold text-slate-900">Registry Record:</span>{' '}
                      {entry.verifiedMetadata.credibilityNote}
                      {entry.verifiedMetadata.doi && (
                        <>
                          {' '}
                          · DOI:{' '}
                          <a
                            href={`https://doi.org/${entry.verifiedMetadata.doi}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-800 hover:underline font-mono"
                          >
                            {entry.verifiedMetadata.doi}
                          </a>
                        </>
                      )}
                    </div>
                    {entry.matchedTitle && (
                      <div className="text-slate-600">
                        Canonical Title: <span className="text-slate-800">{entry.matchedTitle}</span>
                        {entry.year ? ` (${entry.year})` : ''}
                      </div>
                    )}
                  </div>
                )}

                {entry.discrepancies.length > 0 && (
                  <div className="overflow-x-auto border border-amber-200 rounded-lg">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-amber-50 text-amber-900 border-b border-amber-200">
                        <tr>
                          <th className="px-3 py-1.5 font-semibold">Field</th>
                          <th className="px-3 py-1.5 font-semibold">Declared in BibTeX</th>
                          <th className="px-3 py-1.5 font-semibold">Registry Metadata ({entry.matchedProvider})</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-100 bg-white">
                        {entry.discrepancies.map((d, i) => (
                          <tr key={i}>
                            <td className="px-3 py-1.5 font-mono uppercase text-amber-800">{d.field}</td>
                            <td className="px-3 py-1.5 text-slate-700">{d.declared}</td>
                            <td className="px-3 py-1.5 text-slate-900 font-medium">{d.registry}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {entry.flags.length > 0 && entry.discrepancies.length === 0 && (
                  <ul className="text-xs text-red-700 list-disc pl-4 space-y-0.5">
                    {entry.flags.map((fl, i) => (
                      <li key={i}>{fl}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          <section
            aria-label="Verified BibTeX Output"
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Validated & Reconciled BibTeX Output
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 font-mono">
                  Included: {result.correctedBibtex.includedCount} · Skipped: {result.correctedBibtex.skippedCount}
                  {exportRefreshing ? ' · Refreshing...' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCorrected}
                  disabled={result.correctedBibtex.includedCount === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50"
                >
                  {copiedBib ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedBib ? 'Copied .bib' : 'Copy Corrected .bib'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCorrected}
                  disabled={result.correctedBibtex.includedCount === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Download Verified .bib</span>
                </button>
              </div>
            </div>

            <pre className="p-4 bg-slate-950 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto max-h-72 leading-relaxed">
              {result.correctedBibtex.bibtex}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
