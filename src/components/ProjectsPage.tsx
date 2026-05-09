import { useEffect, useState } from 'react';
import { MapPin, FolderOpen, Eye, ChevronRight, Layers, Ruler } from 'lucide-react';
import { getRecentProjects } from '../utils/db';
import ProjectDetailModal from './ProjectDetailModal';

interface ProjectsPageProps {
  onNewAnalysis: () => void;
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

export default function ProjectsPage({ onNewAnalysis }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getRecentProjects(50)
      .then(rows => setProjects(rows as Project[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="max-w-[1600px] mx-auto px-4 py-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 mb-5 sm:mb-6">
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Projects</h2>
            {!loading && (
              <p className="text-slate-500 text-sm mt-1">
                Showing {projects.length} project{projects.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onNewAnalysis}
            className="touch-manipulation shrink-0 inline-flex items-center justify-center gap-2 min-h-[48px] w-full sm:w-auto bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white px-4 py-3 rounded-xl font-semibold text-sm shadow-sm transition-colors"
          >
            <MapPin size={18} aria-hidden />
            New Analysis
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <>
              <div className="lg:hidden p-3 space-y-2 animate-pulse">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[5.25rem] rounded-xl bg-slate-100" />
                ))}
              </div>
              <div className="hidden lg:block animate-pulse">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-6 py-4 border-b border-slate-100 flex items-center gap-4">
                    <div className="h-4 bg-slate-200 rounded w-6" />
                    <div className="h-4 bg-slate-200 rounded flex-1" />
                    <div className="h-4 bg-slate-200 rounded w-16" />
                    <div className="h-4 bg-slate-200 rounded w-24" />
                    <div className="h-4 bg-slate-200 rounded w-24" />
                    <div className="w-20 h-12 bg-slate-200 rounded" />
                    <div className="h-8 bg-slate-200 rounded w-16" />
                  </div>
                ))}
              </div>
            </>
          ) : projects.length === 0 ? (
            <div className="p-8 sm:p-16 text-center">
              <FolderOpen size={48} className="text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500 font-semibold text-lg">No projects yet</p>
              <p className="text-slate-400 text-sm mt-2 mb-6 leading-relaxed max-w-md mx-auto">
                Start a new analysis to create your first project.
              </p>
              <button
                type="button"
                onClick={onNewAnalysis}
                className="touch-manipulation inline-flex items-center justify-center gap-2 min-h-[48px] bg-blue-600 hover:bg-blue-700 text-white px-5 py-3 rounded-xl font-semibold text-sm transition-colors"
              >
                <MapPin size={18} aria-hidden />
                New Analysis
              </button>
            </div>
          ) : (
            <>
              <ul className="lg:hidden p-2 sm:p-3 space-y-2 list-none">
                {projects.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className="touch-manipulation w-full flex gap-3 p-3 sm:p-4 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 active:bg-slate-100 text-left transition-colors min-h-[4.75rem]"
                    >
                      <div className="shrink-0">
                        {p.snapshot_url ? (
                          <img
                            src={p.snapshot_url}
                            alt=""
                            className="w-14 h-14 sm:w-16 sm:h-16 object-cover rounded-lg border border-slate-200 shadow-sm"
                          />
                        ) : (
                          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center">
                            <MapPin size={20} className="text-slate-300" aria-hidden />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className="font-semibold text-slate-900 text-sm leading-snug line-clamp-2">{p.address}</p>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] sm:text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                            <Layers size={13} className="text-blue-600 shrink-0" aria-hidden />
                            {p.section_count} sections
                          </span>
                          <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                            <Ruler size={13} className="text-slate-400 shrink-0" aria-hidden />
                            {p.total_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq&nbsp;ft
                          </span>
                          <span className="tabular-nums text-slate-400">{formatShortDate(p.created_at)}</span>
                        </div>
                      </div>
                      <ChevronRight size={20} className="shrink-0 text-slate-300 self-center" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10">#</th>
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Sections</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Area</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                      <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Preview</th>
                      <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {projects.map((p, idx) => (
                      <tr
                        key={p.id}
                        className="hover:bg-slate-50 transition-colors cursor-pointer"
                        onClick={() => setSelectedId(p.id)}
                      >
                        <td className="px-6 py-3 text-slate-400">{idx + 1}</td>
                        <td className="px-6 py-3 font-medium text-slate-800 max-w-xs">
                          <span className="block truncate">{p.address}</span>
                        </td>
                        <td className="px-6 py-3 text-right text-slate-600">{p.section_count}</td>
                        <td className="px-6 py-3 text-right text-slate-600">
                          {p.total_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                        </td>
                        <td className="px-6 py-3 text-right text-slate-400">
                          {formatShortDate(p.created_at)}
                        </td>
                        <td className="px-6 py-3 text-center">
                          {p.snapshot_url ? (
                            <img
                              src={p.snapshot_url}
                              alt={p.address}
                              className="w-20 h-12 object-cover rounded mx-auto border border-slate-200"
                            />
                          ) : (
                            <div className="w-20 h-12 bg-slate-100 rounded mx-auto flex items-center justify-center border border-slate-200">
                              <MapPin size={16} className="text-slate-300" />
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(p.id)}
                            className="touch-manipulation inline-flex items-center justify-center gap-1.5 min-h-[40px] min-w-[88px] bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
                          >
                            <Eye size={13} aria-hidden />
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {!loading && projects.length > 0 && (
          <p className="text-slate-400 text-xs mt-3">
            Showing {projects.length} of {projects.length} projects
          </p>
        )}
      </div>

      {selectedId && (
        <ProjectDetailModal
          projectId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}
