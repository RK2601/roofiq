import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin, FolderOpen, Eye, ChevronRight, Layers, Ruler, Search, X } from 'lucide-react';
import { getRecentProjects, projectTagLabel } from '../utils/db';
import ProjectDetailModal from './ProjectDetailModal';
import ProjectTagMenu, { projectTagTone } from './ProjectTagMenu';

interface ProjectsPageProps {
  onNewAnalysis: () => void;
  onOpenQuoteFromProject?: (projectId: string) => void | Promise<void>;
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
  project_name: string | null;
  display_name: string | null;
  project_tag: string | null;
  section_count: number;
  total_area: number;
}

function projectMatchesQuery(p: Project, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    p.address,
    p.display_name ?? '',
    p.project_name ?? '',
    projectTagLabel(p.project_tag) ?? '',
    p.id,
    String(p.section_count),
    String(Math.round(p.total_area)),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

export default function ProjectsPage({ onNewAnalysis, onOpenQuoteFromProject }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const reloadProjects = useCallback(() => {
    return getRecentProjects(50)
      .then(rows => setProjects(rows as Project[]))
      .catch(console.error);
  }, []);

  useEffect(() => {
    reloadProjects().finally(() => setLoading(false));
  }, [reloadProjects]);

  const filteredProjects = useMemo(
    () => projects.filter(p => projectMatchesQuery(p, searchQuery)),
    [projects, searchQuery]
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
      <div className="max-w-[1600px] mx-auto px-4 py-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Projects</h2>
            {!loading && (
              <p className="mt-1 text-sm text-slate-500">
                {searchQuery.trim()
                  ? `${filteredProjects.length} match${filteredProjects.length !== 1 ? 'es' : ''} · ${projects.length} total`
                  : `${projects.length} project${projects.length !== 1 ? 's' : ''}`}
              </p>
            )}
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-end sm:gap-3">
            {!loading && projects.length > 0 && (
              <div className="relative w-full min-w-0 sm:max-w-md sm:min-w-[12rem]">
                <Search
                  size={18}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search address, name, id…"
                  className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-10 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  aria-label="Search projects"
                />
                {searchQuery.trim() !== '' && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label="Clear search"
                  >
                    <X size={16} aria-hidden />
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={onNewAnalysis}
              className="touch-manipulation inline-flex min-h-[48px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 active:bg-blue-800 sm:w-auto"
            >
              <MapPin size={18} aria-hidden />
              New Analysis
            </button>
          </div>
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
                    <div className="h-8 bg-slate-200 rounded w-20" />
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
          ) : filteredProjects.length === 0 ? (
            <div className="p-8 sm:p-16 text-center">
              <Search size={40} className="text-slate-300 mx-auto mb-4" aria-hidden />
              <p className="text-slate-600 font-semibold text-lg">No matching projects</p>
              <p className="text-slate-400 text-sm mt-2 mb-6 max-w-md mx-auto leading-relaxed">
                Nothing matches &quot;{searchQuery.trim()}&quot;. Try a different address, folder name, or clear the search.
              </p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="touch-manipulation inline-flex items-center justify-center gap-2 min-h-[48px] rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear search
              </button>
            </div>
          ) : (
            <>
              <ul className="lg:hidden p-2 sm:p-3 space-y-2 list-none">
                {filteredProjects.map(p => (
                  <li key={p.id} className="flex gap-2 items-stretch">
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className="touch-manipulation min-w-0 flex-1 flex gap-2 sm:gap-3 px-2.5 py-3 sm:p-4 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 active:bg-slate-100 text-left transition-colors min-h-[4.75rem]"
                    >
                      <div className="shrink-0">
                        {p.snapshot_url ? (
                          <img
                            src={p.snapshot_url}
                            alt=""
                            className="w-12 h-12 sm:w-14 sm:h-14 object-cover rounded-lg border border-slate-200 shadow-sm"
                          />
                        ) : (
                          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center">
                            <MapPin size={20} className="text-slate-300" aria-hidden />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex items-start gap-2">
                          <p className="font-semibold text-slate-900 text-sm leading-snug line-clamp-2 min-w-0 flex-1">
                            {p.display_name?.trim() || p.address}
                          </p>
                          {projectTagLabel(p.project_tag) && (
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${projectTagTone(p.project_tag)}`}
                            >
                              {projectTagLabel(p.project_tag)}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 sm:gap-x-3 text-[11px] sm:text-xs text-slate-500">
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
                    <div
                      className="shrink-0 flex flex-col justify-center py-2"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <ProjectTagMenu
                        projectId={p.id}
                        currentTag={p.project_tag}
                        compact
                        onTagUpdated={tag =>
                          setProjects(prev => prev.map(x => (x.id === p.id ? { ...x, project_tag: tag } : x)))
                        }
                        onProjectDeleted={deletedId => {
                          setProjects(prev => prev.filter(x => x.id !== deletedId));
                          setSelectedId(cur => (cur === deletedId ? null : cur));
                        }}
                      />
                    </div>
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
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-36">Tag</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredProjects.map((p, idx) => (
                      <tr
                        key={p.id}
                        className="hover:bg-slate-50 transition-colors cursor-pointer"
                        onClick={() => setSelectedId(p.id)}
                      >
                        <td className="px-6 py-3 text-slate-400">{idx + 1}</td>
                        <td className="px-6 py-3 font-medium text-slate-800 max-w-xs">
                          <span className="block truncate">{p.display_name?.trim() || p.address}</span>
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
                        <td className="px-6 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            {projectTagLabel(p.project_tag) ? (
                              <span
                                className={`max-w-[6.5rem] truncate rounded-full px-2 py-0.5 text-xs font-semibold ${projectTagTone(p.project_tag)}`}
                                title={projectTagLabel(p.project_tag) ?? undefined}
                              >
                                {projectTagLabel(p.project_tag)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                            <ProjectTagMenu
                              projectId={p.id}
                              currentTag={p.project_tag}
                              compact
                              onTagUpdated={tag =>
                                setProjects(prev => prev.map(x => (x.id === p.id ? { ...x, project_tag: tag } : x)))
                              }
                              onProjectDeleted={deletedId => {
                                setProjects(prev => prev.filter(x => x.id !== deletedId));
                                setSelectedId(cur => (cur === deletedId ? null : cur));
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {!loading && projects.length > 0 && filteredProjects.length > 0 && (
          <p className="text-slate-400 text-xs mt-3">
            {searchQuery.trim()
              ? `Showing ${filteredProjects.length} of ${projects.length} projects`
              : `Showing ${projects.length} project${projects.length !== 1 ? 's' : ''}`}
          </p>
        )}
      </div>
      </div>

      {selectedId && (
        <ProjectDetailModal
          projectId={selectedId}
          layout="layer"
          onOpenQuoteFromProject={onOpenQuoteFromProject}
          onClose={() => setSelectedId(null)}
          onProjectDeleted={deletedId => {
            setProjects(prev => prev.filter(x => x.id !== deletedId));
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}
