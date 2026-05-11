import { useMemo } from 'react';
import { Download, Share2, FileSpreadsheet, MapPin, ExternalLink } from 'lucide-react';
import type { WizardWorkflowReportPayload } from '../utils/db';
import type { CombinedRoofAnalysis, StructuralDetection, StructuralLine } from '../utils/roofVision';
import {
  downloadWizardReportPdf,
  shareWizardReport,
  downloadWizardQuoteDraftPdf,
} from '../utils/wizardReportExport';

const EDGE_COLORS: Record<StructuralLine['type'], string> = {
  ridge: '#ef4444',
  hip: '#f97316',
  valley: '#3b82f6',
  eave: '#22c55e',
  rake: '#a855f7',
  step: '#6b7280',
};

const EDGE_DASH: Record<StructuralLine['type'], number[]> = {
  ridge: [],
  hip: [8, 4],
  valley: [4, 4],
  eave: [],
  rake: [12, 4],
  step: [4, 8],
};

function parseStructure(s: unknown): StructuralDetection | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as StructuralDetection;
  if (!Array.isArray(o.cues)) return null;
  return o;
}

function parseFinal(s: unknown): CombinedRoofAnalysis | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as CombinedRoofAnalysis;
  if (typeof o.condition !== 'string' || !Array.isArray(o.issues)) return null;
  return o;
}

interface Props {
  report: WizardWorkflowReportPayload;
  /** Saved `roof_sections` count for this project (quote builder needs at least one). */
  savedSectionCount?: number;
  onOpenQuoteBuilder?: () => void;
}

export default function WizardWorkflowReportView({
  report,
  savedSectionCount = 0,
  onOpenQuoteBuilder,
}: Props) {
  const structure = useMemo(() => parseStructure(report.structure), [report.structure]);
  const finalAnalysis = useMemo(() => parseFinal(report.finalAnalysis), [report.finalAnalysis]);

  const mappedAreaSqFt = useMemo(() => {
    if (typeof google === 'undefined' || !google.maps?.geometry?.spherical) return Math.round(structure?.totalAreaSqFt ?? 0);
    try {
      return report.segments.reduce((sum, seg) => {
        const path = seg.path;
        if (path.length < 3) return sum;
        const gPath = new google.maps.MVCArray(path.map(p => new google.maps.LatLng(p.lat, p.lng)));
        const poly = new google.maps.Polygon({ paths: gPath });
        const sq = google.maps.geometry.spherical.computeArea(poly.getPath()) * 10.7639;
        gPath.clear();
        return sum + sq;
      }, 0);
    } catch {
      return Math.round(structure?.totalAreaSqFt ?? 0);
    }
  }, [report.segments, structure?.totalAreaSqFt]);

  const edgeTotals = useMemo(() => {
    return (['ridge', 'hip', 'valley', 'eave', 'rake', 'step'] as const).reduce(
      (acc, type) => {
        acc[type] = Math.round(
          (structure?.cues ?? []).filter(cue => cue.type === type).reduce((sum, cue) => sum + cue.estimatedLengthFt, 0)
        );
        return acc;
      },
      { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0, step: 0 }
    );
  }, [structure?.cues]);

  const pitchMix = useMemo(() => {
    return report.segments.reduce<Record<string, number>>((acc, segment) => {
      const analysis = segment.analysis as { pitchEstimate?: string } | null;
      const pitch = analysis?.pitchEstimate ?? 'unknown';
      acc[pitch] = (acc[pitch] ?? 0) + 1;
      return acc;
    }, {});
  }, [report.segments]);

  const diagramWidth = 920;
  const diagramHeight = 560;
  const diagramPadding = 28;

  const { reportPolygons, reportEdges, diagramBounds } = useMemo(() => {
    const allLatLng = report.segments.flatMap(s => s.path);
    const bounds =
      allLatLng.length > 0
        ? {
            minLat: Math.min(...allLatLng.map(p => p.lat)),
            maxLat: Math.max(...allLatLng.map(p => p.lat)),
            minLng: Math.min(...allLatLng.map(p => p.lng)),
            maxLng: Math.max(...allLatLng.map(p => p.lng)),
          }
        : null;

    const toDiagramPoint = (point: { lat: number; lng: number }) => {
      if (!bounds) return { x: diagramPadding, y: diagramPadding };
      const spanLng = Math.max(1e-6, bounds.maxLng - bounds.minLng);
      const spanLat = Math.max(1e-6, bounds.maxLat - bounds.minLat);
      const xNorm = (point.lng - bounds.minLng) / spanLng;
      const yNorm = (bounds.maxLat - point.lat) / spanLat;
      return {
        x: diagramPadding + xNorm * (diagramWidth - diagramPadding * 2),
        y: diagramPadding + yNorm * (diagramHeight - diagramPadding * 2),
      };
    };

    const polys = report.segments.map(segment => {
      const pts = segment.path.map(toDiagramPoint);
      const analysis = segment.analysis as {
        pitchEstimate?: string;
        facingDirection?: string;
      } | null;
      let areaSqFt = 0;
      if (typeof google !== 'undefined' && google.maps?.geometry?.spherical && segment.path.length >= 3) {
        try {
          const gPath = new google.maps.MVCArray(segment.path.map(p => new google.maps.LatLng(p.lat, p.lng)));
          const poly = new google.maps.Polygon({ paths: gPath });
          areaSqFt = Math.round(google.maps.geometry.spherical.computeArea(poly.getPath()) * 10.7639);
          gPath.clear();
        } catch {
          areaSqFt = 0;
        }
      }
      return {
        id: segment.id,
        color: segment.color,
        pitch: analysis?.pitchEstimate ?? 'n/a',
        facing: analysis?.facingDirection ?? 'n/a',
        points: pts,
        center:
          pts.length > 0
            ? {
                x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
                y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
              }
            : { x: 0, y: 0 },
        areaSqFt,
      };
    });

    const edges = (structure?.cues ?? []).map((cue, idx) => ({
      id: `edge-${idx}`,
      type: cue.type,
      color: EDGE_COLORS[cue.type] ?? '#94a3b8',
      x1: diagramPadding + cue.x1 * (diagramWidth - diagramPadding * 2),
      y1: diagramPadding + cue.y1 * (diagramHeight - diagramPadding * 2),
      x2: diagramPadding + cue.x2 * (diagramWidth - diagramPadding * 2),
      y2: diagramPadding + cue.y2 * (diagramHeight - diagramPadding * 2),
      dash: EDGE_DASH[cue.type] ?? [],
    }));

    return { reportPolygons: polys, reportEdges: edges, diagramBounds: bounds };
  }, [report.segments, structure?.cues]);

  const quoteBaseRatePerSq = finalAnalysis
    ? finalAnalysis.condition === 'Excellent'
      ? 380
      : finalAnalysis.condition === 'Good'
        ? 430
        : finalAnalysis.condition === 'Fair'
          ? 520
          : finalAnalysis.condition === 'Poor'
            ? 610
            : 690
    : 450;
  const areaSquares = Math.max(1, Math.round((structure?.totalAreaSqFt ?? mappedAreaSqFt) / 100));
  const quoteSubtotal = Math.round(areaSquares * quoteBaseRatePerSq);
  const quoteLineItems = [
    { label: 'Roof system replacement', qty: `${areaSquares} sq`, unit: `$${quoteBaseRatePerSq}`, total: `$${quoteSubtotal}` },
    { label: 'Ridge / hip treatment', qty: `${edgeTotals.ridge + edgeTotals.hip} ft`, unit: '$4.25', total: `$${Math.round((edgeTotals.ridge + edgeTotals.hip) * 4.25)}` },
    { label: 'Valley waterproofing', qty: `${edgeTotals.valley} ft`, unit: '$6.5', total: `$${Math.round(edgeTotals.valley * 6.5)}` },
    { label: 'Eave + rake finishing', qty: `${edgeTotals.eave + edgeTotals.rake} ft`, unit: '$2.1', total: `$${Math.round((edgeTotals.eave + edgeTotals.rake) * 2.1)}` },
  ];
  const quoteTotal = quoteLineItems.reduce((sum, item) => sum + Number(item.total.replace('$', '')), 0);

  const staticMapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(report.address)}`;

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b border-slate-200 pb-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Wizard workflow report</p>
          <h3 className="text-lg font-bold text-slate-900 mt-1 break-words">{report.address}</h3>
          <p className="text-[11px] text-slate-500 mt-1">
            Schematic from mapped segments and Solar-assisted structure — not as-built field measurements.
          </p>
          <a
            href={staticMapHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-2"
          >
            <MapPin size={12} /> Open in Google Maps <ExternalLink size={11} className="opacity-60" />
          </a>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            disabled={!finalAnalysis}
            onClick={() => downloadWizardReportPdf(report)}
            className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download size={12} /> Download PDF
          </button>
          <button
            type="button"
            disabled={!finalAnalysis}
            onClick={() => void shareWizardReport(report)}
            className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Share2 size={12} /> Share
          </button>
          <button
            type="button"
            disabled={!finalAnalysis}
            onClick={() => downloadWizardQuoteDraftPdf(report)}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <FileSpreadsheet size={12} /> Quote draft PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-2 shadow-sm">
          <h4 className="text-sm font-semibold text-slate-800 mb-2">All structures summary</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Roof area</p>
              <p className="text-slate-900 font-semibold">
                {Math.round(structure?.totalAreaSqFt ?? mappedAreaSqFt).toLocaleString()} sq ft
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Segments</p>
              <p className="text-slate-900 font-semibold">{report.segments.length}</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Predominant pitch</p>
              <p className="text-slate-900 font-semibold">{structure?.predominantPitch ?? 'n/a'}</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Final score</p>
              <p className="text-slate-900 font-semibold">{finalAnalysis ? `${finalAnalysis.condition_score}/100` : '—'}</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Ridges</p>
              <p className="text-slate-900 font-semibold">{edgeTotals.ridge} ft</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Hips</p>
              <p className="text-slate-900 font-semibold">{edgeTotals.hip} ft</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Valleys</p>
              <p className="text-slate-900 font-semibold">{edgeTotals.valley} ft</p>
            </div>
            <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
              <p className="text-slate-500">Eaves + rakes</p>
              <p className="text-slate-900 font-semibold">{edgeTotals.eave + edgeTotals.rake} ft</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 className="text-sm font-semibold text-slate-800 mb-2">Pitch mix</h4>
          <div className="space-y-1.5 text-xs">
            {Object.keys(pitchMix).length === 0 && <p className="text-slate-500">No pitch data</p>}
            {Object.entries(pitchMix).map(([pitch, count]) => (
              <div key={pitch} className="flex items-center justify-between border-b border-slate-100 pb-1">
                <span className="text-slate-600">{pitch}</span>
                <span className="font-semibold text-slate-900">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {diagramBounds && reportPolygons.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 className="text-sm font-semibold text-slate-800 mb-1">Pitch and direction (schematic)</h4>
          <p className="text-[11px] text-slate-500 mb-3">Diagram from wizard geometry — illustrative, not a survey drawing.</p>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${diagramWidth} ${diagramHeight}`} className="w-full h-auto rounded-lg border border-slate-200 bg-slate-50 max-h-[480px]">
              {reportEdges.map(edge => (
                <line
                  key={edge.id}
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke={edge.color}
                  strokeWidth={2.4}
                  strokeDasharray={edge.dash.length > 0 ? edge.dash.join(' ') : undefined}
                  strokeLinecap="round"
                />
              ))}
              {reportPolygons.map(poly => (
                <g key={poly.id}>
                  <polygon
                    points={poly.points.map(p => `${p.x},${p.y}`).join(' ')}
                    fill={`${poly.color}2A`}
                    stroke={poly.color}
                    strokeWidth={2}
                  />
                  <text x={poly.center.x} y={poly.center.y - 8} textAnchor="middle" fontSize="16" fontWeight="700" fill="#0f172a">
                    {poly.pitch} · {poly.facing}
                  </text>
                  <text x={poly.center.x} y={poly.center.y + 14} textAnchor="middle" fontSize="14" fill="#334155">
                    {poly.areaSqFt} sq ft
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h4 className="text-sm font-semibold text-slate-800 mb-2">Captured viewpoints</h4>
        <p className="text-[11px] text-slate-500 mb-3">Includes map captures stored with the workflow (where under size limits).</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {report.photos.map(photo => (
            <div key={photo.id} className="rounded-lg border border-slate-100 overflow-hidden bg-slate-50">
              <p className="text-[10px] font-semibold text-slate-600 px-2 py-1 truncate">{photo.label}</p>
              {photo.captureImageDataUrl ? (
                <img src={photo.captureImageDataUrl} alt={photo.label} className="w-full h-24 object-cover" />
              ) : (
                <div className="h-24 flex items-center justify-center text-[10px] text-slate-400 px-1 text-center">No image stored</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {finalAnalysis && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            className={`rounded-xl p-4 border ${
              finalAnalysis.condition === 'Excellent' || finalAnalysis.condition === 'Good'
                ? 'bg-green-50 border-green-200'
                : finalAnalysis.condition === 'Fair'
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-red-50 border-red-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-600 font-medium">Roof condition</span>
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/80 border border-slate-200">
                {finalAnalysis.urgency} urgency
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">{finalAnalysis.condition}</span>
              <span className="text-slate-500 text-sm">{finalAnalysis.condition_score}/100</span>
            </div>
            <p className="text-xs text-slate-600 mt-1">{finalAnalysis.estimated_remaining_life}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h4 className="text-xs font-semibold text-slate-800 mb-2">Recommendation</h4>
            <p className="text-xs text-slate-600 leading-relaxed">{finalAnalysis.recommendation}</p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h4 className="text-sm font-semibold text-slate-800 mb-2">Material quote preview</h4>
        <p className="text-[11px] text-slate-500 mb-3">Approximate line items from wizard totals. For a full quote builder, use the project sections flow.</p>
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className="grid grid-cols-12 gap-2 text-[11px] font-semibold text-slate-500 border-b border-slate-200 pb-2">
              <div className="col-span-5">Item</div>
              <div className="col-span-2">Qty</div>
              <div className="col-span-2">Unit</div>
              <div className="col-span-3 text-right">Total</div>
            </div>
            {quoteLineItems.map(item => (
              <div key={item.label} className="grid grid-cols-12 gap-2 text-xs text-slate-700 py-2 border-b border-slate-100">
                <div className="col-span-5">{item.label}</div>
                <div className="col-span-2">{item.qty}</div>
                <div className="col-span-2">{item.unit}</div>
                <div className="col-span-3 text-right font-semibold text-slate-900">{item.total}</div>
              </div>
            ))}
            <div className="grid grid-cols-12 gap-2 text-sm font-semibold text-slate-900 pt-2">
              <div className="col-span-9 text-right">Estimated total</div>
              <div className="col-span-3 text-right">${quoteTotal.toLocaleString()}</div>
            </div>
          </div>
        </div>
        {onOpenQuoteBuilder &&
          (savedSectionCount > 0 ? (
            <button
              type="button"
              onClick={onOpenQuoteBuilder}
              className="mt-4 text-sm font-semibold text-blue-600 hover:text-blue-700"
            >
              Open quote builder →
            </button>
          ) : (
            <p className="mt-4 text-xs text-slate-500 leading-relaxed">
              To use the full quote builder, save measured roof sections from{' '}
              <span className="font-medium text-slate-700">Analysis</span> (Save &amp; Quote) for this address first.
              Wizard totals above are for reference only.
            </p>
          ))}
      </div>
    </div>
  );
}
