import { useEffect, useMemo, useState } from 'react';
import { X, Ruler, Info, RotateCcw, Check } from 'lucide-react';
import { SECTION_COLORS, formatArea } from '../utils/roofCalculations';
import { formatFt } from '../utils/measurements';
import type {
  EdgeKind,
  FacetEdge,
  FacetSide,
  RoofStructureAnalysis,
  RoofStructureFacet,
} from '../utils/roofStructure';
import { recomputeMeasurementsFromFacets } from '../utils/roofStructure';

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

const EDGE_STYLES: Record<
  FacetEdge['kind'],
  { color: string; width: number; dash?: string; label: string }
> = {
  ridge: { color: '#ef4444', width: 3, label: 'Ridge' },
  hip: { color: '#f97316', width: 2.5, label: 'Hip' },
  valley: { color: '#3b82f6', width: 2.5, label: 'Valley' },
  eave: { color: '#94a3b8', width: 1.8, label: 'Eave' },
  rake: { color: '#64748b', width: 1.8, label: 'Rake' },
  step: { color: '#cbd5e1', width: 1.5, label: 'Step/Transition' },
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
          strokeDasharray={undefined}
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

  useEffect(() => {
    setEditableFacets(analysis.facets);
    setEdited(false);
    setEditLog([]);
    setReviewed(analysis.review?.reviewed ?? false);
  }, [analysis]);

  const editableMeasurements = useMemo(
    () => recomputeMeasurementsFromFacets(editableFacets),
    [editableFacets]
  );
  const reviewDirty = reviewed !== (analysis.review?.reviewed ?? false);

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

          <div className="flex items-start gap-2 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>Upload multi-angle photos in the sidebar panel to extract AI roof cues that improve structure accuracy.</span>
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

          {/* Facets table — replaces the old rectangle schematic */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Roof Planes</h3>
              <span className="text-[11px] text-slate-400">{editableFacets.length} facets — click an edge type to reclassify</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left px-3 py-2 font-semibold text-slate-500 w-8">#</th>
                    <th className="text-left px-3 py-2 font-semibold text-slate-500">Pitch</th>
                    <th className="text-left px-3 py-2 font-semibold text-slate-500">Facing</th>
                    <th className="text-right px-3 py-2 font-semibold text-slate-500">Roof Area</th>
                    <th className="text-right px-3 py-2 font-semibold text-slate-500">Ground Area</th>
                    <th className="text-left px-3 py-2 font-semibold text-slate-500">Edges</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {editableFacets.map((facet, i) => {
                    const color = SECTION_COLORS[facet.index % SECTION_COLORS.length];
                    return (
                      <tr key={facet.index} className="hover:bg-slate-50/70">
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: color }}>{i + 1}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-bold text-[11px] px-2 py-0.5 rounded" style={{ backgroundColor: `${color}20`, color }}>
                            {facet.pitchLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700 font-medium">{facet.facingLabel}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{Math.round(facet.actualAreaSqFt).toLocaleString()} sq ft</td>
                        <td className="px-3 py-2.5 text-right text-slate-500">{Math.round(facet.groundAreaSqFt).toLocaleString()} sq ft</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {facet.edges.map((edge, edgeIdx) => {
                              const style = EDGE_STYLES[edge.kind];
                              const lowConf = edge.confidence < 0.5;
                              return (
                                <button
                                  key={edgeIdx}
                                  type="button"
                                  title={`${edge.side} edge — ${edge.kind}${lowConf ? ' (low confidence)' : ''} · click to reclassify`}
                                  onClick={() => handleEdgeCycle(facet.index, edgeIdx)}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition-colors hover:opacity-80"
                                  style={{
                                    borderColor: lowConf ? '#f59e0b' : style.color,
                                    color: lowConf ? '#b45309' : style.color,
                                    backgroundColor: lowConf ? '#fef3c720' : `${style.color}15`,
                                  }}
                                >
                                  <span className="capitalize">{edge.side[0]}</span>
                                  <span>·</span>
                                  <span className="capitalize">{edge.kind}</span>
                                  {lowConf && <span title="low confidence">~</span>}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-slate-600">Total</td>
                    <td className="px-3 py-2 text-right text-xs font-bold text-slate-900">{Math.round(editableFacets.reduce((s, f) => s + f.actualAreaSqFt, 0)).toLocaleString()} sq ft</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">{Math.round(editableFacets.reduce((s, f) => s + f.groundAreaSqFt, 0)).toLocaleString()} sq ft</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
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
