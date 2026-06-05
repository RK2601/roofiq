import { useEffect, useMemo, useState } from 'react';
import { FolderPlus, FolderOpen, Loader2, Search, X } from 'lucide-react';
import { getRecentProjects, buildProjectDisplayName } from '../utils/db';

export type SaveProjectChoicePurpose = 'quick' | 'wizard';

interface ProjectRow {
  id: string;
  address: string;
  display_name: string | null;
  project_name: string | null;
  created_at: string;
}

interface SaveProjectChoiceModalProps {
  open: boolean;
  purpose: SaveProjectChoicePurpose | null;
  currentAddress?: string;
  onCancel: () => void;
  onChooseNew: (folderName: string) => void;
  onChooseExisting: (projectId: string, displayTitle: string) => void;
}

function formatListTitle(p: ProjectRow): string {
  const dn = (p.display_name ?? '').trim();
  if (dn) return dn;
  return buildProjectDisplayName(p.project_name, p.address);
}

function projectMatchesSearch(p: ProjectRow, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    formatListTitle(p),
    p.address,
    p.project_name ?? '',
    p.display_name ?? '',
    p.id,
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

export default function SaveProjectChoiceModal({
  open,
  purpose,
  currentAddress,
  onCancel,
  onChooseNew,
  onChooseExisting,
}: SaveProjectChoiceModalProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [newProjectName, setNewProjectName] = useState('');

  useEffect(() => {
    if (!open || !purpose) return;
    setTab('new');
    setSelectedId(null);
    setProjectSearchQuery('');
    setNewProjectName('');
    setLoadError(null);
    setLoading(true);
    getRecentProjects(40)
      .then(rows => setProjects(rows as ProjectRow[]))
      .catch(() => setLoadError('Could not load projects.'))
      .finally(() => setLoading(false));
  }, [open, purpose]);

  const filteredProjects = useMemo(
    () => projects.filter(p => projectMatchesSearch(p, projectSearchQuery)),
    [projects, projectSearchQuery]
  );

  useEffect(() => {
    if (!open || !purpose) return;
    if (!selectedId) return;
    if (!filteredProjects.some(p => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [open, purpose, filteredProjects, selectedId]);

  if (!open || !purpose) return null;

  const title =
    purpose === 'quick'
      ? 'Save this analysis where?'
      : 'Open the wizard in which project?';

  const addrNorm = (currentAddress ?? '').trim().toLowerCase();
  const sameAddress = (addr: string) => addrNorm.length > 0 && addr.trim().toLowerCase() === addrNorm;

  const handleConfirm = () => {
    if (tab === 'new') {
      const name = newProjectName.trim();
      if (!name) return;
      onChooseNew(name);
      return;
    }
    if (tab === 'existing' && selectedId) {
      const row = projects.find(p => p.id === selectedId);
      onChooseExisting(selectedId, row ? formatListTitle(row) : selectedId);
    }
  };

  const canConfirm =
    (tab === 'new' && newProjectName.trim().length > 0) ||
    (tab === 'existing' && !!selectedId);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center p-0 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        aria-label="Close dialog"
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-project-choice-title"
        className="relative z-[61] w-full max-w-md rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl max-h-[min(90vh,640px)] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="save-project-choice-title" className="text-base font-bold text-slate-900 leading-snug">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-4 sm:px-5 gap-1 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setTab('new')}
            className={`flex items-center gap-2 px-3 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === 'new'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FolderPlus size={16} aria-hidden />
            New project
          </button>
          <button
            type="button"
            onClick={() => { setTab('existing'); setNewProjectName(''); }}
            className={`flex items-center gap-2 px-3 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === 'existing'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FolderOpen size={16} aria-hidden />
            Existing project
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
          {tab === 'new' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 leading-relaxed">
                Start a fresh project folder for this property.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="new-project-name" className="block text-xs font-semibold text-slate-700">
                  Project name <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-project-name"
                  type="text"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  placeholder="e.g. Smith residence, Job #1042"
                  className="w-full rounded-lg border border-slate-200 bg-white py-2.5 px-3 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  autoComplete="off"
                  maxLength={120}
                  autoFocus
                />
                <p className="text-[11px] text-slate-400 leading-snug">
                  Saved with this address so you can find the job in Projects.
                </p>
              </div>
            </div>
          )}

          {tab === 'existing' && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 leading-relaxed">
                Save into a project you already have so quick map, wizard, and quotes stay in one place.
              </p>
              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                  Loading projects…
                </div>
              )}
              {loadError && <p className="py-4 text-center text-xs text-red-600">{loadError}</p>}
              {!loading && !loadError && projects.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-500">
                  No saved projects yet.{' '}
                  <button type="button" onClick={() => setTab('new')} className="text-blue-600 underline">
                    Create a new one
                  </button>
                </p>
              )}
              {!loading && !loadError && projects.length > 0 && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search
                      size={16}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={projectSearchQuery}
                      onChange={e => setProjectSearchQuery(e.target.value)}
                      placeholder="Search by name, address, or id…"
                      className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-8 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      aria-label="Search existing projects"
                    />
                    {projectSearchQuery.trim() !== '' && (
                      <button
                        type="button"
                        onClick={() => setProjectSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        aria-label="Clear search"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    )}
                  </div>
                  {filteredProjects.length === 0 ? (
                    <p className="py-3 text-center text-xs text-slate-500">
                      No projects match &quot;{projectSearchQuery.trim()}&quot;.
                    </p>
                  ) : (
                    <p className="px-1 text-[10px] text-slate-400">
                      {filteredProjects.length === projects.length
                        ? `${projects.length} project${projects.length !== 1 ? 's' : ''}`
                        : `${filteredProjects.length} of ${projects.length} shown`}
                    </p>
                  )}
                  <ul className="max-h-52 overflow-y-auto space-y-1 list-none p-0 m-0">
                    {filteredProjects.map(p => {
                      const active = selectedId === p.id;
                      const match = sameAddress(p.address);
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(p.id)}
                            className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                              active ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                            }`}
                          >
                            <div className="font-medium leading-snug line-clamp-2">{formatListTitle(p)}</div>
                            <div className={`mt-0.5 text-[11px] leading-snug line-clamp-1 ${active ? 'text-blue-100' : 'text-slate-500'}`}>
                              {p.address}
                              {match && (
                                <span className={active ? 'text-amber-200' : 'text-amber-700'}> · Same address as map</span>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className="min-h-[44px] rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
