import { useEffect, useState } from 'react';
import { MapPin, FolderOpen, FileText, Ruler, DollarSign } from 'lucide-react';
import { getStats, getRecentProjects, getRecentQuotes } from '../utils/db';
import ProjectDetailModal from './ProjectDetailModal';
import QuoteDetailModal from './QuoteDetailModal';

interface DashboardHomeProps {
  onNewAnalysis: () => void;
}

interface Stats {
  total_projects: number;
  total_quotes: number;
  total_area: number;
  total_value: number;
}

interface Project {
  id: string;
  address: string;
  lat: number;
  lng: number;
  snapshot_url: string | null;
  created_at: string;
  section_count: number;
  total_area: number;
}

interface Quote {
  id: string;
  material_name: string;
  total_squares: number;
  total: number;
  generated_at: string;
  address: string | null;
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 border border-slate-200 animate-pulse">
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <div className="h-3.5 sm:h-4 bg-slate-200 rounded w-24" />
        <div className="w-9 h-9 sm:w-10 sm:h-10 bg-slate-200 rounded-lg" />
      </div>
      <div className="h-7 sm:h-8 bg-slate-200 rounded w-20" />
    </div>
  );
}

export default function DashboardHome({ onNewAnalysis }: DashboardHomeProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingQuotes, setLoadingQuotes] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);

  useEffect(() => {
    getStats()
      .then(s => setStats(s))
      .catch(console.error)
      .finally(() => setLoadingStats(false));

    getRecentProjects(8)
      .then(rows => setProjects(rows as Project[]))
      .catch(console.error)
      .finally(() => setLoadingProjects(false));

    getRecentQuotes(8)
      .then(rows => setQuotes(rows as Quote[]))
      .catch(console.error)
      .finally(() => setLoadingQuotes(false));
  }, []);

  const statCards = [
    {
      label: 'Total Projects',
      value: stats ? stats.total_projects.toLocaleString('en-US') : '—',
      icon: <FolderOpen size={20} className="text-blue-600" />,
      bg: 'bg-blue-50',
    },
    {
      label: 'Total Quotes',
      value: stats ? stats.total_quotes.toLocaleString('en-US') : '—',
      icon: <FileText size={20} className="text-green-600" />,
      bg: 'bg-green-50',
    },
    {
      label: 'Total Area Measured',
      value: stats
        ? stats.total_area.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' sq ft'
        : '—',
      icon: <Ruler size={20} className="text-orange-600" />,
      bg: 'bg-orange-50',
    },
    {
      label: 'Total Est. Value',
      value: stats
        ? stats.total_value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
        : '—',
      icon: <DollarSign size={20} className="text-purple-600" />,
      bg: 'bg-purple-50',
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 sm:space-y-8 pb-6 sm:pb-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">Welcome back 👋</h2>
          <p className="text-slate-500 text-sm sm:text-base mt-1 leading-relaxed">
            Here&apos;s what&apos;s happening with your projects.
          </p>
        </div>
        <button
          type="button"
          onClick={onNewAnalysis}
          className="touch-manipulation flex w-full sm:w-auto shrink-0 items-center justify-center gap-2 min-h-[48px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white px-4 py-3 rounded-xl font-semibold text-sm sm:text-base transition-colors shadow-sm"
        >
          <MapPin size={18} className="shrink-0" aria-hidden />
          <span className="sm:hidden">New analysis</span>
          <span className="hidden sm:inline">Start New Analysis</span>
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        {loadingStats
          ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          : statCards.map(card => (
              <div key={card.label} className="bg-white rounded-xl p-4 sm:p-6 border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
                  <p className="text-xs sm:text-sm font-medium text-slate-500 leading-snug">{card.label}</p>
                  <div className={`w-9 h-9 sm:w-10 sm:h-10 ${card.bg} rounded-lg flex items-center justify-center shrink-0`}>
                    {card.icon}
                  </div>
                </div>
                <p className="text-xl sm:text-2xl font-bold text-slate-900 tabular-nums break-words">{card.value}</p>
              </div>
            ))}
      </div>

      {/* Recent Projects */}
      <section>
        <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 sm:mb-4">Recent Projects</h3>
        {loadingProjects ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden animate-pulse">
                <div className="h-36 sm:h-32 bg-slate-200" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                  <div className="h-3 bg-slate-200 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 sm:p-12 text-center">
            <FolderOpen size={40} className="text-slate-300 mx-auto mb-3" aria-hidden />
            <p className="text-slate-500 font-medium">No projects yet</p>
            <p className="text-slate-400 text-sm mt-1">Start a new analysis to create your first project.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {projects.map(p => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedProjectId(p.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedProjectId(p.id); } }}
                className="touch-manipulation bg-white rounded-xl border border-slate-200 overflow-hidden active:scale-[0.99] transition-transform sm:transition-shadow sm:hover:border-blue-300 sm:hover:shadow-md sm:cursor-pointer group"
              >
                <div
                  className="h-40 sm:h-32 bg-slate-100 bg-cover bg-center relative"
                  style={p.snapshot_url ? { backgroundImage: `url(${p.snapshot_url})` } : undefined}
                >
                  {!p.snapshot_url && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <MapPin size={24} className="text-slate-300" aria-hidden />
                    </div>
                  )}
                  <div className="hidden sm:flex absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
                    <span className="bg-white text-slate-800 text-xs font-semibold px-3 py-1.5 rounded-full shadow">View</span>
                  </div>
                  <div className="sm:hidden absolute bottom-2 right-2 bg-white/95 text-slate-800 text-[10px] font-semibold px-2 py-1 rounded-md shadow">
                    Tap to open
                  </div>
                </div>
                <div className="p-4">
                  <p className="text-sm font-semibold text-slate-800 line-clamp-2 sm:truncate">{p.address}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {p.section_count} section{p.section_count !== 1 ? 's' : ''} ·{' '}
                    {p.total_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Quotes */}
      <section>
        <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 sm:mb-4">Recent Quotes</h3>
        {loadingQuotes ? (
          <div className="bg-white rounded-xl border border-slate-200 animate-pulse space-y-3 p-4 sm:p-0 sm:space-y-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="sm:px-6 sm:py-4 sm:border-b sm:border-slate-100 flex flex-col sm:flex-row gap-2 sm:gap-4">
                <div className="h-4 bg-slate-200 rounded flex-1" />
                <div className="h-4 bg-slate-200 rounded w-full sm:w-24" />
                <div className="h-4 bg-slate-200 rounded w-1/2 sm:w-16" />
              </div>
            ))}
          </div>
        ) : quotes.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 sm:p-12 text-center">
            <FileText size={40} className="text-slate-300 mx-auto mb-3" aria-hidden />
            <p className="text-slate-500 font-medium">No quotes yet</p>
            <p className="text-slate-400 text-sm mt-1">Complete an analysis to generate your first quote.</p>
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="sm:hidden space-y-3">
              {quotes.map(q => (
                <button
                  type="button"
                  key={q.id}
                  onClick={() => setSelectedQuoteId(q.id)}
                  className="touch-manipulation w-full text-left bg-white rounded-xl border border-slate-200 p-4 active:bg-slate-50 active:scale-[0.99] transition-transform shadow-sm"
                >
                  <p className="text-sm font-semibold text-slate-800 line-clamp-2">{q.address ?? '—'}</p>
                  <p className="text-xs text-slate-500 mt-1">{q.material_name}</p>
                  <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-slate-100">
                    <span className="text-xs text-slate-500 tabular-nums">
                      {q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })} sq
                    </span>
                    <span className="text-base font-bold text-slate-900 tabular-nums">
                      {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-2">
                    {new Date(q.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </button>
              ))}
            </div>
            {/* Tablet+: table */}
            <div className="hidden sm:block bg-white rounded-xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm min-w-[36rem]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 lg:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                    <th className="text-left px-4 lg:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Material</th>
                    <th className="text-right px-4 lg:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Squares</th>
                    <th className="text-right px-4 lg:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total</th>
                    <th className="text-right px-4 lg:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {quotes.map(q => (
                    <tr key={q.id} onClick={() => setSelectedQuoteId(q.id)} className="hover:bg-slate-50 transition-colors cursor-pointer">
                      <td className="px-4 lg:px-6 py-3 text-slate-700 max-w-[12rem] truncate">{q.address ?? '—'}</td>
                      <td className="px-4 lg:px-6 py-3 text-slate-600">{q.material_name}</td>
                      <td className="px-4 lg:px-6 py-3 text-right text-slate-600 tabular-nums">{q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })}</td>
                      <td className="px-4 lg:px-6 py-3 text-right font-semibold text-slate-800 tabular-nums">
                        {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-4 lg:px-6 py-3 text-right text-slate-400 whitespace-nowrap">
                        {new Date(q.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {selectedProjectId && (
        <ProjectDetailModal projectId={selectedProjectId} onClose={() => setSelectedProjectId(null)} />
      )}
      {selectedQuoteId && (
        <QuoteDetailModal quoteId={selectedQuoteId} onClose={() => setSelectedQuoteId(null)} />
      )}
    </div>
  );
}
