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
} from 'lucide-react';
import { AppView, User } from '../types';

interface DashboardLayoutProps {
  view: AppView;
  user: User;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
  children: React.ReactNode;
  fullHeight?: boolean;
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
}: DashboardLayoutProps) {
  const pageTitle = PAGE_TITLES[view] ?? 'RoofIQ';

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-base">R</span>
            </div>
            <span className="text-white text-lg font-bold">RoofIQ</span>
          </div>
          <div className="border-b border-blue-600 mt-3" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-2 overflow-y-auto">
          {/* MAIN section */}
          <p className="text-slate-500 text-xs font-semibold tracking-wider uppercase px-2 mb-2">Main</p>
          <ul className="space-y-1 mb-6">
            {MAIN_NAV.map(item => (
              <li key={item.view}>
                <button
                  onClick={() => onNavigate(item.view)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    view === item.view
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>

          {/* SYSTEM section */}
          <p className="text-slate-500 text-xs font-semibold tracking-wider uppercase px-2 mb-2">System</p>
          <ul className="space-y-1">
            {SYSTEM_NAV.map(item => (
              <li key={item.view}>
                <button
                  onClick={() => onNavigate(item.view)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    view === item.view
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* User area */}
        <div className="px-4 py-4 border-t border-slate-800">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-bold">{user.avatar}</span>
            </div>
            <div className="min-w-0">
              <p className="text-white text-sm font-medium truncate">{user.name}</p>
              <p className="text-slate-400 text-xs truncate">{user.role}</p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-sm transition-colors"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 flex-shrink-0">
          <h1 className="text-lg font-semibold text-slate-900">{pageTitle}</h1>
          <div className="flex items-center gap-4">
            <button className="text-slate-400 hover:text-slate-600 transition-colors">
              <Bell size={20} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                <span className="text-white text-xs font-bold">{user.avatar}</span>
              </div>
              <span className="text-sm font-medium text-slate-700">{user.name}</span>
            </div>
          </div>
        </header>

        {/* Content area */}
        <main className={`flex-1 ${fullHeight ? 'overflow-hidden flex flex-col' : 'overflow-auto'} bg-slate-50`}>
          {children}
        </main>
      </div>
    </div>
  );
}
