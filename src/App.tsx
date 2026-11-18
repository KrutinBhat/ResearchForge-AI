import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { PaperGeneratorPage } from './pages/PaperGeneratorPage';
import { SimilarityCheckerPage } from './pages/SimilarityCheckerPage';
import { WritingAnalyzerPage } from './pages/WritingAnalyzerPage';
import { CitationIntelligencePage } from './pages/CitationIntelligencePage';
import { QualityEvaluatorPage } from './pages/QualityEvaluatorPage';
import { ProjectAnalyzerPage } from './pages/ProjectAnalyzerPage';
import { WritingStudioPage } from './pages/WritingStudioPage';
import { IntegrityAuditPage } from './pages/IntegrityAuditPage';
import { PaperRefinementPage } from './pages/PaperRefinementPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';

function AutostartHandler() {
  const { user, loginDemo } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('autostart') === '1' && !user) {
      loginDemo().then(() => navigate('/dashboard', { replace: true }));
    }
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
    <AuthProvider>
      <BrowserRouter>
        <AutostartHandler />
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
      </BrowserRouter>
    </AuthProvider>
  );
}
