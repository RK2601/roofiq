import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  MapPin,
  FolderOpen,
  FileText,
  BarChart3,
  Settings,
  LogOut,
  Bell,
  Megaphone,
  Menu,
  X,
} from 'lucide-react';
import { AppView, User } from '../types';

interface DashboardLayoutProps {
  view: AppView;
  user: User;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
  children: React.ReactNode;
  fullHeight?: boolean;
  /** Shown under the header when DB is missing or failed to initialize (e.g. Vercel env not set at build time). */
  dbBanner?: string | null;
}

const PAGE_TITLES: Partial<Record<AppView, string>> = {
  dashboard: 'Dashboard',
  analysis: 'New Analysis',
  projects: 'Projects',
  'quotes-list': 'Quotes',
  reports: 'Reports',
  settings: 'Settings',
  quote: 'Quote',
  marketing: 'Marketing Intelligence',
};

const MAIN_NAV: Array<{ view: AppView; label: string; icon: React.ReactNode }> = [
  { view: 'dashboard',   label: 'Dashboard',   icon: <LayoutDashboard size={18} /> },
  { view: 'analysis',    label: 'New Analysis', icon: <MapPin size={18} /> },
  { view: 'projects',    label: 'Projects',     icon: <FolderOpen size={18} /> },
  { view: 'quotes-list', label: 'Quotes',       icon: <FileText size={18} /> },
  { view: 'marketing',   label: 'Marketing',    icon: <Megaphone size={18} /> },
  { view: 'reports',     label: 'Reports',      icon: <BarChart3 size={18} /> },
];

const SYSTEM_NAV: Array<{ view: AppView; label: string; icon: React.ReactNode }> = [
  { view: 'settings', label: 'Settings', icon: <Settings size={18} /> },
];

export default function DashboardLayout({
  view,
  user,
  onNavigate,
  onLogout,
  children,
  fullHeight = false,
  dbBanner = null,
}: DashboardLayoutProps) {
  const pageTitle = PAGE_TITLES[view] ?? 'RoofIQ';
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [view]);

  const go = (v: AppView) => {
    onNavigate(v);
    setNavOpen(false);
  };

  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden bg-slate-50">
      {/* Mobile overlay */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Sidebar — drawer on small screens */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50 w-[min(18.5rem,90vw)] lg:w-64
          flex flex-col flex-shrink-0 bg-slate-900
          transform transition-transform duration-200 ease-out
          ${navOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 lg:px-6 lg:pt-6 lg:pb-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-base">R</span>
            </div>
            <span className="text-white text-lg font-bold truncate">RoofIQ</span>
          </div>
          <button
            type="button"
            className="lg:hidden tap-target flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 -mr-1"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            <X size={22} />
          </button>
        </div>
        <div className="hidden lg:block px-6 pb-4">
          <div className="border-b border-blue-600 mt-1" />
        </div>

        <nav className="flex-1 px-3 sm:px-4 py-2 overflow-y-auto overscroll-contain">
          <p className="text-slate-500 text-xs font-semibold tracking-wider uppercase px-2 mb-2">Main</p>
          <ul className="space-y-1 mb-6">
            {MAIN_NAV.map(item => (
              <li key={item.view}>
                <button
                  type="button"
                  onClick={() => go(item.view)}
                  className={`w-full flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm font-medium transition-colors touch-manipulation ${
                    view === item.view
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-800'
                  }`}
                >
                  {item.icon}
                  <span className="text-left">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>

          <p className="text-slate-500 text-xs font-semibold tracking-wider uppercase px-2 mb-2">System</p>
          <ul className="space-y-1">
            {SYSTEM_NAV.map(item => (
              <li key={item.view}>
                <button
                  type="button"
                  onClick={() => go(item.view)}
                  className={`w-full flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm font-medium transition-colors touch-manipulation ${
                    view === item.view
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800 active:bg-slate-800'
                  }`}
                >
                  {item.icon}
                  <span className="text-left">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="px-3 sm:px-4 py-4 border-t border-slate-800 safe-pb">
          <div className="flex items-center gap-3 mb-3 min-w-0">
            <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-bold">{user.avatar}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-sm font-medium truncate">{user.name}</p>
              <p className="text-slate-400 text-xs truncate">{user.role}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 min-h-[48px] rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-sm transition-colors touch-manipulation"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <header className="min-h-[3.5rem] sm:h-16 bg-white border-b border-slate-200 flex items-center justify-between gap-2 px-3 sm:px-6 flex-shrink-0 pt-[max(0.5rem,env(safe-area-inset-top,0px))] sm:pt-[max(0.75rem,env(safe-area-inset-top,0px))] lg:pt-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              type="button"
              className="lg:hidden tap-target flex items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 -ml-1 flex-shrink-0"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={22} />
            </button>
            <h1 className="text-base sm:text-lg font-semibold text-slate-900 truncate">{pageTitle}</h1>
          </div>
          <div className="flex items-center gap-1 sm:gap-3 flex-shrink-0">
            <button
              type="button"
              className="tap-target flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-lg"
              aria-label="Notifications"
            >
              <Bell size={20} />
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-white text-xs font-bold">{user.avatar}</span>
              </div>
              <span className="text-sm font-medium text-slate-700 max-w-[100px] sm:max-w-none truncate hidden sm:inline">{user.name}</span>
            </div>
          </div>
        </header>

        {dbBanner && (
          <div className="flex-shrink-0 px-3 sm:px-6 py-2.5 sm:py-3 bg-amber-50 border-b border-amber-200 text-amber-950 text-xs sm:text-sm leading-relaxed">
            <strong className="font-semibold">Database:</strong> {dbBanner}
          </div>
        )}

        <main
          className={`flex-1 min-h-0 safe-pb ${fullHeight ? 'overflow-hidden flex flex-col' : 'overflow-y-auto overscroll-y-contain'} bg-slate-50`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
