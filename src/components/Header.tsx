import { AppView } from '../types';
import { Home, Map, FileText, ChevronRight } from 'lucide-react';

interface HeaderProps {
  view: AppView;
  address: string;
  onNavigate: (view: AppView) => void;
}

const steps = [
  { id: 'landing', label: 'Search', icon: Home },
  { id: 'analysis', label: 'Measure', icon: Map },
  { id: 'quote', label: 'Quote', icon: FileText },
] as const;

export default function Header({ view, address, onNavigate }: HeaderProps) {
  const currentIndex = steps.findIndex(s => s.id === view);

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-slate-100 shadow-sm">
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        {/* Logo */}
        <button
          onClick={() => onNavigate('landing')}
          className="flex items-center gap-2 group"
        >
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-400 rounded-lg flex items-center justify-center shadow-md group-hover:shadow-blue-200 transition-shadow">
            <span className="text-white font-black text-sm">R</span>
          </div>
          <span className="font-bold text-lg text-slate-900">
            Roof<span className="text-blue-600">IQ</span>
          </span>
        </button>

        {/* Breadcrumb Steps */}
        <nav className="hidden sm:flex items-center gap-1">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            const isActive = step.id === view;
            const isCompleted = idx < currentIndex;
            const isClickable = idx < currentIndex;

            return (
              <div key={step.id} className="flex items-center gap-1">
                <button
                  onClick={() => isClickable && onNavigate(step.id)}
                  disabled={!isClickable && !isActive}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : isCompleted
                      ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-50 cursor-pointer'
                      : 'text-slate-300 cursor-default'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : isCompleted
                      ? 'bg-green-500 text-white'
                      : 'bg-slate-200 text-slate-400'
                  }`}>
                    {isCompleted ? '✓' : idx + 1}
                  </div>
                  <Icon size={13} />
                  {step.label}
                </button>
                {idx < steps.length - 1 && (
                  <ChevronRight size={14} className="text-slate-300" />
                )}
              </div>
            );
          })}
        </nav>

        {/* Address pill */}
        {address && view !== 'landing' && (
          <div className="hidden md:flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-full px-3 py-1.5 max-w-xs">
            <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0 animate-pulse" />
            <span className="text-xs text-slate-600 truncate">{address}</span>
          </div>
        )}
      </div>
    </header>
  );
}
