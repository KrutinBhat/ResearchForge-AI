import React, { useState } from 'react';
import { Save, Trash2, ExternalLink } from 'lucide-react';
import { WorkspaceLayout } from '../components/WorkspaceLayout';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [institution, setInstitution] = useState(user?.institution || '');
  const [role, setRole] = useState(user?.role || 'Researcher');
  const [consentAnalytics, setConsentAnalytics] = useState(user?.consentAnalytics ?? false);
  const [consentRetention, setConsentRetention] = useState(user?.consentRetention ?? true);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await apiFetch('/api/auth/settings', {
        method: 'PATCH',
        body: JSON.stringify({ name, institution, role, consentAnalytics, consentRetention }),
      });
      await refreshUser();
      setMessage('Account and privacy settings updated.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAllData = async () => {
    setError('');
    try {
      await apiFetch('/api/auth/data', { method: 'DELETE' });
      setConfirmClear(false);
      setMessage('All workspace manuscripts, projects, and reports have been permanently deleted.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <WorkspaceLayout
      title="User Settings & Privacy Controls"
      subtitle="Manage researcher profile metadata, document retention preferences, OpenAPI specification access, and complete data deletion."
    >
      {error && (
        <div role="alert" className="mb-6 p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-6 p-4 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-900">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form onSubmit={handleSave} className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <h2 className="font-display text-base font-semibold text-slate-900">Researcher Profile & Consent</h2>

          <div>
            <label htmlFor="set-name" className="block text-xs font-medium text-slate-700 mb-1">
              Full name
            </label>
            <input
              id="set-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="set-inst" className="block text-xs font-medium text-slate-700 mb-1">
                Institution / Organization
              </label>
              <input
                id="set-inst"
                type="text"
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="set-role" className="block text-xs font-medium text-slate-700 mb-1">
                Academic Role
              </label>
              <input
                id="set-role"
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 space-y-3">
            <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={consentRetention}
                onChange={(e) => setConsentRetention(e.target.checked)}
                className="mt-0.5 rounded border-slate-300"
              />
              <span>
                <strong>Local Workspace Persistence:</strong> Store uploaded manuscripts, version history, and audit
                reports in isolated workspace storage. Uploaded research is never used for model training.
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={consentAnalytics}
                onChange={(e) => setConsentAnalytics(e.target.checked)}
                className="mt-0.5 rounded border-slate-300"
              />
              <span>
                <strong>Aggregated Evaluation Telemetry:</strong> Opt in to anonymized module latency diagnostics.
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 disabled:opacity-50"
          >
            <Save className="w-4 h-4" aria-hidden="true" />
            <span>{saving ? 'Saving...' : 'Save Preferences'}</span>
          </button>
        </form>

        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <h2 className="font-display text-base font-semibold text-slate-900">API Documentation</h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Inspect the live OpenAPI 3.0 specification covering authentication, static analysis, similarity, citation
              registries, and asynchronous paper refinement endpoints.
            </p>
            <a
              href="/api/docs/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-800 hover:underline"
            >
              <span>View OpenAPI JSON Specification</span>
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>

          <div className="bg-white border border-red-200 rounded-xl p-6 space-y-3">
            <h2 className="font-display text-base font-semibold text-red-900">Data Deletion Control</h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Permanently purge all manuscripts, analyzed projects, similarity reports, citation checks, and integrity
              audits associated with your account ({user?.email}).
            </p>

            {!confirmClear ? (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-red-700 border border-red-300 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Delete All Workspace Data</span>
              </button>
            ) : (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg space-y-2">
                <div className="text-xs font-medium text-red-900">Confirm permanent deletion of all records?</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDeleteAllData}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-700 rounded-md hover:bg-red-800"
                  >
                    Yes, delete everything
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </WorkspaceLayout>
  );
}
