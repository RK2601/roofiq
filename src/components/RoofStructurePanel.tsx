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

  useEffect(() => {
    setEditableFacets(analysis.facets);
    setEdited(false);
  }, [analysis]);

  const editableMeasurements = useMemo(
    () => recomputeMeasurementsFromFacets(editableFacets),
    [editableFacets]
  );

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
      const currentIdx = EDITABLE_EDGE_KINDS.indexOf(edge.kind);
      edge.kind = EDITABLE_EDGE_KINDS[(currentIdx + 1) % EDITABLE_EDGE_KINDS.length];

      if (edge.adjacentFacetIndex !== null) {
        const adjacent = facets.find(item => item.index === edge.adjacentFacetIndex);
        const reciprocal = adjacent?.edges.find(candidate => candidate.adjacentFacetIndex === facetIndex);
        if (reciprocal) reciprocal.kind = edge.kind;
      }
      return facets;
    });
    setEdited(true);
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
              }}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              <RotateCcw size={12} />
              Reset edits
            </button>
            <button
              type="button"
              disabled={!edited}
              onClick={() => {
                if (!edited) return;
                const next: RoofStructureAnalysis = {
                  ...analysis,
                  facets: editableFacets,
                  measurements: editableMeasurements,
                  notes: [
                    ...analysis.notes,
                    'Manual edge edits applied in roof structure panel.',
                  ],
                };
                onApply?.(next);
                setEdited(false);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={12} />
              Apply edits
            </button>
            {edited && <span className="text-[11px] text-amber-700">Manual edge edits pending</span>}
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
