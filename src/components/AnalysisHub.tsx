import { Zap, Layers } from 'lucide-react';
import { AppView } from '../types';

interface AnalysisHubProps {
  onNavigate: (view: AppView, wizardMode?: boolean, autoSegmentMode?: boolean) => void;
}

interface HubCard {
  key: string;
  view: AppView;
  wizardMode?: boolean;
  autoSegmentMode?: boolean;
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  title: string;
  subtitle: string;
  features: string[];
  cta: string;
  gradient: string;
  borderColor: string;
  iconBg: string;
}

const HUB_CARDS: HubCard[] = [
  {
    key: 'quick',
    view: 'analysis',
    wizardMode: false,
    icon: <Zap size={28} />,
    badge: 'Fast',
    badgeColor: 'bg-amber-100 text-amber-700',
    title: 'Quick Analysis',
    subtitle: 'AI-powered estimate in under 2 minutes',
    features: [
      'Draw roof outline on satellite map',
      'AI estimates pitch & material',
      'Instant quote generation',
      'Best for ballpark estimates',
    ],
    cta: 'Start Quick Analysis',
    gradient: 'from-amber-50 to-orange-50',
    borderColor: 'border-amber-200 hover:border-amber-400',
    iconBg: 'bg-amber-100 text-amber-600',
  },
  {
    key: 'dsm-auto',
    view: 'analysis',
    wizardMode: true,
    autoSegmentMode: true,
    icon: <Layers size={28} />,
    badge: 'Auto · DSM',
    badgeColor: 'bg-cyan-100 text-cyan-700',
    title: 'DSM Auto-Map',
    subtitle: 'Elevation-based planes + Gemini satellite labels',
    features: [
      'No manual drawing required — DBSCAN on Solar DSM raster',
      'Authoritative pitch & facing from elevation per plane',
      'Gemini labels each DSM plane using the same satellite image',
      'Disagreements flagged; measurements stay DSM-first',
    ],
    cta: 'Auto-detect Roof Planes',
    gradient: 'from-cyan-50 to-sky-50',
    borderColor: 'border-cyan-200 hover:border-cyan-400',
    iconBg: 'bg-cyan-100 text-cyan-600',
  },
];

export default function AnalysisHub({ onNavigate }: AnalysisHubProps) {
  return (
    <div className="min-h-full bg-slate-50 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Choose Analysis Method</h1>
          <p className="text-slate-500 text-lg">
            Quick estimate or DSM auto-map. AccuMeasure, Smart Roof Wizard, AI Depth, and HOVER are in the sidebar
            under Measurement tools.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {HUB_CARDS.map(route => (
            <button
              key={route.key}
              type="button"
              onClick={() => onNavigate(route.view, route.wizardMode, route.autoSegmentMode)}
              className={`text-left bg-gradient-to-br ${route.gradient} border-2 ${route.borderColor} rounded-2xl p-6 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500`}
            >
              <div className="flex items-start gap-4 mb-4">
                <div className={`w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0 ${route.iconBg}`}>
                  {route.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h2 className="text-lg font-semibold text-slate-900">{route.title}</h2>
                    {route.badge && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${route.badgeColor}`}>
                        {route.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">{route.subtitle}</p>
                </div>
              </div>

              <ul className="space-y-1.5 mb-5">
                {route.features.map((f, j) => (
                  <li key={j} className="flex items-center gap-2 text-sm text-slate-600">
                    <span className="w-4 h-4 rounded-full bg-white/70 flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-slate-400">
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">{route.cta}</span>
                <span className="text-slate-400">→</span>
              </div>
            </button>
          ))}
        </div>

        <p className="text-center text-xs text-slate-400 mt-8">
          Quick Analysis and DSM Auto-Map require Google Maps + Gemini API keys.
        </p>
      </div>
    </div>
  );
}
