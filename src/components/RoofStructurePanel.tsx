import { useEffect, useMemo, useState } from 'react';
import { X, Ruler, Info, RotateCcw, Check, Loader2, Sparkles, ChevronDown } from 'lucide-react';
import { SECTION_COLORS, formatArea } from '../utils/roofCalculations';
import { formatFt } from '../utils/measurements';
import type {
  AiRoofCue,
  EdgeKind,
  FacetEdge,
  FacetSide,
  RoofStructureAnalysis,
  RoofStructureFacet,
} from '../utils/roofStructure';
import { applyAiCuesToAnalysis, recomputeMeasurementsFromFacets } from '../utils/roofStructure';
import type { SolarBuildingInsights } from '../utils/solar';
import {
  buildAutoMapViewCaptures,
  deriveVisionRoofCuesFromStaticMap,
  DRAWN_OVERLAY_VISION_HINT,
  type AutoMapViewCapture,
  type RoofCaptureRing,
} from '../utils/roofVision';

interface RoofStructurePanelProps {
  analysis: RoofStructureAnalysis;
  mapCenter: { lat: number; lng: number };
  mapsApiKey: string;
  solarInsights: SolarBuildingInsights | null;
  /** When set, static-map captures center on this outline and include colored overlays (quick map sections). */
  roofCaptureRings?: RoofCaptureRing[] | null;
  onClose: () => void;
  onApply?: (next: RoofStructureAnalysis) => void;
}

interface EdgeEditLogEntry {
  id: string;
  facetIndex: number;
  edgeIndex: number;
  from: EdgeKind;
  to: EdgeKind;
  adjacentFacetIndex: number | null;
  timestampIso: string;
}

const MULTI_ANGLE_SLOTS = [
  { id: 'center', label: 'Center Zoom 20' },
  { id: 'nw', label: 'NW Offset' },
  { id: 'ne', label: 'NE Offset' },
  { id: 'sw', label: 'SW Offset' },
  { id: 'se', label: 'SE Offset' },
  { id: 'wide', label: 'Wider Zoom 19' },
] as const;

type MultiAngleSlot = (typeof MULTI_ANGLE_SLOTS)[number]['id'];

interface MultiAngleResult {
  status: 'idle' | 'analyzing' | 'done' | 'error';
  result?: {
    qualityScore: number;
    aiCues: AiRoofCue[];
    byType: Record<'ridge' | 'hip' | 'valley' | 'eave' | 'rake', number>;
  };
  error?: string;
}

const EDGE_STYLES: Record<
  FacetEdge['kind'],
  { color: string; width: number; dash?: string; label: string }
> = {
  ridge: { color: '#ef4444', width: 3.6, label: 'Ridge' },
  hip: { color: '#f97316', width: 3.2, label: 'Hip' },
  valley: { color: '#3b82f6', width: 3.2, label: 'Valley' },
  eave: { color: '#94a3b8', width: 2, dash: '5 3', label: 'Eave' },
  rake: { color: '#64748b', width: 2, dash: '2 3', label: 'Rake' },
  step: { color: '#cbd5e1', width: 1.6, dash: '4 3', label: 'Step/Transition' },
};

function edgeSegment(
  facet: RoofStructureFacet,
  side: FacetSide,
  _edgeLengthFt: number,
  _pxPerFt: number
): { x1: number; y1: number; x2: number; y2: number } {
  const { x, y, w, h } = facet.placement;
  if (side === 'top' || side === 'bottom') {
    const yLine = side === 'top' ? y : y + h;
    return { x1: x, y1: yLine, x2: x + w, y2: yLine };
  }
  const xLine = side === 'left' ? x : x + w;
  return { x1: xLine, y1: y, x2: xLine, y2: y + h };
}

const EDITABLE_EDGE_KINDS: EdgeKind[] = ['ridge', 'hip', 'valley', 'eave', 'rake', 'step'];

function renderEdges(
  facets: RoofStructureFacet[],
  pxPerFt: number,
  onEdgeClick?: (facetIndex: number, edgeIndex: number) => void
) {
  const lines: JSX.Element[] = [];
  facets.forEach(facet => {
    if (facet.placement.outlinePx && facet.placement.outlinePx.length >= 3) return;
    facet.edges.forEach((edge, idx) => {
      if (edge.adjacentFacetIndex !== null && edge.adjacentFacetIndex < facet.index) return;
      const seg = edgeSegment(facet, edge.side, edge.lengthFt, pxPerFt);
      const style = EDGE_STYLES[edge.kind];
      const lowConfidence = edge.confidence < 0.5;
      lines.push(
        <line
          key={`${facet.index}-${idx}-${edge.kind}`}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          stroke={lowConfidence ? '#f59e0b' : style.color}
          strokeWidth={lowConfidence ? Math.max(style.width, 2.6) : style.width}
          strokeDasharray={lowConfidence ? '5 4' : style.dash}
          strokeLinecap="butt"
          strokeLinejoin="miter"
          style={{ pointerEvents: 'stroke' }}
          onClick={() => onEdgeClick?.(facet.index, idx)}
          className={onEdgeClick ? 'cursor-pointer' : undefined}
        />
      );
    });
  });
  return lines;
}

export default function RoofStructurePanel({
  analysis,
  mapCenter,
  mapsApiKey,
  solarInsights,
  roofCaptureRings = null,
  onClose,
  onApply,
}: RoofStructurePanelProps) {
  const [editableFacets, setEditableFacets] = useState<RoofStructureFacet[]>(analysis.facets);
  const [edited, setEdited] = useState(false);
  const [editLog, setEditLog] = useState<EdgeEditLogEntry[]>([]);
  const [reviewed, setReviewed] = useState<boolean>(analysis.review?.reviewed ?? false);
  const [multiCaptures, setMultiCaptures] = useState<Partial<Record<MultiAngleSlot, AutoMapViewCapture>>>({});
  const [multiResults, setMultiResults] = useState<Partial<Record<MultiAngleSlot, MultiAngleResult>>>({});

  useEffect(() => {
    setEditableFacets(analysis.facets);
    setEdited(false);
    setEditLog([]);
    setReviewed(analysis.review?.reviewed ?? false);
  }, [analysis]);

  useEffect(() => {
    const captures = buildAutoMapViewCaptures(
      mapCenter,
      mapsApiKey,
      roofCaptureRings?.length ? roofCaptureRings : null
    );
    const bySlot: Partial<Record<MultiAngleSlot, AutoMapViewCapture>> = {};
    MULTI_ANGLE_SLOTS.forEach((slot, idx) => {
      bySlot[slot.id] = captures[idx];
    });
    setMultiCaptures(bySlot);
    setMultiResults({});
  }, [mapCenter, mapsApiKey, roofCaptureRings]);

  const editableMeasurements = useMemo(
    () => recomputeMeasurementsFromFacets(editableFacets),
    [editableFacets]
  );
  const reviewDirty = reviewed !== (analysis.review?.reviewed ?? false);
  const multiSummary = useMemo(() => {
    const done = Object.values(multiResults).filter(item => item?.status === 'done' && item.result);
    const cuesByType = { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0 };
    let totalQuality = 0;
    let cues = 0;
    done.forEach(item => {
      if (!item?.result) return;
      totalQuality += item.result.qualityScore;
      cues += item.result.aiCues.length;
      cuesByType.ridge += item.result.byType.ridge;
      cuesByType.hip += item.result.byType.hip;
      cuesByType.valley += item.result.byType.valley;
      cuesByType.eave += item.result.byType.eave;
      cuesByType.rake += item.result.byType.rake;
    });
    return {
      analyzed: done.length,
      cues,
      avgQuality: done.length > 0 ? totalQuality / done.length : 0,
      cuesByType,
    };
  }, [multiResults]);
  const captureCount = Object.keys(multiCaptures).length;
  const readySlots = Object.values(multiResults).filter(item => item?.status === 'done' && item.result && item.result.qualityScore >= 0.45).length;
  const multiCoverageOk = readySlots >= 4;

  const m = editableMeasurements;
  const isUserTracedStructure = useMemo(
    () => analysis.notes.some(n => n.toLowerCase().includes('user-drawn')),
    [analysis.notes]
  );
  const confidencePercent = Math.round((analysis.confidence.overall || 0) * 100);
  const metricCards = [
    { label: 'Roof Area', value: formatArea(m.totalRoofAreaSqFt) },
    { label: 'Pitched Area', value: formatArea(m.totalPitchedAreaSqFt) },
    { label: 'Flat Area', value: formatArea(m.totalFlatAreaSqFt) },
    { label: 'Roof Facets', value: String(m.facetCount) },
    { label: 'Predominant Pitch', value: m.predominantPitch },
    { label: 'Squares (est.)', value: `${m.totalSquares} sq` },
    { label: 'Total Eaves', value: formatFt(m.totalEaveFt) },
    { label: 'Total Rakes', value: formatFt(m.totalRakeFt) },
    { label: 'Eaves + Rakes', value: formatFt(m.eavesAndRakesFt) },
    { label: 'Total Ridges', value: formatFt(m.totalRidgeFt) },
    { label: 'Total Hips', value: formatFt(m.totalHipFt) },
    { label: 'Hips + Ridges', value: formatFt(m.hipsAndRidgesFt) },
    { label: 'Total Valleys', value: formatFt(m.totalValleyFt) },
    { label: 'Ground Area', value: formatArea(m.totalGroundAreaSqFt) },
  ];

  const handleEdgeCycle = (facetIndex: number, edgeIndex: number) => {
    setEditableFacets(prev => {
      const facets = prev.map(facet => ({
        ...facet,
        edges: facet.edges.map(edge => ({ ...edge })),
      }));
      const facet = facets.find(item => item.index === facetIndex);
      if (!facet) return prev;
      const edge = facet.edges[edgeIndex];
      if (!edge) return prev;
      const fromKind = edge.kind;
      const currentIdx = EDITABLE_EDGE_KINDS.indexOf(fromKind);
      const toKind = EDITABLE_EDGE_KINDS[(currentIdx + 1) % EDITABLE_EDGE_KINDS.length];
      edge.kind = toKind;

      if (edge.adjacentFacetIndex !== null) {
        const adjacent = facets.find(item => item.index === edge.adjacentFacetIndex);
        const reciprocal = adjacent?.edges.find(candidate => candidate.adjacentFacetIndex === facetIndex);
        if (reciprocal) reciprocal.kind = toKind;
      }
      setEditLog(prevLog => [
        ...prevLog,
        {
          id: `${Date.now()}-${facetIndex}-${edgeIndex}`,
          facetIndex,
          edgeIndex,
          from: fromKind,
          to: toKind,
          adjacentFacetIndex: edge.adjacentFacetIndex,
          timestampIso: new Date().toISOString(),
        },
      ]);
      return facets;
    });
    setEdited(true);
  };

  const handleUndoLastEdit = () => {
    const last = editLog[editLog.length - 1];
    if (!last) return;

    setEditableFacets(prev => {
      const facets = prev.map(facet => ({
        ...facet,
        edges: facet.edges.map(edge => ({ ...edge })),
      }));
      const facet = facets.find(item => item.index === last.facetIndex);
      const edge = facet?.edges[last.edgeIndex];
      if (!facet || !edge) return prev;
      edge.kind = last.from;

      if (last.adjacentFacetIndex !== null) {
        const adjacent = facets.find(item => item.index === last.adjacentFacetIndex);
        const reciprocal = adjacent?.edges.find(candidate => candidate.adjacentFacetIndex === last.facetIndex);
        if (reciprocal) reciprocal.kind = last.from;
      }
      return facets;
    });
    setEditLog(prev => {
      const next = prev.slice(0, -1);
      setEdited(next.length > 0);
      return next;
    });
  };

  const analyzeSlot = async (slot: MultiAngleSlot) => {
    const capture = multiCaptures[slot];
    if (!capture || !solarInsights) return;
    setMultiResults(prev => ({ ...prev, [slot]: { status: 'analyzing' } }));
    try {
      const result = await deriveVisionRoofCuesFromStaticMap(
        capture.url,
        solarInsights,
        roofCaptureRings?.length ? DRAWN_OVERLAY_VISION_HINT : undefined,
        capture.imageBounds ?? null,
        roofCaptureRings?.length ? roofCaptureRings : null
      );
      if (!result || result.length === 0) {
        setMultiResults(prev => ({
          ...prev,
          [slot]: { status: 'error', error: 'No cues detected for this angle.' },
        }));
        return;
      }
      const byType = { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0 };
      result.forEach(cue => {
        if (cue.type in byType) {
          byType[cue.type as keyof typeof byType] += 1;
        }
      });
      setMultiResults(prev => ({
        ...prev,
        [slot]: {
          status: 'done',
          result: {
            qualityScore: result.reduce((sum, cue) => sum + cue.confidence, 0) / Math.max(result.length, 1),
            aiCues: result,
            byType,
          },
        },
      }));
    } catch (err) {
      setMultiResults(prev => ({
        ...prev,
        [slot]: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const analyzeAllSlots = async () => {
    if (!solarInsights) return;
    for (const slot of MULTI_ANGLE_SLOTS) {
      if (!multiCaptures[slot.id]) continue;
      // Sequential to avoid aggressive parallel model calls.
      // eslint-disable-next-line no-await-in-loop
      await analyzeSlot(slot.id);
    }
  };

  const applyMultiAngleInsights = () => {
    const cues = Object.values(multiResults)
      .flatMap(item => (item?.status === 'done' && item.result && item.result.qualityScore >= 0.45 ? item.result.aiCues : []));
    if (cues.length === 0) return;
    const next = applyAiCuesToAnalysis(
      {
        ...analysis,
        facets: editableFacets,
        measurements: editableMeasurements,
      },
      cues
    );
    onApply?.(next);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm p-2 sm:p-4">
      <div className="mx-auto flex h-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Ruler size={15} className="text-blue-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-semibold text-slate-900 leading-tight">
                {isUserTracedStructure
                  ? 'Schematic from your map traces + Solar pitch hints'
                  : 'Schematic from Solar facets (not as-built linework)'}
              </h2>
              <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                {isUserTracedStructure ? (
                  <>
                    Footprint follows <span className="font-medium text-slate-600">your drawn sections</span>; pitch and
                    facing lean on the nearest Solar facet where available. Rollups and the diagram are still{' '}
                    <span className="font-medium text-slate-600">indicative</span>, not survey-grade.
                  </>
                ) : (
                  <>
                    Numeric rollups use the same facet model as the diagram. Rollups are estimates; the drawing is{' '}
                    <span className="font-medium text-slate-600">indicative</span>, not survey-grade geometry.
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 sm:ml-auto inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label="Close roof structure panel"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setEditableFacets(analysis.facets);
                setEdited(false);
                setEditLog([]);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              <RotateCcw size={12} />
              Reset edits
            </button>
            <button
              type="button"
              disabled={editLog.length === 0}
              onClick={handleUndoLastEdit}
              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCcw size={12} />
              Undo last
            </button>
            <button
              type="button"
              onClick={() => setReviewed(prev => !prev)}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                reviewed
                  ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Check size={12} />
              {reviewed ? 'Reviewed' : 'Mark reviewed'}
            </button>
            <button
              type="button"
              disabled={!edited && !reviewDirty}
              onClick={() => {
                if (!edited && !reviewDirty) return;
                const editSummary = editLog.length
                  ? `Manual edge edits applied (${editLog.length} changes).`
                  : 'Manual edge edits applied.';
                const next: RoofStructureAnalysis = {
                  ...analysis,
                  facets: editableFacets,
                  measurements: editableMeasurements,
                  notes: [
                    ...analysis.notes,
                    ...(editLog.length > 0 ? [editSummary] : []),
                  ],
                  review: {
                    reviewed,
                    reviewedAtIso: reviewed ? new Date().toISOString() : undefined,
                    editsCount: (analysis.review?.editsCount ?? 0) + editLog.length,
                  },
                };
                onApply?.(next);
                setEdited(false);
                setEditLog([]);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={12} />
              Apply edits
            </button>
            {edited && <span className="text-[11px] text-amber-700">Manual edge edits pending</span>}
          </div>

          {editLog.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-semibold text-amber-800">Edit log ({editLog.length})</p>
              <div className="mt-1 max-h-24 overflow-y-auto space-y-0.5">
                {editLog.slice(-8).map(entry => (
                  <p key={entry.id} className="text-[11px] text-amber-700">
                    Facet {entry.facetIndex + 1} edge {entry.edgeIndex + 1}: {entry.from} → {entry.to}
                  </p>
                ))}
              </div>
            </div>
          )}

          <details className="group rounded-xl border border-indigo-200 bg-indigo-50 p-3 open:pb-3">
            <summary className="cursor-pointer list-none text-left marker:content-none [&::-webkit-details-marker]:hidden flex flex-wrap items-center gap-2">
              <Sparkles size={14} className="text-indigo-600 shrink-0" />
              <h3 className="text-sm font-semibold text-indigo-900">Static-map viewpoint cues (advanced)</h3>
              <ChevronDown
                size={14}
                className="ml-auto shrink-0 text-indigo-600 transition-transform group-open:rotate-180 lg:ml-0"
              />
            </summary>
            <div className="mt-2 space-y-3 border-t border-indigo-100/80 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-indigo-800 flex-1 min-w-0 leading-snug">
                Same multi-angle idea as the <span className="font-semibold">Roof Mapping Wizard</span> — optional static-map snapshots here for power users.
              </p>
              <button
                type="button"
                onClick={analyzeAllSlots}
                disabled={Object.keys(multiCaptures).length === 0 || !solarInsights}
                className="shrink-0 inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles size={12} />
                Analyze all views
              </button>
            </div>

            <p className="text-[11px] text-indigo-700">
              {roofCaptureRings?.length ? (
                <>
                  Snapshots are <span className="font-semibold">tight satellite crops</span> centered on your traced roof
                  (max zoom that keeps the outline in frame, with a small pan per tile), plus colored overlays so Gemini
                  sees the same facets — then ridge / hip / valley / eave / rake cues are fused.
                </>
              ) : (
                <>
                  Snapshots use the <span className="font-semibold">property center</span> (center + four offsets + wider
                  zoom). For best accuracy, trace roof sections on the quick map first, then reopen this panel so captures
                  lock to your outline.
                </>
              )}
            </p>
            <div className="rounded-md border border-indigo-100 bg-white px-2 py-1.5 text-[11px] text-indigo-700">
              Captures: {captureCount}/6 · Analyzed (quality {'>=45%'}): {readySlots}/6 ·
              {multiCoverageOk ? ' Coverage OK for fusion' : ' Add at least 4 strong angles to apply'}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {MULTI_ANGLE_SLOTS.map(slot => {
                const capture = multiCaptures[slot.id];
                const result = multiResults[slot.id];
                return (
                  <div key={slot.id} className="rounded-lg border border-indigo-100 bg-white p-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-700">{slot.label}</p>
                      {result?.status === 'analyzing' && <Loader2 size={12} className="animate-spin text-indigo-500" />}
                    </div>

                    {capture ? (
                      <div className="w-full aspect-square max-h-44 rounded border border-slate-200 bg-slate-900/5 overflow-hidden">
                        <img
                          src={capture.url}
                          alt={`${slot.label} capture`}
                          className="h-full w-full object-contain object-center"
                        />
                      </div>
                    ) : (
                      <div className="aspect-square max-h-44 rounded border border-dashed border-indigo-200 bg-indigo-50/50 flex items-center justify-center text-[11px] text-indigo-500">
                        No photo
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => analyzeSlot(slot.id)}
                        disabled={!capture || result?.status === 'analyzing' || !solarInsights}
                        className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Sparkles size={11} />
                        Analyze
                      </button>
                    </div>

                    {result?.status === 'done' && result.result && (
                      <p className="text-[11px] text-emerald-700">
                        {result.result.aiCues.length} cues · quality {Math.round(result.result.qualityScore * 100)}%
                      </p>
                    )}
                    {result?.status === 'error' && (
                      <p className="text-[11px] text-red-600">{result.error ?? 'Analysis failed.'}</p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="rounded-lg border border-indigo-100 bg-white p-2 text-[11px] text-slate-600">
              <p className="font-semibold text-slate-700 mb-1">
                Combined photo cues: {multiSummary.cues} from {multiSummary.analyzed} analyzed angle(s)
                {multiSummary.analyzed > 0 ? ` · avg quality ${Math.round(multiSummary.avgQuality * 100)}%` : ''}
              </p>
              <p>
                Ridge {multiSummary.cuesByType.ridge} · Hip {multiSummary.cuesByType.hip} · Valley {multiSummary.cuesByType.valley}
                {' · '}Eave {multiSummary.cuesByType.eave} · Rake {multiSummary.cuesByType.rake}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!multiCoverageOk}
                onClick={applyMultiAngleInsights}
                className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-100 px-2.5 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles size={12} />
                Apply multi-angle cues to structure confidence
              </button>
              {!multiCoverageOk && (
                <span className="text-[11px] text-indigo-600">Need at least 4 quality-analyzed map views.</span>
              )}
            </div>
            {!solarInsights && (
              <p className="text-[11px] text-amber-700">
                Solar insights are required before viewpoint analysis can run.
              </p>
            )}
            </div>
          </details>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-700">Report confidence</span>
              <span
                className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                  analysis.confidenceBand === 'high'
                    ? 'bg-green-100 text-green-700'
                    : analysis.confidenceBand === 'medium'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-red-100 text-red-700'
                }`}
              >
                {analysis.confidenceBand.toUpperCase()}
              </span>
              <span className="text-xs text-slate-500">{confidencePercent}% overall</span>
            </div>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 text-[10px]">
              {[
                ['Imagery', analysis.confidence.imagery],
                ['Topology', analysis.confidence.topology],
                ['Height', analysis.confidence.height],
                ['AI Align', analysis.confidence.aiAgreement],
                ['Coverage', analysis.confidence.segmentCoverage],
              ].map(([label, score]) => (
                <div key={label} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-center">
                  <div className="text-slate-400">{label}</div>
                  <div className="font-semibold text-slate-700">{Math.round(Number(score) * 100)}%</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Height source: {analysis.dataSources.heightSource ?? (analysis.dataSources.hasDsm ? 'dsm' : 'none')}
              {typeof analysis.dataSources.heightQuality === 'number'
                ? ` · quality ${Math.round(analysis.dataSources.heightQuality * 100)}%`
                : ''}
            </p>
            <p className="text-[11px] text-slate-500">
              AI cues: {analysis.aiCuesUsed?.length ?? 0} lines
            </p>
            {analysis.qualityFlags.length > 0 && (
              <div className="mt-2 space-y-1">
                {analysis.qualityFlags.map(flag => (
                  <p key={flag.code} className="text-[11px] text-slate-600">
                    <span className="font-semibold">{flag.code}:</span> {flag.message}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/90 p-3 space-y-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-800">Numeric rollups (facet model)</h3>
              <p className="text-[10px] text-slate-500 leading-snug mt-0.5">
                Totals below are from the same Solar-derived facet graph as the schematic — useful for rough
                quantities, not as-built takeoff sign-off.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {metricCards.map(item => (
                <div key={item.label} className="bg-white rounded-lg p-2 border border-slate-100 text-center">
                  <div className="text-[10px] text-slate-400 leading-none mb-1">{item.label}</div>
                  <div className="text-xs font-bold text-slate-900">{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 sm:p-3 space-y-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-800">Indicative diagram (not survey-grade)</h3>
              <p className="text-[10px] text-slate-500 leading-snug mt-0.5">
                Map-traced sections use your <span className="font-medium text-slate-600">actual polygon</span> in this
                view. Solar-only facets stay as rectangles. Classified edge lines apply to rectangular facets; trace
                edges on the map for real geometry.
              </p>
            </div>
            <svg
              viewBox={analysis.svg.viewBox}
              width={analysis.svg.width}
              height={analysis.svg.height}
              className="w-full h-auto rounded-lg bg-white border border-slate-200"
              xmlns="http://www.w3.org/2000/svg"
            >
              {editableFacets.map(facet => {
                const col = SECTION_COLORS[facet.index % SECTION_COLORS.length];
                const ox = facet.placement.outlinePx;
                return (
                  <g key={`facet-fill-${facet.index}`} transform={`translate(${facet.placement.x}, ${facet.placement.y})`}>
                    {ox && ox.length >= 3 ? (
                      <polygon
                        points={ox.map(p => `${p.x},${p.y}`).join(' ')}
                        fill={`${col}22`}
                        stroke={col}
                        strokeWidth={1.6}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        style={{ pointerEvents: 'none' }}
                      />
                    ) : (
                      <rect
                        width={facet.placement.w}
                        height={facet.placement.h}
                        rx={3}
                        fill={`${col}22`}
                        stroke={col}
                        strokeWidth={1.6}
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                  </g>
                );
              })}
              <g className="roof-structure-edges" style={{ pointerEvents: 'visibleStroke' }}>
                {renderEdges(editableFacets, analysis.svg.pxPerFt, handleEdgeCycle)}
              </g>
              {editableFacets.map(facet => {
                const ox = facet.placement.outlinePx;
                const lc =
                  ox && ox.length >= 3
                    ? {
                        x: ox.reduce((s, p) => s + p.x, 0) / ox.length,
                        y: ox.reduce((s, p) => s + p.y, 0) / ox.length,
                      }
                    : { x: facet.placement.w / 2, y: facet.placement.h / 2 };
                return (
                  <g key={`facet-label-${facet.index}`} transform={`translate(${facet.placement.x}, ${facet.placement.y})`}>
                    <text
                      x={lc.x}
                      y={lc.y - 6}
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={600}
                      fill="#0f172a"
                      fontFamily="Inter, system-ui, sans-serif"
                      style={{ pointerEvents: 'none' }}
                    >
                      {facet.pitchLabel} · {facet.facingLabel}
                    </text>
                    <text
                      x={lc.x}
                      y={lc.y + 8}
                      textAnchor="middle"
                      fontSize={9}
                      fill="#475569"
                      fontFamily="Inter, system-ui, sans-serif"
                      style={{ pointerEvents: 'none' }}
                    >
                      {Math.round(facet.actualAreaSqFt).toLocaleString()} sq ft
                    </text>
                  </g>
                );
              })}
            </svg>

            <p className="text-[10px] text-slate-500">
              Legend matches edge colors on rectangular facets. Click an edge to cycle its class (when editing). Traced
              polygons omit schematic edge handles here — refine on the map.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-600">
              {(Object.keys(EDGE_STYLES) as FacetEdge['kind'][]).map(kind => (
                <div key={kind} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block w-6 border-t-2"
                    style={{
                      borderColor: EDGE_STYLES[kind].color,
                      borderTopStyle: EDGE_STYLES[kind].dash ? 'dashed' : 'solid',
                    }}
                  />
                  {EDGE_STYLES[kind].label}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>
              Low-confidence edges use amber dashes. Treat the whole view as a planning schematic — confirm
              critical lines in the field or via a future DSM / ML / wizard fusion workflow.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
