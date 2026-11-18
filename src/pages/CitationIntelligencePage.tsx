import React, { useEffect, useState } from 'react';
import { BookCheck, Copy, Check } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { StatusLabel } from '../components/StatusLabel';
import { apiFetch } from '../lib/api';

interface DocumentOption {
  id: string;
  title: string;
}

interface CitationResult {
  title: string;
  audit: {
    citations: Array<{
      id: string;
      rawReference: string;
      status: string;
      bibliographicStatus?: string;
      claimSupportStatus?: string;
      matchedProvider: string;
      titleMatchScore: number;
      yearMatched: boolean | null;
      authorMatched: boolean | null;
      verifiedMetadata: {
        title?: string;
        authors?: string[];
        year?: number;
        venue?: string;
        doi?: string;
        url?: string;
        credibilityNote?: string;
      } | null;
      formattedIEEE: string;
      formattedAPA: string;
      flags: string[];
      citedInText: boolean;
    }>;
    summary: {
      totalReferences: number;
      verifiedCount: number;
      needsReviewCount: number;
      unverifiedCount: number;
      duplicateReferences?: string[];
      orphanedInTextCitations: string[];
      uncitedReferences: string[];
    };
  };
  claimCheck?: {
    overlapScore: number;
    sharedConcepts: string[];
    claimSupportStatus?: string;
    assessment: string;
  } | null;
}

export function CitationIntelligencePage() {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [documentId, setDocumentId] = useState('');
  const [referencesText, setReferencesText] = useState('');
  const [claimText, setClaimText] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [formatStyle, setFormatStyle] = useState<'IEEE' | 'APA'>('IEEE');
  const [copiedId, setCopiedId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CitationResult | null>(null);

  useEffect(() => {
    apiFetch<{ documents: DocumentOption[] }>('/api/documents')
      .then((res) => {
        setDocuments(res.documents);
        if (res.documents.length > 0) setDocumentId(res.documents[0].id);
      })
      .catch(() => {});
  }, []);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setRunning(true);
    try {
      const res = await apiFetch<CitationResult>('/api/citations/verify', {
        method: 'POST',
        body: JSON.stringify({
          documentId: referencesText.trim() ? undefined : documentId,
          referencesText: referencesText.trim() || undefined,
          claimText: claimText.trim() || undefined,
          sourceTitle: sourceTitle.trim() || undefined,
        }),
      });
      setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 1500);
  };

  return (
    <WorkspaceLayout
      title="Citation Intelligence Engine"
      subtitle="Verify DOIs, titles, authors, and publication years live against Crossref, OpenAlex, Semantic Scholar, and arXiv. Flag unverified or fabricated citations without inventing metadata."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={handleVerify} className="bg-white border border-slate-200 rounded-xl p-6 mb-8 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="cit-doc" className="block text-xs font-medium text-slate-700 mb-1">
              Verify bibliography from workspace document
            </label>
            <select
              id="cit-doc"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
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
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setFormatStyle('IEEE')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  formatStyle === 'IEEE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                IEEE Format
              </button>
              <button
                type="button"
                onClick={() => setFormatStyle('APA')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  formatStyle === 'APA' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                APA Format
              </button>
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="cit-raw" className="block text-xs font-medium text-slate-700 mb-1">
            Or paste references directly (one reference per line)
          </label>
          <textarea
            id="cit-raw"
            rows={3}
            value={referencesText}
            onChange={(e) => setReferencesText(e.target.value)}
            placeholder='[1] A. Vaswani et al., "Attention Is All You Need," NeurIPS 2017. DOI: 10.48550/arXiv.1706.03762'
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
          <div>
            <label htmlFor="cit-claim" className="block text-xs font-medium text-slate-700 mb-1">
              Optional claim-to-source check: Manuscript claim
            </label>
            <input
              id="cit-claim"
              type="text"
              value={claimText}
              onChange={(e) => setClaimText(e.target.value)}
              placeholder="e.g., FedAvg aggregates decentralized client weights..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="cit-src" className="block text-xs font-medium text-slate-700 mb-1">
              Target source title / abstract excerpt
            </label>
            <input
              id="cit-src"
              type="text"
              value={sourceTitle}
              onChange={(e) => setSourceTitle(e.target.value)}
              placeholder="e.g., Communication-Efficient Learning of Deep Networks from Decentralized Data"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={running || (!documentId && !referencesText.trim())}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
        >
          <BookCheck className="w-4 h-4" aria-hidden="true" />
          <span>{running ? 'Querying Crossref, OpenAlex, Semantic Scholar & arXiv...' : 'Verify Citations Live'}</span>
        </button>
      </form>

      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">References Audited</div>
              <div className="font-mono text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                {result.audit.summary.totalReferences}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Verified</div>
              <div className="font-mono text-2xl font-semibold text-emerald-700 mt-1 tabular-nums">
                {result.audit.summary.verifiedCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Needs Review</div>
              <div className="font-mono text-2xl font-semibold text-amber-700 mt-1 tabular-nums">
                {result.audit.summary.needsReviewCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Unverified</div>
              <div className="font-mono text-2xl font-semibold text-red-700 mt-1 tabular-nums">
                {result.audit.summary.unverifiedCount}
              </div>
            </div>
          </div>

          {result.claimCheck && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">Claim-to-Source Relevance Result</span>
                {result.claimCheck.claimSupportStatus && <StatusLabel status={result.claimCheck.claimSupportStatus} />}
              </div>
              <div className="text-slate-700">
                Overlap Score: <span className="font-mono font-semibold">{Math.round(result.claimCheck.overlapScore * 100)}%</span> ·{' '}
                Shared Concepts: {result.claimCheck.sharedConcepts.join(', ') || 'None'} — {result.claimCheck.assessment}
              </div>
            </div>
          )}

          {(result.audit.summary.orphanedInTextCitations.length > 0 ||
            result.audit.summary.uncitedReferences.length > 0 ||
            (result.audit.summary.duplicateReferences?.length ?? 0) > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 space-y-1">
              <div>
                <strong>Orphaned in-text citations (missing in bibliography):</strong>{' '}
                {result.audit.summary.orphanedInTextCitations.join(', ') || 'None'}
              </div>
              <div>
                <strong>Uncited bibliography entries:</strong>{' '}
                {result.audit.summary.uncitedReferences.join(', ') || 'None'}
              </div>
              {(result.audit.summary.duplicateReferences?.length ?? 0) > 0 && (
                <div>
                  <strong>Duplicate bibliography entries:</strong> {result.audit.summary.duplicateReferences?.join(', ')}
                </div>
              )}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {result.audit.citations.map((c) => {
              const formatted = formatStyle === 'IEEE' ? c.formattedIEEE : c.formattedAPA;
              return (
                <div key={c.id} className="p-6 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusLabel status={c.bibliographicStatus || c.status} />
                      {c.claimSupportStatus && c.claimSupportStatus !== 'Verification unavailable' && (
                        <StatusLabel status={c.claimSupportStatus} />
                      )}
                    </div>
                    <div className="text-xs font-mono text-slate-500 tabular-nums">
                      Provider: {c.matchedProvider} · Title match: {Math.round(c.titleMatchScore * 100)}%
                    </div>
                  </div>
                  <p className="text-sm text-slate-900 font-medium">{c.rawReference}</p>
                  {c.verifiedMetadata && (
                    <div className="text-xs text-slate-600">
                      <span className="font-medium text-slate-800">Registry Record:</span> {c.verifiedMetadata.credibilityNote}
                      {c.verifiedMetadata.doi && (
                        <span>
                          {' '}
                          · DOI:{' '}
                          <a
                            href={`https://doi.org/${c.verifiedMetadata.doi}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-800 hover:underline font-mono"
                          >
                            {c.verifiedMetadata.doi}
                          </a>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3">
                    <code className="text-xs text-slate-800 break-all">
                      [{formatStyle}] {formatted}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy(c.id, formatted)}
                      aria-label={`Copy formatted ${formatStyle} citation`}
                      className="p-1.5 text-slate-500 hover:text-slate-900 shrink-0"
                    >
                      {copiedId === c.id ? <Check className="w-4 h-4 text-emerald-700" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  {c.flags.length > 0 && (
                    <ul className="text-xs text-amber-800 list-disc pl-4 space-y-0.5">
                      {c.flags.map((fl, idx) => (
                        <li key={idx}>{fl}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
