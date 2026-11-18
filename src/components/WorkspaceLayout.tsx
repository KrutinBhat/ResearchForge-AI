import React, { useState } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderGit2,
  FileText,
  Sparkles,
  ScanSearch,
  BarChart3,
  BookCheck,
  ClipboardCheck,
  PenTool,
  ShieldCheck,
  History,
  Settings,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface WorkspaceLayoutProps {
  title: string;
  subtitle?: string;
  primaryAction?: React.ReactNode;
  children: React.ReactNode;
}

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Creation Workflow',
    items: [
      { to: '/project-analyzer', label: 'Project Analyzer', icon: FolderGit2 },
      { to: '/generator', label: 'Paper Generator', icon: FileText },
      { to: '/studio', label: 'Writing Studio', icon: PenTool },
    ],
  },
  {
    label: 'Refinement & Integrity',
    items: [
      { to: '/refinement', label: 'Paper Refinement', icon: Sparkles },
      { to: '/similarity', label: 'Similarity Checker', icon: ScanSearch },
      { to: '/writing-analysis', label: 'AI-Writing Analyzer', icon: BarChart3 },
      { to: '/citations', label: 'Citation Intelligence', icon: BookCheck },
      { to: '/quality', label: 'Quality Evaluator', icon: ClipboardCheck },
      { to: '/audit', label: 'Integrity Audit', icon: ShieldCheck },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/reports', label: 'Reports & History', icon: History },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function WorkspaceLayout({ title, subtitle, primaryAction, children }: WorkspaceLayoutProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const navContent = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-5 border-b border-slate-200 flex items-center justify-between">
        <Link to="/" className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          ResearchForge AI
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation menu"
          className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav aria-label="Workspace navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-3 mb-2 text-xs font-medium text-slate-500">{group.label}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={() => setMobileOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                          isActive
                            ? 'bg-blue-50 text-blue-900'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                        }`
                      }
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-4 border-t border-slate-200 bg-slate-50/70">
        <div className="text-sm font-medium text-slate-900 truncate">{user?.name}</div>
        <div className="text-xs text-slate-500 truncate mt-0.5">{user?.institution || user?.email}</div>
        <button
          type="button"
          onClick={handleLogout}
          className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 bg-white border-r border-slate-200 sticky top-0 h-screen">
        {navContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <aside className="relative w-72 max-w-[85vw] bg-white h-full border-r border-slate-200 z-10">
            {navContent}
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-4 sm:px-8 h-14 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-md"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0 flex items-baseline gap-2">
              <span className="text-xs text-slate-400 hidden sm:inline">Workspace /</span>
              <h1 className="font-display text-sm sm:text-base font-semibold text-slate-900 truncate">{title}</h1>
            </div>
          </div>

          {primaryAction && <div className="shrink-0">{primaryAction}</div>}
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-[1320px] w-full mx-auto">
          {subtitle && <p className="text-sm text-slate-600 mb-6 max-w-3xl">{subtitle}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}
