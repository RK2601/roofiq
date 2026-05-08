import { useEffect, useState } from 'react';
import { X, MapPin, Layers, Ruler, Calendar, ZoomIn, ChevronLeft, ChevronRight, Image, Brain, Loader2, AlertTriangle } from 'lucide-react';
import { getProjectDetails, getProjectSnapshots, getProjectSections } from '../utils/db';
import { analyzeRoofImage, RoofAnalysis, CONDITION_BG, URGENCY_BG, CONDITION_COLORS } from '../utils/ai';

interface Props {
  projectId: string;
  onClose: () => void;
}

interface ProjectDetail {
  id: string;
  address: string;
  lat: number;
  lng: number;
  snapshot_url: string | null;
  created_at: string;
  section_count: number;
  total_area: number;
}

interface Snapshot {
  id: string;
  label: string;
  snapshot_url: string;
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

export default function ProjectDetailModal({ projectId, onClose }: Props) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [snapAI, setSnapAI] = useState<Record<string, SnapAI>>({});
  const hasGeminiKey = !!(import.meta.env.VITE_GOOGLE_AI_KEY || localStorage.getItem('roofiq_gemini_key'));

  const analyzeSnap = async (snapId: string, url: string) => {
    setSnapAI(prev => ({ ...prev, [snapId]: { status: 'analyzing' } }));
    try {
      const result = await analyzeRoofImage(url);
      setSnapAI(prev => ({ ...prev, [snapId]: { status: 'done', result } }));
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
      } else {
        setSnapshots(snapList);
      }
      setSections(sects as Section[]);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  const totalActual = sections.reduce((s, r) => s + r.actual_area, 0);
  const totalFlat = sections.reduce((s, r) => s + r.flat_area, 0);

  const prevImage = () => setLightboxIdx(i => (i !== null ? (i - 1 + snapshots.length) % snapshots.length : 0));
  const nextImage = () => setLightboxIdx(i => (i !== null ? (i + 1) % snapshots.length : 0));

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-white z-50 shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2 text-blue-600 text-xs font-semibold uppercase tracking-wider mb-1">
              <MapPin size={12} />
              Project Detail
            </div>
            {loading ? (
              <div className="h-6 w-64 bg-slate-200 rounded animate-pulse" />
            ) : (
              <h2 className="text-lg font-bold text-slate-900 leading-snug">{project?.address}</h2>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-40 bg-slate-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-3 gap-px bg-slate-200 border-b border-slate-200">
                {[
                  { icon: <Layers size={14} />, label: 'Sections', value: project?.section_count ?? 0 },
                  { icon: <Ruler size={14} />, label: 'Total Roof Area', value: `${totalActual.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft` },
                  { icon: <Calendar size={14} />, label: 'Created', value: new Date(project?.created_at ?? '').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                ].map(stat => (
                  <div key={stat.label} className="bg-white px-6 py-4">
                    <div className="flex items-center gap-1.5 text-slate-400 text-xs mb-1">
                      {stat.icon}
                      {stat.label}
                    </div>
                    <div className="text-slate-900 font-bold text-base">{stat.value}</div>
                  </div>
                ))}
              </div>

              {/* Snapshots gallery */}
              <div className="p-6">
                <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Image size={14} />
                  Saved Images ({snapshots.length})
                </h3>

                {snapshots.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400 text-sm">
                    No snapshots saved for this project.
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-4">
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
              <div className="px-6 pb-6">
                <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Layers size={14} />
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
            </>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxIdx !== null && snapshots[lightboxIdx] && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center" style={{ zIndex: 60 }}
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
    </>
  );
}
