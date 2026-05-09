import { useEffect, useMemo, useState } from 'react';
import { X, Ruler, Info, RotateCcw, Check, Camera, Loader2, Sparkles, Trash2 } from 'lucide-react';
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
import { deriveVisionRoofCuesFromFile, type RoofPhotoCueAnalysis, type VisionCueRaw } from '../utils/roofVision';

interface RoofStructurePanelProps {
  analysis: RoofStructureAnalysis;
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
  { id: 'front_left', label: 'Front Left' },
  { id: 'front_center', label: 'Front Center' },
  { id: 'front_right', label: 'Front Right' },
  { id: 'rear_left', label: 'Rear Left' },
  { id: 'rear_center', label: 'Rear Center' },
  { id: 'rear_right', label: 'Rear Right' },
] as const;

type MultiAngleSlot = (typeof MULTI_ANGLE_SLOTS)[number]['id'];

interface MultiAngleCapture {
  file: File;
  previewUrl: string;
}

interface MultiAngleResult {
  status: 'idle' | 'analyzing' | 'done' | 'error';
  result?: RoofPhotoCueAnalysis;
  error?: string;
}

const EDGE_STYLES: Record<
  FacetEdge['kind'],
  { color: string; width: number; dash?: string; label: string }
> = {
  ridge: { color: '#ef4444', width: 3, label: 'Ridge' },
  hip: { color: '#f97316', width: 2.5, label: 'Hip' },
  valley: { color: '#3b82f6', width: 2.5, label: 'Valley' },
  eave: { color: '#94a3b8', width: 1.8, dash: '5 3', label: 'Eave' },
  rake: { color: '#64748b', width: 1.8, dash: '2 3', label: 'Rake' },
  step: { color: '#cbd5e1', width: 1.5, dash: '4 3', label: 'Step/Transition' },
};

function edgeSegment(
  facet: RoofStructureFacet,
  side: FacetSide,
  edgeLengthFt: number,
  pxPerFt: number
): { x1: number; y1: number; x2: number; y2: number } {
  const { x, y, w, h } = facet.placement;
  if (side === 'top' || side === 'bottom') {
    const lineLength = Math.min(w, Math.max(4, edgeLengthFt * pxPerFt));
    const cx = x + w / 2;
    const yLine = side === 'top' ? y : y + h;
    return {
      x1: cx - lineLength / 2,
      y1: yLine,
      x2: cx + lineLength / 2,
      y2: yLine,
    };
  }
  const lineLength = Math.min(h, Math.max(4, edgeLengthFt * pxPerFt));
  const cy = y + h / 2;
  const xLine = side === 'left' ? x : x + w;
  return {
    x1: xLine,
    y1: cy - lineLength / 2,
    x2: xLine,
    y2: cy + lineLength / 2,
  };
}

const EDITABLE_EDGE_KINDS: EdgeKind[] = ['ridge', 'hip', 'valley', 'eave', 'rake', 'step'];

function renderEdges(
  facets: RoofStructureFacet[],
  pxPerFt: number,
  onEdgeClick?: (facetIndex: number, edgeIndex: number) => void
) {
  const lines: JSX.Element[] = [];
  facets.forEach(facet => {
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
          strokeWidth={lowConfidence ? Math.max(style.width, 2.2) : style.width}
          strokeDasharray={lowConfidence ? '5 4' : style.dash}
          strokeLinecap="round"
          onClick={() => onEdgeClick?.(facet.index, idx)}
          className={onEdgeClick ? 'cursor-pointer' : undefined}
        />
      );
    });
  });
  return lines;
}

export default function RoofStructurePanel({ analysis, onClose, onApply }: RoofStructurePanelProps) {
  const [editableFacets, setEditableFacets] = useState<RoofStructureFacet[]>(analysis.facets);
  const [edited, setEdited] = useState(false);
  const [editLog, setEditLog] = useState<EdgeEditLogEntry[]>([]);
  const [reviewed, setReviewed] = useState<boolean>(analysis.review?.reviewed ?? false);
  const [multiCaptures, setMultiCaptures] = useState<Partial<Record<MultiAngleSlot, MultiAngleCapture>>>({});
  const [multiResults, setMultiResults] = useState<Partial<Record<MultiAngleSlot, MultiAngleResult>>>({});

  useEffect(() => {
    setEditableFacets(analysis.facets);
    setEdited(false);
    setEditLog([]);
    setReviewed(analysis.review?.reviewed ?? false);
  }, [analysis]);

  useEffect(() => {
    return () => {
      Object.values(multiCaptures).forEach(capture => {
        if (capture) URL.revokeObjectURL(capture.previewUrl);
      });
    };
  }, [multiCaptures]);

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
      cues += item.result.cues.length;
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

  const handleCaptureSelect = (slot: MultiAngleSlot, file: File | null) => {
    if (!file) return;
    setMultiCaptures(prev => {
      const existing = prev[slot];
      if (existing) URL.revokeObjectURL(existing.previewUrl);
      return {
        ...prev,
        [slot]: {
          file,
          previewUrl: URL.createObjectURL(file),
        },
      };
    });
    setMultiResults(prev => ({
      ...prev,
      [slot]: { status: 'idle' },
    }));
  };

  const analyzeSlot = async (slot: MultiAngleSlot) => {
    const capture = multiCaptures[slot];
    if (!capture) return;
    setMultiResults(prev => ({ ...prev, [slot]: { status: 'analyzing' } }));
    const slotLabel = MULTI_ANGLE_SLOTS.find(item => item.id === slot)?.label ?? slot;
    try {
      const result = await deriveVisionRoofCuesFromFile(capture.file, slotLabel);
      if (!result) {
        setMultiResults(prev => ({
          ...prev,
          [slot]: { status: 'error', error: 'No cues detected for this angle.' },
        }));
        return;
      }
      setMultiResults(prev => ({
        ...prev,
        [slot]: { status: 'done', result },
      }));
    } catch (err) {
      setMultiResults(prev => ({
        ...prev,
        [slot]: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const analyzeAllSlots = async () => {
    for (const slot of MULTI_ANGLE_SLOTS) {
      if (!multiCaptures[slot.id]) continue;
      // Sequential to avoid aggressive parallel model calls.
      // eslint-disable-next-line no-await-in-loop
      await analyzeSlot(slot.id);
    }
  };

  const mapVisionCueToApproxLocal = (cue: VisionCueRaw): AiRoofCue | null => {
    if (editableFacets.length === 0) return null;
    const minX = Math.min(...editableFacets.map(f => f.bboxMeters.sw.x));
    const maxX = Math.max(...editableFacets.map(f => f.bboxMeters.ne.x));
    const minY = Math.min(...editableFacets.map(f => f.bboxMeters.sw.y));
    const maxY = Math.max(...editableFacets.map(f => f.bboxMeters.ne.y));
    const rangeX = Math.max(0.1, maxX - minX);
    const rangeY = Math.max(0.1, maxY - minY);
    const toLocal = (x: number, y: number) => ({
      x: minX + Math.min(1, Math.max(0, x)) * rangeX,
      y: maxY - Math.min(1, Math.max(0, y)) * rangeY,
    });
    const p1 = toLocal(cue.x1, cue.y1);
    const p2 = toLocal(cue.x2, cue.y2);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 0.8) return null;
    return {
      type: cue.type,
      p1,
      p2,
      confidence: Math.min(1, Math.max(0.2, cue.confidence)),
    };
  };

  const applyMultiAngleInsights = () => {
    const cues = Object.values(multiResults)
      .flatMap(item => (item?.status === 'done' && item.result && item.result.qualityScore >= 0.45 ? item.result.cues : []))
      .map(mapVisionCueToApproxLocal)
      .filter((cue): cue is AiRoofCue => !!cue);
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
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <Ruler size={15} className="text-blue-600" />
          <h2 className="text-sm sm:text-base font-semibold text-slate-900">Roof Structure Analysis</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
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

          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles size={14} className="text-indigo-600" />
              <h3 className="text-sm font-semibold text-indigo-900">Multi-Angle Analysis (Experimental)</h3>
              <button
                type="button"
                onClick={analyzeAllSlots}
                disabled={Object.keys(multiCaptures).length === 0}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles size={12} />
                Analyze all
              </button>
            </div>

            <p className="text-[11px] text-indigo-700">
              Separate from roof topology calculations. Upload 5-6 angles (street/front/rear corners) to extract additional AI line cues.
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
                      <img
                        src={capture.previewUrl}
                        alt={`${slot.label} capture`}
                        className="w-full h-24 object-cover rounded border border-slate-200"
                      />
                    ) : (
                      <div className="h-24 rounded border border-dashed border-indigo-200 bg-indigo-50/50 flex items-center justify-center text-[11px] text-indigo-500">
                        No photo
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 cursor-pointer">
                        <Camera size={11} />
                        Upload
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          onChange={e => handleCaptureSelect(slot.id, e.target.files?.[0] ?? null)}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => analyzeSlot(slot.id)}
                        disabled={!capture || result?.status === 'analyzing'}
                        className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Sparkles size={11} />
                        Analyze
                      </button>
                      {capture && (
                        <button
                          type="button"
                          onClick={() => {
                            setMultiCaptures(prev => {
                              const current = prev[slot.id];
                              if (current) URL.revokeObjectURL(current.previewUrl);
                              const next = { ...prev };
                              delete next[slot.id];
                              return next;
                            });
                            setMultiResults(prev => {
                              const next = { ...prev };
                              delete next[slot.id];
                              return next;
                            });
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 hover:bg-red-100"
                        >
                          <Trash2 size={11} />
                          Clear
                        </button>
                      )}
                    </div>

                    {result?.status === 'done' && result.result && (
                      <p className="text-[11px] text-emerald-700">
                        {result.result.cues.length} cues · quality {Math.round(result.result.qualityScore * 100)}%
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
                <span className="text-[11px] text-indigo-600">Need at least 4 quality-analyzed angle photos.</span>
              )}
            </div>
          </div>

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

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
            {metricCards.map(item => (
              <div key={item.label} className="bg-white rounded-lg p-2 border border-slate-100 text-center">
                <div className="text-[10px] text-slate-400 leading-none mb-1">{item.label}</div>
                <div className="text-xs font-bold text-slate-900">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 sm:p-3">
            <svg
              viewBox={analysis.svg.viewBox}
              width={analysis.svg.width}
              height={analysis.svg.height}
              className="w-full h-auto rounded-lg bg-white border border-slate-200"
              xmlns="http://www.w3.org/2000/svg"
            >
              {renderEdges(editableFacets, analysis.svg.pxPerFt, handleEdgeCycle)}

              {editableFacets.map(facet => (
                <g key={facet.index} transform={`translate(${facet.placement.x}, ${facet.placement.y})`}>
                  <rect
                    width={facet.placement.w}
                    height={facet.placement.h}
                    rx={3}
                    fill={`${SECTION_COLORS[facet.index % SECTION_COLORS.length]}22`}
                    stroke={SECTION_COLORS[facet.index % SECTION_COLORS.length]}
                    strokeWidth={1.6}
                  />
                  <text
                    x={facet.placement.w / 2}
                    y={facet.placement.h / 2 - 6}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={600}
                    fill="#0f172a"
                    fontFamily="Inter, system-ui, sans-serif"
                  >
                    {facet.pitchLabel} · {facet.facingLabel}
                  </text>
                  <text
                    x={facet.placement.w / 2}
                    y={facet.placement.h / 2 + 8}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#475569"
                    fontFamily="Inter, system-ui, sans-serif"
                  >
                    {Math.round(facet.actualAreaSqFt).toLocaleString()} sq ft
                  </text>
                </g>
              ))}
            </svg>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-600">
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
              Geometry and edge classes are estimated from Solar segment bounding boxes; use this as a
              measurement guide, not a sealed engineering drawing. Amber dashed edges indicate low-confidence linework.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
