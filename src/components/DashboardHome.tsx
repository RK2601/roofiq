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
    <div className="bg-white rounded-xl p-6 border border-slate-200 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-4 bg-slate-200 rounded w-24" />
        <div className="w-10 h-10 bg-slate-200 rounded-lg" />
      </div>
      <div className="h-8 bg-slate-200 rounded w-20" />
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
    <div className="p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Welcome back 👋</h2>
          <p className="text-slate-500 mt-1">Here's what's happening with your projects.</p>
        </div>
        <button
          onClick={onNewAnalysis}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors"
        >
          <MapPin size={16} />
          Start New Analysis
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {loadingStats
          ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          : statCards.map(card => (
              <div key={card.label} className="bg-white rounded-xl p-6 border border-slate-200">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium text-slate-500">{card.label}</p>
                  <div className={`w-10 h-10 ${card.bg} rounded-lg flex items-center justify-center`}>
                    {card.icon}
                  </div>
                </div>
                <p className="text-2xl font-bold text-slate-900">{card.value}</p>
              </div>
            ))}
      </div>

      {/* Recent Projects */}
      <section>
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Projects</h3>
        {loadingProjects ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden animate-pulse">
                <div className="h-32 bg-slate-200" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                  <div className="h-3 bg-slate-200 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <FolderOpen size={40} className="text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">No projects yet</p>
            <p className="text-slate-400 text-sm mt-1">Start a new analysis to create your first project.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map(p => (
              <div
                key={p.id}
                onClick={() => setSelectedProjectId(p.id)}
                className="bg-white rounded-xl border border-slate-200 overflow-hidden group cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
              >
                <div
                  className="h-32 bg-slate-100 bg-cover bg-center relative"
                  style={p.snapshot_url ? { backgroundImage: `url(${p.snapshot_url})` } : undefined}
                >
                  {!p.snapshot_url && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <MapPin size={24} className="text-slate-300" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <span className="bg-white text-slate-800 text-xs font-semibold px-3 py-1.5 rounded-full shadow">View</span>
                  </div>
                </div>
                <div className="p-4">
                  <p className="text-sm font-semibold text-slate-800 truncate">{p.address}</p>
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
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Quotes</h3>
        {loadingQuotes ? (
          <div className="bg-white rounded-xl border border-slate-200 animate-pulse">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-6 py-4 border-b border-slate-100 flex gap-4">
                <div className="h-4 bg-slate-200 rounded flex-1" />
                <div className="h-4 bg-slate-200 rounded w-24" />
                <div className="h-4 bg-slate-200 rounded w-16" />
              </div>
            ))}
          </div>
        ) : quotes.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <FileText size={40} className="text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">No quotes yet</p>
            <p className="text-slate-400 text-sm mt-1">Complete an analysis to generate your first quote.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Material</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Squares</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {quotes.map(q => (
                  <tr key={q.id} onClick={() => setSelectedQuoteId(q.id)} className="hover:bg-slate-50 transition-colors cursor-pointer">
                    <td className="px-6 py-3 text-slate-700 max-w-xs truncate">{q.address ?? '—'}</td>
                    <td className="px-6 py-3 text-slate-600">{q.material_name}</td>
                    <td className="px-6 py-3 text-right text-slate-600">{q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })}</td>
                    <td className="px-6 py-3 text-right font-semibold text-slate-800">
                      {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-400">
                      {new Date(q.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
