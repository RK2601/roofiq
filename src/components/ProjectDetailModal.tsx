import { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { X, MapPin, Layers, Ruler, Calendar, ZoomIn, ChevronLeft, ChevronRight, Image, Brain, Loader2, AlertTriangle, FileText } from 'lucide-react';
import {
  getProjectDetails,
  getProjectSnapshots,
  getProjectSections,
  getWizardWorkflowReport,
  isDbConfigured,
  projectTagLabel,
  updateProjectSnapshotAiAnalysis,
  type WizardWorkflowReportPayload,
} from '../utils/db';
import WizardWorkflowReportView from './WizardWorkflowReportView';
import ProjectTagMenu, { projectTagTone } from './ProjectTagMenu';
import { analyzeRoofImage, RoofAnalysis, CONDITION_BG, URGENCY_BG, CONDITION_COLORS } from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';

type ProjectDetailTab = 'overview' | 'wizard';

interface Props {
  projectId: string;
  onClose: () => void;
  /** When true on mount, open the Smart Roof Mapping wizard report tab first. */
  defaultWizardTab?: boolean;
  onDefaultWizardTabConsumed?: () => void;
  /** Opens full quote view with sections loaded from this project. */
  onOpenQuoteFromProject?: (projectId: string) => void | Promise<void>;
  /** After the project row is deleted from the database (modal should close). */
  onProjectDeleted?: (projectId: string) => void;
  /**
   * `layer` — absolute inset-0 inside a relative parent (e.g. Projects list shell).
   * `column` — fixed to the main content column below the app header, beside the sidebar (dashboard home).
   */
  layout?: 'layer' | 'column';
}

interface ProjectDetail {
  id: string;
  address: string;
  lat: number;
  lng: number;
  snapshot_url: string | null;
  created_at: string;
  project_name: string | null;
  display_name: string | null;
  analysis_entry: string | null;
  project_tag: string | null;
  section_count: number;
  total_area: number;
}

function analysisEntryLabel(entry: string | null | undefined): string | null {
  const e = (entry ?? '').trim().toLowerCase();
  if (e === 'both' || e === 'quick+wizard') return 'Quick map + Wizard';
  if (e === 'wizard') return 'Wizard';
  if (e === 'quick') return 'Quick map';
  if (!e) return null;
  return 'Mixed analyses';
}

interface Snapshot {
  id: string;
  label: string;
  snapshot_url: string;
  ai_analysis?: RoofAnalysis | null;
}

interface Section {
  id: string;
  name: string;
  flat_area: number;
  pitch: string;
  pitch_multiplier: number;
  actual_area: number;
  color: string;
}

interface SnapAI {
  status: 'analyzing' | 'done' | 'error';
  result?: RoofAnalysis;
  error?: string;
}

function isPersistableSnapshotId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function snapAiFromRows(rows: Snapshot[]): Record<string, SnapAI> {
  const out: Record<string, SnapAI> = {};
  for (const r of rows) {
    const a = r.ai_analysis;
    if (a && typeof a === 'object' && 'condition' in a && 'urgency' in a) {
      out[r.id] = { status: 'done', result: a as RoofAnalysis };
    }
  }
  return out;
}

const SHELL_LAYER =
  'absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-white shadow-xl ring-1 ring-slate-200/60 motion-safe:animate-fade-in';
/** Fixed below dashboard header, to the right of the lg sidebar (w-64).
 *  Uses max-h instead of bottom-0 so short content doesn't leave blank space. */
const SHELL_COLUMN =
  'fixed right-0 left-0 top-[max(3.25rem,env(safe-area-inset-top,0px))] z-[60] flex flex-col overflow-hidden bg-white shadow-xl ring-1 ring-slate-200/60 motion-safe:animate-fade-in sm:top-16 lg:left-64 max-h-[calc(100vh-max(3.25rem,env(safe-area-inset-top,0px)))] sm:max-h-[calc(100vh-4rem)]';

export default function ProjectDetailModal({
  projectId,
  onClose,
  defaultWizardTab,
  onDefaultWizardTabConsumed,
  onOpenQuoteFromProject,
  onProjectDeleted,
  layout = 'column',
}: Props) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [snapAI, setSnapAI] = useState<Record<string, SnapAI>>({});
  const hasGeminiKey = !!readGeminiApiKey();

  const [activeTab, setActiveTab] = useState<ProjectDetailTab>(() => (defaultWizardTab ? 'wizard' : 'overview'));
  const [wizardReport, setWizardReport] = useState<WizardWorkflowReportPayload | null>(null);
  const [wizardReportLoading, setWizardReportLoading] = useState(false);
  const [wizardReportError, setWizardReportError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (defaultWizardTab) {
      onDefaultWizardTabConsumed?.();
    }
    // Intentionally once per modal mount (parent resets defaultWizardTab after this).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWizardReport = useCallback(async () => {
    if (!isDbConfigured()) {
      setWizardReportError('Database not configured.');
      setWizardReport(null);
      return;
    }
    setWizardReportLoading(true);
    setWizardReportError(null);
    try {
      const row = await getWizardWorkflowReport(projectId);
      setWizardReport(row);
    } catch (e: unknown) {
      setWizardReportError(e instanceof Error ? e.message : 'Failed to load wizard report');
      setWizardReport(null);
    } finally {
      setWizardReportLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (activeTab !== 'wizard') return;
    let cancelled = false;

    (async () => {
      if (!isDbConfigured()) {
        setWizardReportError('Database not configured.');
        setWizardReport(null);
        setWizardReportLoading(false);
        return;
      }
      setWizardReportLoading(true);
      setWizardReportError(null);
      try {
        const row = await getWizardWorkflowReport(projectId);
        if (cancelled) return;
        setWizardReport(row);
      } catch (e: unknown) {
        if (!cancelled) {
          setWizardReportError(e instanceof Error ? e.message : 'Failed to load wizard report');
          setWizardReport(null);
        }
      } finally {
        if (!cancelled) setWizardReportLoading(false);
      }
    })();

    const interval = window.setInterval(async () => {
      if (cancelled || !isDbConfigured()) return;
      try {
        const row = await getWizardWorkflowReport(projectId);
        if (cancelled) return;
        setWizardReport(row);
        if (row?.finalAnalysis != null) {
          window.clearInterval(interval);
        }
      } catch {
        /* keep last good payload */
      }
    }, 2000);

    const stop = window.setTimeout(() => window.clearInterval(interval), 48_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [activeTab, projectId]);

  const analyzeSnap = async (snapId: string, url: string) => {
    setSnapAI(prev => ({ ...prev, [snapId]: { status: 'analyzing' } }));
    try {
      const result = await analyzeRoofImage(url);
      setSnapAI(prev => ({ ...prev, [snapId]: { status: 'done', result } }));
      if (isPersistableSnapshotId(snapId) && isDbConfigured()) {
        try {
          await updateProjectSnapshotAiAnalysis(snapId, result);
        } catch (e) {
          console.error('[ProjectDetail] persist snapshot AI', e);
        }
      }
      setSnapshots(prev =>
        prev.map(s => (s.id === snapId ? { ...s, ai_analysis: result } : s))
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Analysis failed';
      setSnapAI(prev => ({ ...prev, [snapId]: { status: 'error', error: msg } }));
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getProjectDetails(projectId),
      getProjectSnapshots(projectId),
      getProjectSections(projectId),
    ]).then(([proj, snaps, sects]) => {
      setProject(proj);
      // Fall back to the primary snapshot_url on the project row if no dedicated snapshots exist
      const snapList = snaps as Snapshot[];
      if (snapList.length === 0 && proj.snapshot_url) {
        setSnapshots([{ id: 'primary', label: 'Satellite View', snapshot_url: proj.snapshot_url }]);
        setSnapAI({});
      } else {
        setSnapshots(snapList);
        setSnapAI(snapAiFromRows(snapList));
      }
      setSections(sects as Section[]);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  const totalActual = sections.reduce((s, r) => s + r.actual_area, 0);
  const totalFlat = sections.reduce((s, r) => s + r.flat_area, 0);

  const prevImage = () => setLightboxIdx(i => (i !== null ? (i - 1 + snapshots.length) % snapshots.length : 0));
  const nextImage = () => setLightboxIdx(i => (i !== null ? (i + 1) % snapshots.length : 0));

  const shellClass = layout === 'layer' ? SHELL_LAYER : SHELL_COLUMN;

  return (
    <div className={shellClass}>
        {/* Header */}
        <div className="flex flex-shrink-0 items-start justify-between border-b border-slate-200 bg-slate-50 px-4 py-4 sm:px-8 sm:py-5">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2 text-blue-600 text-xs font-semibold uppercase tracking-wider mb-1">
              <MapPin size={12} />
              Project Detail
            </div>
            {loading ? (
              <div className="h-6 w-64 bg-slate-200 rounded animate-pulse" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900 leading-snug break-words">
                    {(project?.display_name?.trim() || project?.address) ?? '—'}
                  </h2>
                  {project && projectTagLabel(project.project_tag) && (
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${projectTagTone(project.project_tag)}`}
                    >
                      {projectTagLabel(project.project_tag)}
                    </span>
                  )}
                </div>
                {analysisEntryLabel(project?.analysis_entry) && (
                  <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Project folder · {analysisEntryLabel(project?.analysis_entry)}
                  </p>
                )}
                {project?.address && (
                  <p className="text-xs text-slate-500 mt-1.5 leading-snug" title={project.address}>
                    {project.address}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-start gap-1 sm:gap-2">
            {!loading && project && (
              <ProjectTagMenu
                projectId={project.id}
                currentTag={project.project_tag}
                onTagUpdated={tag => setProject(prev => (prev ? { ...prev, project_tag: tag } : null))}
                onProjectDeleted={
                  onProjectDeleted
                    ? deletedId => {
                        onProjectDeleted(deletedId);
                        onClose();
                      }
                    : undefined
                }
              />
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 border-b border-slate-200 bg-white px-4 sm:px-8">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'overview'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Layers size={16} aria-hidden />
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('wizard')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'wizard'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FileText size={16} aria-hidden />
            Wizard report
          </button>
        </div>

        <div className="overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch] bg-slate-50">
          <div className="mx-auto w-full max-w-6xl px-4 pb-4 sm:px-8 bg-slate-50">
          {loading ? (
            <div className="space-y-4 py-6">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-40 bg-slate-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : activeTab === 'wizard' ? (
            <div className="py-4 sm:py-6">
              {wizardReportLoading && !wizardReport && (
                <div className="flex flex-col items-center py-12 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-500" aria-hidden />
                  <p className="text-sm text-slate-600">Loading wizard report…</p>
                </div>
              )}
              {wizardReport && wizardReport.finalAnalysis == null && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Final AI fusion is not in the saved report yet. Data will refresh automatically while the wizard finishes saving.
                </div>
              )}
              {wizardReportError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 mb-4">
                  {wizardReportError}
                  <button
                    type="button"
                    onClick={() => void loadWizardReport()}
                    className="block mt-2 text-xs font-semibold text-red-700 underline"
                  >
                    Retry
                  </button>
                </div>
              )}
              {wizardReport && (
                <WizardWorkflowReportView
                  report={wizardReport}
                  savedSectionCount={project?.section_count ?? 0}
                  onOpenQuoteBuilder={
                    onOpenQuoteFromProject ? () => void onOpenQuoteFromProject(projectId) : undefined
                  }
                />
              )}
              {!wizardReportLoading && !wizardReport && !wizardReportError && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500 text-sm">
                  No Smart Roof Mapping wizard data saved for this project yet.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden border border-slate-200 bg-white shadow-sm mt-4 mb-4">
              {/* Stats row */}
              <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200">
                {[
                  { icon: <Layers size={14} />, label: 'Sections', value: project?.section_count ?? 0 },
                  { icon: <Ruler size={14} />, label: 'Total Roof Area', value: `${totalActual.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft` },
                  { icon: <Calendar size={14} />, label: 'Created', value: new Date(project?.created_at ?? '').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                ].map(stat => (
                  <div key={stat.label} className="bg-white px-4 py-3">
                    <div className="flex items-center gap-1.5 text-slate-400 text-xs mb-1">
                      {stat.icon}
                      {stat.label}
                    </div>
                    <div className="text-slate-900 font-bold text-base">{stat.value}</div>
                  </div>
                ))}
              </div>

              {/* Snapshots gallery */}
              <div className="py-4 px-6">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Image size={13} />
                  Saved Images ({snapshots.length})
                </h3>

                {snapshots.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400 text-sm">
                    No snapshots saved for this project.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                    {snapshots.map((snap, idx) => {
                      const ai = snapAI[snap.id];
                      return (
                        <div key={snap.id} className="flex flex-col gap-2">
                          {/* Thumbnail */}
                          <button
                            onClick={() => setLightboxIdx(idx)}
                            className="group relative rounded-xl overflow-hidden border border-slate-200 hover:border-blue-400 hover:shadow-lg transition-all aspect-video bg-slate-100"
                          >
                            <img src={snap.snapshot_url} alt={snap.label} className="w-full h-full object-cover" loading="lazy" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center">
                              <ZoomIn size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
                              <span className="text-white text-xs font-medium">{snap.label}</span>
                            </div>
                            {/* Condition badge if analyzed */}
                            {ai?.status === 'done' && ai.result && (
                              <div
                                className="absolute top-2 right-2 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                                style={{ backgroundColor: CONDITION_COLORS[ai.result.condition] }}
                              >
                                {ai.result.condition}
                              </div>
                            )}
                          </button>

                          {/* AI section */}
                          {!ai && (
                            <button
                              onClick={() => analyzeSnap(snap.id, snap.snapshot_url)}
                              disabled={!hasGeminiKey}
                              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1.5 rounded-lg transition-colors"
                              title={!hasGeminiKey ? 'Add your Gemini key in Settings to enable AI' : ''}
                            >
                              <Brain size={11} />
                              Analyze with AI
                            </button>
                          )}

                          {ai?.status === 'analyzing' && (
                            <div className="flex items-center justify-center gap-1.5 text-xs text-purple-500 py-1">
                              <Loader2 size={11} className="animate-spin" />
                              Analyzing…
                            </div>
                          )}

                          {ai?.status === 'error' && (
                            <div className="flex items-center gap-1.5 text-xs text-red-500 px-1">
                              <AlertTriangle size={11} />
                              {ai.error === 'GOOGLE_AI_KEY_MISSING' ? 'AI key missing' : 'Failed'}
                            </div>
                          )}

                          {ai?.status === 'done' && ai.result && (
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs space-y-1.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`font-bold px-1.5 py-0.5 rounded-full ${CONDITION_BG[ai.result.condition]}`}>
                                  {ai.result.condition}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded-full ${URGENCY_BG[ai.result.urgency]}`}>
                                  {ai.result.urgency}
                                </span>
                                <span className="ml-auto text-slate-400">{ai.result.condition_score}/10</span>
                              </div>
                              <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${ai.result.condition_score * 10}%`, backgroundColor: CONDITION_COLORS[ai.result.condition] }} />
                              </div>
                              <p className="text-slate-500 leading-relaxed">{ai.result.estimated_remaining_life} remaining</p>
                              {ai.result.issues.length > 0 && (
                                <ul className="text-slate-500 space-y-0.5">
                                  {ai.result.issues.slice(0, 3).map((issue, i) => (
                                    <li key={i} className="flex gap-1"><span className="text-amber-400">•</span>{issue}</li>
                                  ))}
                                </ul>
                              )}
                              <p className="text-slate-600 italic">"{ai.result.recommendation}"</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Sections table */}
              <div className="px-6 pb-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Layers size={13} />
                  Roof Sections ({sections.length})
                </h3>

                {sections.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-400 text-sm">
                    No sections recorded.
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Section</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Pitch</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Flat Area</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actual Area</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {sections.map(s => (
                          <tr key={s.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                                <span className="font-medium text-slate-800">{s.name}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-slate-600">{s.pitch}</td>
                            <td className="px-4 py-3 text-right text-slate-600">
                              {s.flat_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                              {s.actual_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <td colSpan={2} className="px-4 py-2.5 text-xs font-bold text-slate-600 uppercase">Total</td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-700">
                            {totalFlat.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                            {totalActual.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>

      {/* Lightbox — covers the same region as the project shell */}
      {lightboxIdx !== null && snapshots[lightboxIdx] && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/90"
          onClick={() => setLightboxIdx(null)}
        >
          <button
            onClick={e => { e.stopPropagation(); prevImage(); }}
            className="absolute left-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <ChevronLeft size={24} />
          </button>

          <div className="max-w-5xl w-full px-16" onClick={e => e.stopPropagation()}>
            <img
              src={snapshots[lightboxIdx].snapshot_url}
              alt={snapshots[lightboxIdx].label}
              className="w-full rounded-xl shadow-2xl"
            />
            <div className="mt-3 text-center">
              <span className="text-white font-semibold text-lg">{snapshots[lightboxIdx].label}</span>
              <span className="text-slate-400 text-sm ml-3">{lightboxIdx + 1} / {snapshots.length}</span>
            </div>
          </div>

          <button
            onClick={e => { e.stopPropagation(); nextImage(); }}
            className="absolute right-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <ChevronRight size={24} />
          </button>

          <button
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
