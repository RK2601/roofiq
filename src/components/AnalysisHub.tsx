import { Zap, Map, Camera, Cpu, Layers, Sparkles } from 'lucide-react';
import { AppView } from '../types';

interface AnalysisHubProps {
  onNavigate: (view: AppView, wizardMode?: boolean, autoSegmentMode?: boolean, aiSegmentMode?: boolean) => void;
}

interface RouteCard {
  view: AppView;
  wizardMode?: boolean;
  autoSegmentMode?: boolean;
  aiSegmentMode?: boolean;
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

const ROUTES: RouteCard[] = [
  {
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
    view: 'analysis',
    wizardMode: true,
    icon: <Map size={28} />,
    badge: 'Smart',
    badgeColor: 'bg-blue-100 text-blue-700',
    title: 'Smart Roof Wizard',
    subtitle: 'Step-by-step guided AI + DSM measurement',
    features: [
      'Multi-segment roof mapping',
      'Google Solar DSM elevation data',
      'Gemini AI structure detection',
      'Per-facet pitch, area & direction',
    ],
    cta: 'Open Roof Wizard',
    gradient: 'from-blue-50 to-indigo-50',
    borderColor: 'border-blue-200 hover:border-blue-400',
    iconBg: 'bg-blue-100 text-blue-600',
  },
  {
    view: 'hover-measure',
    icon: <Camera size={28} />,
    badge: 'Pro · Paid',
    badgeColor: 'bg-purple-100 text-purple-700',
    title: 'HOVER Measurement',
    subtitle: 'Contractor-grade photogrammetry from 8 photos',
    features: [
      'Upload 8 directional photos',
      'Professional 3D model generated',
      'Exact area, pitch, length measurements',
      'Industry-standard accuracy',
    ],
    cta: 'Use HOVER API',
    gradient: 'from-purple-50 to-fuchsia-50',
    borderColor: 'border-purple-200 hover:border-purple-400',
    iconBg: 'bg-purple-100 text-purple-600',
  },
  {
    view: 'depth-measure',
    icon: <Cpu size={28} />,
    badge: 'AI · Beta',
    badgeColor: 'bg-emerald-100 text-emerald-700',
    title: 'AI Depth Analysis',
    subtitle: 'Zero-shot 3D depth from a single photo',
    features: [
      'Upload one aerial or street photo',
      'Apple Depth Pro / MoGe-2 AI model',
      'Instant depth map & pitch estimate',
      'No API key needed beyond Replicate',
    ],
    cta: 'Analyse with AI Depth',
    gradient: 'from-emerald-50 to-teal-50',
    borderColor: 'border-emerald-200 hover:border-emerald-400',
    iconBg: 'bg-emerald-100 text-emerald-600',
  },
  {
    view: 'analysis',
    wizardMode: true,
    autoSegmentMode: true,
    icon: <Layers size={28} />,
    badge: 'Auto · DSM',
    badgeColor: 'bg-cyan-100 text-cyan-700',
    title: 'DSM Auto-Map',
    subtitle: 'AI-free roof plane detection from elevation data',
    features: [
      'No manual drawing required',
      'DBSCAN clusters pixels by slope & aspect',
      'Each roof plane auto-detected as polygon',
      'Uses Google Solar 0.1 m/pixel DSM raster',
    ],
    cta: 'Auto-detect Roof Planes',
    gradient: 'from-cyan-50 to-sky-50',
    borderColor: 'border-cyan-200 hover:border-cyan-400',
    iconBg: 'bg-cyan-100 text-cyan-600',
  },
  {
    view: 'analysis',
    wizardMode: true,
    aiSegmentMode: true,
    icon: <Sparkles size={28} />,
    badge: 'AI · Vision',
    badgeColor: 'bg-rose-100 text-rose-700',
    title: 'AI Visual Segment',
    subtitle: 'DeepLabv3+-inspired segmentation from satellite imagery',
    features: [
      'Gemini vision reads the satellite image directly',
      'Detects each roof plane by visual boundaries',
      'Returns polygon outlines + pitch & facing per plane',
      'Complements DSM — works on any roof type',
    ],
    cta: 'Segment with AI Vision',
    gradient: 'from-rose-50 to-pink-50',
    borderColor: 'border-rose-200 hover:border-rose-400',
    iconBg: 'bg-rose-100 text-rose-600',
  },
];

export default function AnalysisHub({ onNavigate }: AnalysisHubProps) {
  return (
    <div className="min-h-full bg-slate-50 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Choose Analysis Method</h1>
          <p className="text-slate-500 text-lg">
            Pick the right tool for the job — from quick estimates to contractor-grade measurements.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {ROUTES.map((route, i) => (
            <button
              key={i}
              onClick={() => onNavigate(route.view, route.wizardMode, route.autoSegmentMode, route.aiSegmentMode)}
              className={`text-left bg-gradient-to-br ${route.gradient} border-2 ${route.borderColor} rounded-2xl p-6 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500`}
            >
              <div className="flex items-start gap-4 mb-4">
                <div className={`w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0 ${route.iconBg}`}>
                  {route.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
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
          Quick Analysis, Smart Roof Wizard, DSM Auto-Map and AI Visual Segment require a Google Maps + Gemini API key.
          HOVER requires a HOVER API key. AI Depth requires a Replicate token.
        </p>
      </div>
    </div>
  );
}
