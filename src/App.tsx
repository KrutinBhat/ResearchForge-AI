import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';

const LandingPage = lazy(async () => ({ default: (await import('./pages/LandingPage')).LandingPage }));
const AuthPage = lazy(async () => ({ default: (await import('./pages/AuthPage')).AuthPage }));
const DashboardPage = lazy(async () => ({ default: (await import('./pages/DashboardPage')).DashboardPage }));
const PaperGeneratorPage = lazy(async () => ({ default: (await import('./pages/PaperGeneratorPage')).PaperGeneratorPage }));
const SimilarityCheckerPage = lazy(async () => ({ default: (await import('./pages/SimilarityCheckerPage')).SimilarityCheckerPage }));
const WritingAnalyzerPage = lazy(async () => ({ default: (await import('./pages/WritingAnalyzerPage')).WritingAnalyzerPage }));
const CitationIntelligencePage = lazy(async () => ({ default: (await import('./pages/CitationIntelligencePage')).CitationIntelligencePage }));
const QualityEvaluatorPage = lazy(async () => ({ default: (await import('./pages/QualityEvaluatorPage')).QualityEvaluatorPage }));
const ProjectAnalyzerPage = lazy(async () => ({ default: (await import('./pages/ProjectAnalyzerPage')).ProjectAnalyzerPage }));
const WritingStudioPage = lazy(async () => ({ default: (await import('./pages/WritingStudioPage')).WritingStudioPage }));
const IntegrityAuditPage = lazy(async () => ({ default: (await import('./pages/IntegrityAuditPage')).IntegrityAuditPage }));
const PaperRefinementPage = lazy(async () => ({ default: (await import('./pages/PaperRefinementPage')).PaperRefinementPage }));
const ReportsPage = lazy(async () => ({ default: (await import('./pages/ReportsPage')).ReportsPage }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/SettingsPage')).SettingsPage }));

function AutostartHandler() {
  const { user, loginDemo } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('autostart') !== '1' || user) return;

    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((health) => {
        if (health?.demoEnabled) {
          return loginDemo().then(() => navigate('/dashboard', { replace: true }));
        }
        return undefined;
      })
      .catch(() => {});
  }, [location.search, user, loginDemo, navigate]);

  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        Loading workspace...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AutostartHandler />
          <Suspense fallback={<div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">Loading page...</div>}>
          <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/generator"
            element={
              <ProtectedRoute>
                <PaperGeneratorPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/similarity"
            element={
              <ProtectedRoute>
                <SimilarityCheckerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/writing-analysis"
            element={
              <ProtectedRoute>
                <WritingAnalyzerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/citations"
            element={
              <ProtectedRoute>
                <CitationIntelligencePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/quality"
            element={
              <ProtectedRoute>
                <QualityEvaluatorPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/project-analyzer"
            element={
              <ProtectedRoute>
                <ProjectAnalyzerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/studio"
            element={
              <ProtectedRoute>
                <WritingStudioPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/audit"
            element={
              <ProtectedRoute>
                <IntegrityAuditPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/refinement"
            element={
              <ProtectedRoute>
                <PaperRefinementPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <ReportsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
          </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </ErrorBoundary>
  );
}
