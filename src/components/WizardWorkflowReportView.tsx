import { useMemo, useRef, useState, useEffect } from 'react';
import { Download, Share2, MapPin, Camera, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import type { WizardWorkflowReportPayload } from '../utils/db';
import RoofModel3D from './RoofModel3D';
import { latLngToImageNorm, type CombinedRoofAnalysis, type StructuralDetection, type StructuralLine, type OutlineAnalysis } from '../utils/roofVision';
import {
  downloadWizardReportPdf,
  shareWizardReport,
  canDownloadWizardPdf,
} from '../utils/wizardReportExport';
import { loadBranding } from '../utils/quoteBranding';

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
  hip: [],
  valley: [],
  eave: [],
  rake: [],
  step: [],
};

// ─── Roof Topology Engine ─────────────────────────────────────────────────────
// Snaps near-coincident vertices and deduplicates shared edges so every
// boundary is drawn exactly once — boundary edges in the segment colour,
// internal (shared) edges as a single neutral line.

const SNAP_TOL = 10; // diagram-pixel tolerance for vertex merging

interface Pt { x: number; y: number }

/** Round a coordinate to the snap grid */
function snapKey(x: number, y: number): string {
  return `${Math.round(x / SNAP_TOL)},${Math.round(y / SNAP_TOL)}`;
}

/** Return the canonical representative for a vertex (nearest grid centre) */
function snapPt(p: Pt): Pt {
  return {
    x: Math.round(p.x / SNAP_TOL) * SNAP_TOL,
    y: Math.round(p.y / SNAP_TOL) * SNAP_TOL,
  };
}

interface TopoEdge {
  x1: number; y1: number;
  x2: number; y2: number;
  /** Indices of polygons that share this edge */
  polyIndices: number[];
}

interface TopologyResult {
  /** Polygons with snapped vertices (use for fills) */
  snappedPolys: Pt[][];
  /** Deduplicated edges with ownership info */
  edges: TopoEdge[];
}

/** Proper polygon centroid — always lands inside convex shapes and usually inside concave ones. */
function polyCenter(pts: Pt[]): Pt {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  if (pts.length === 2) return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  let area = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-6) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function buildRoofTopology(polygons: Pt[][]): TopologyResult {
  // 1. Snap all vertices to grid
  const snappedPolys = polygons.map(pts => pts.map(snapPt));

  // 2. Collect edges with a canonical direction-independent key
  const edgeMap = new Map<string, TopoEdge>();

  for (let pi = 0; pi < snappedPolys.length; pi++) {
    const pts = snappedPolys[pi];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      // Skip zero-length edges
      if (a.x === b.x && a.y === b.y) continue;
      // Canonical: sort so the "smaller" point comes first
      const [p1, p2] =
        a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a];
      const key = `${snapKey(p1.x, p1.y)}|${snapKey(p2.x, p2.y)}`;
      if (edgeMap.has(key)) {
        const e = edgeMap.get(key)!;
        if (!e.polyIndices.includes(pi)) e.polyIndices.push(pi);
      } else {
        edgeMap.set(key, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, polyIndices: [pi] });
      }
    }
  }

  return { snappedPolys, edges: Array.from(edgeMap.values()) };
}
// ─────────────────────────────────────────────────────────────────────────────

function parseStructure(s: unknown): StructuralDetection | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as StructuralDetection;
  if (!Array.isArray(o.cues)) return null;
  return o;
}

function parseOutlineAnalysis(a: unknown): OutlineAnalysis | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as OutlineAnalysis;
  if (typeof o.qualityScore !== 'number' || typeof o.coverage !== 'number') return null;
  return o;
}

function parseFinal(s: unknown): CombinedRoofAnalysis | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as CombinedRoofAnalysis;
  if (typeof o.condition !== 'string' || !Array.isArray(o.issues)) return null;
  return o;
}

interface SolarFacet {
  index: number;
  pitchLabel: string;
  facingLabel: string;
  actualAreaSqFt: number;
  groundAreaSqFt: number;
  placement?: { x: number; y: number; w: number; h: number; outlinePx?: { x: number; y: number }[] };
}
interface SolarMeasurements {
  facetCount: number;
  predominantPitch: string;
  totalRoofAreaSqFt: number;
  totalGroundAreaSqFt: number;
  totalRidgeFt: number;
  totalHipFt: number;
  totalValleyFt: number;
  totalEaveFt: number;
  totalRakeFt: number;
}
interface SolarStructure {
  facets: SolarFacet[];
  measurements: SolarMeasurements;
  confidenceBand?: string;
  svg?: { viewBox: string; width: number; height: number };
}

function parseSolarStructure(s: unknown): SolarStructure | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as SolarStructure;
  if (!Array.isArray(o.facets) || !o.measurements) return null;
  return o;
}

interface Props {
  report: WizardWorkflowReportPayload;
  /** Saved `roof_sections` count for this project (quote builder needs at least one). */
  savedSectionCount?: number;
  onOpenQuoteBuilder?: () => void;
  mapsApiKey?: string;
}

export default function WizardWorkflowReportView({
  report,
  savedSectionCount = 0,
  onOpenQuoteBuilder,
  mapsApiKey,
}: Props) {
  const reportPdfRef = useRef<HTMLDivElement>(null);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [pdfExportError, setPdfExportError] = useState<string | null>(null);
  const branding = useMemo(() => loadBranding(), []);

  // Crop the satellite snapshot to just the house polygon + padding using canvas.
  const [croppedOutlineUrl, setCroppedOutlineUrl] = useState<string | null>(null);
  useEffect(() => {
    const pts = report.outline?.points;
    if (!pts || pts.length < 3 || !report.roofOutlineSnapshot) { setCroppedOutlineUrl(null); return; }
    const center = report.coordinates;
    const imgSize = 640;
    const zoom = 20;
    const imgPts = pts.map(p => {
      const n = latLngToImageNorm(p, center, zoom, imgSize);
      return { x: n.x * imgSize, y: n.y * imgSize };
    });
    const pad = 55;
    const minX = Math.max(0, Math.min(...imgPts.map(p => p.x)) - pad);
    const maxX = Math.min(imgSize, Math.max(...imgPts.map(p => p.x)) + pad);
    const minY = Math.max(0, Math.min(...imgPts.map(p => p.y)) - pad);
    const maxY = Math.min(imgSize, Math.max(...imgPts.map(p => p.y)) + pad);
    const cropW = maxX - minX;
    const cropH = maxY - minY;
    if (cropW < 10 || cropH < 10) { setCroppedOutlineUrl(null); return; }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(cropW);
      canvas.height = Math.round(cropH);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, minX, minY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      setCroppedOutlineUrl(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => setCroppedOutlineUrl(null);
    img.src = report.roofOutlineSnapshot;
  }, [report.outline?.points, report.coordinates, report.roofOutlineSnapshot]);
  const structure = useMemo(() => parseStructure(report.structure), [report.structure]);
  const finalAnalysis = useMemo(() => parseFinal(report.finalAnalysis), [report.finalAnalysis]);
  const outlineAnalysis = useMemo(
    () => parseOutlineAnalysis(report.outline?.analysis ?? null),
    [report.outline?.analysis]
  );

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

  const diagramWidth = 560;
  const diagramHeight = 800;
  const diagramPadding = 28;

  const { reportPolygons, topoEdges, reportEdges, diagramBounds } = useMemo(() => {
    // Only use polygon segments (≥3 points) for bounds so degenerate segments
    // (single points / lines stored far from the house) don't distort the scale.
    const polySegments = report.segments.filter(s => s.path.length >= 3);
    const allLatLng = (polySegments.length > 0 ? polySegments : report.segments).flatMap(s => s.path);
    const bounds =
      allLatLng.length > 0
        ? {
            minLat: Math.min(...allLatLng.map(p => p.lat)),
            maxLat: Math.max(...allLatLng.map(p => p.lat)),
            minLng: Math.min(...allLatLng.map(p => p.lng)),
            maxLng: Math.max(...allLatLng.map(p => p.lng)),
          }
        : null;

    const toDiagramPoint = (point: { lat: number; lng: number }): Pt => {
      if (!bounds) return { x: diagramPadding, y: diagramPadding };
      const spanLng = Math.max(1e-6, bounds.maxLng - bounds.minLng);
      const spanLat = Math.max(1e-6, bounds.maxLat - bounds.minLat);
      const rawX = (point.lng - bounds.minLng) / spanLng;
      const rawY = (bounds.maxLat - point.lat) / spanLat;
      const drawW = diagramWidth - diagramPadding * 2;
      const drawH = diagramHeight - diagramPadding * 2;
      // Direct normalized mapping — shapes always fill the draw area so the
      // full viewBox (0 0 w h) always works without any corner-offset issues.
      return {
        x: diagramPadding + rawX * drawW,
        y: diagramPadding + rawY * drawH,
      };
    };

    const rawPolys: Pt[][] = report.segments.map(s => s.path.map(toDiagramPoint));

    // Run the topology engine — snaps vertices + deduplicates edges
    const { snappedPolys, edges: tEdges } = buildRoofTopology(rawPolys);

    const polys = report.segments.map((segment, i) => {
      const snapped = snappedPolys[i];
      const analysis = segment.analysis as {
        pitchEstimate?: string;
        facingDirection?: string;
      } | null;
      const dsm = segment as { dsmPitchRatio?: string; dsmFacingDirection?: string };
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
        pitch: dsm.dsmPitchRatio ?? analysis?.pitchEstimate ?? 'n/a',
        facing: dsm.dsmFacingDirection ?? analysis?.facingDirection ?? 'n/a',
        isDsm: !!dsm.dsmPitchRatio,
        points: snapped,
        center: polyCenter(snapped),
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

    return { reportPolygons: polys, topoEdges: tEdges, reportEdges: edges, diagramBounds: bounds };
  }, [report.segments, structure?.cues]);

  const streetViewImageSrc = useMemo(() => {
    const k = mapsApiKey?.trim();
    if (!k) return null;
    const raw =
      `https://maps.googleapis.com/maps/api/streetview?size=640x360&scale=2` +
      `&location=${report.coordinates.lat},${report.coordinates.lng}` +
      `&fov=65&pitch=5&source=outdoor&key=${encodeURIComponent(k)}`;
    if (typeof window !== 'undefined') {
      return `${window.location.origin}/api/proxy-static-map?u=${encodeURIComponent(raw)}`;
    }
    return raw;
  }, [mapsApiKey, report.coordinates.lat, report.coordinates.lng]);

  const staticMapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(report.address)}`;
  const streetViewPanoHref = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${report.coordinates.lat},${report.coordinates.lng}`;

  return (
    <>
      <div className="flex flex-col items-end gap-2 pb-3">
        {pdfExportError && (
          <p className="text-xs text-red-600 max-w-md text-right leading-snug" role="alert">
            {pdfExportError}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={!canDownloadWizardPdf(report) || pdfExporting}
          onClick={() => {
            if (!reportPdfRef.current) return;
            setPdfExportError(null);
            setPdfExporting(true);
            void downloadWizardReportPdf(reportPdfRef.current, report)
              .catch(err => {
                console.error('[WizardReport] PDF export failed', err);
                const msg =
                  err instanceof Error ? err.message : typeof err === 'string' ? err : 'PDF export failed.';
                setPdfExportError(msg);
              })
              .finally(() => setPdfExporting(false));
          }}
          className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Download size={12} /> {pdfExporting ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        <button
          type="button"
          disabled={!finalAnalysis}
          onClick={() => void shareWizardReport(report)}
          className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Share2 size={12} /> Share
        </button>
</div>
      </div>

      <div ref={reportPdfRef} className="space-y-4 pb-4 bg-white text-slate-900">

        {/* ── Company Header ── */}
        {/* No overflow-hidden here — html2canvas handles border-radius natively,
            and overflow-hidden clips the bottom address bar in the PDF clone. */}
        <div style={{ borderTop: `5px solid ${branding.accentColor || '#1e40af'}`, borderRadius: '0.75rem', border: '1px solid #e2e8f0', background: '#fff' }}>
          <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
            {/* Left: logo + company info — inline flex so html2canvas renders it identically */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
              {branding.logoDataUrl ? (
                <img src={branding.logoDataUrl} alt="Company logo" style={{ height: 56, width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
              ) : (
                <div style={{
                  height: 56, width: 56, borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, color: '#fff', fontSize: 24, fontWeight: 700,
                  backgroundColor: branding.accentColor || '#1e40af',
                }}>
                  {(branding.companyName || 'R').charAt(0).toUpperCase()}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', lineHeight: 1.2, margin: 0 }}>
                  {branding.companyName || 'RoofIQ'}
                </p>
                {branding.tagline && <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>{branding.tagline}</p>}
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: '#64748b' }}>
                  {branding.address && <span>{branding.address}{branding.city ? `, ${branding.city}` : ''}</span>}
                  {branding.phone && <span>{branding.phone}</span>}
                  {branding.email && <span>{branding.email}</span>}
                  {branding.website && <span>{branding.website}</span>}
                  {branding.licenseNo && <span>Lic. #{branding.licenseNo}</span>}
                </div>
              </div>
            </div>
            {/* Right: report title + meta */}
            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <p style={{ fontSize: 20, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: branding.accentColor || '#1e40af', margin: 0 }}>
                Roof Inspection
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#334155', margin: 0 }}>Report</p>
              <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
                <p style={{ margin: 0 }}>Date: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                {report.address && <p style={{ margin: '2px 0 0' }}>Ref: #{report.address.replace(/\D/g, '').slice(0, 6).padStart(6, '0')}</p>}
              </div>
            </div>
          </div>
          {/* Address bar — inline styles so it always renders in PDF */}
          <div style={{ padding: '10px 24px 12px', borderTop: '1px solid #f1f5f9', background: '#f8fafc', borderRadius: '0 0 0.75rem 0.75rem' }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', margin: 0, wordBreak: 'break-word' }}>{report.address}</p>
            <p style={{ fontSize: 10, color: '#94a3b8', margin: '2px 0 0' }}>AI-assisted satellite + photo analysis — not as-built field measurements</p>
          </div>
        </div>

        {/* ── Street View ──
            Keep-blocks drive PDF zoom (pass 2). Do NOT wrap the action pills in the same keep as the
            hero image — ancestor zoom breaks absolute/flex text centering in html2canvas. */}
        {streetViewImageSrc && (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div data-pdf-keep-on-one-page>
              <div className="px-4 pt-3 pb-2">
                <h4 className="text-sm font-semibold text-slate-800">Street View</h4>
                <p className="text-[11px] text-slate-500">Exterior view at the property coordinates</p>
              </div>
              <div className="block max-w-2xl mx-auto" data-pdf-streetview-img-squash-y>
                <a href={streetViewPanoHref} target="_blank" rel="noopener noreferrer" title="Open interactive Street View" className="block">
                  <img
                    src={streetViewImageSrc}
                    alt="Street View preview at saved coordinates"
                    className="w-full aspect-[16/9] object-cover block"
                    loading="lazy"
                  />
                </a>
              </div>
            </div>
            {/* Buttons: keep for page breaks; no-scale so pass 2 never zooms this full-bleed row. */}
            <div
              data-pdf-keep-on-one-page
              data-pdf-no-scale
              style={{
                padding: '10px 16px 14px',
                borderTop: '1px solid #f1f5f9',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <a
                href={staticMapHref}
                target="_blank"
                rel="noopener noreferrer"
                data-pdf-href={staticMapHref}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 32,
                  padding: '0 16px',
                  borderRadius: 999,
                  boxSizing: 'border-box',
                  backgroundColor: branding.accentColor || '#1e40af',
                  textDecoration: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#ffffff',
                  whiteSpace: 'nowrap',
                  lineHeight: 1,
                  fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              >
                Open in Google Maps ↗
              </a>
              <a
                href={streetViewPanoHref}
                target="_blank"
                rel="noopener noreferrer"
                data-pdf-href={streetViewPanoHref}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 32,
                  padding: '0 16px',
                  borderRadius: 999,
                  boxSizing: 'border-box',
                  border: '1.5px solid #d1d5db',
                  backgroundColor: '#ffffff',
                  textDecoration: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#374151',
                  whiteSpace: 'nowrap',
                  lineHeight: 1,
                  fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              >
                Street View Panorama ↗
              </a>
            </div>
          </div>
        )}

        <div className="border-b border-slate-200 pb-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">Wizard Workflow Report</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-400 mt-0.5">Analysis Part-1</p>
          <h3 className="text-base font-bold text-slate-900 mt-1 break-words">{report.address}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Schematic from mapped segments and Solar-assisted structure — not as-built field measurements.
          </p>
        </div>

      {report.roofOutlineSnapshot && (
        <div
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          data-pdf-keep-on-one-page
        >
          <h4 className="text-sm font-semibold text-slate-800 mb-1">Roof outline</h4>
          <p className="text-[11px] text-slate-500 mb-3">
            Step 1 — satellite view with your roof perimeter as saved (orange boundary and corners match the mapping
            wizard).
          </p>
          <div className="rounded-lg border border-slate-200 overflow-hidden bg-slate-100 max-w-3xl mx-auto">
            <img
              src={croppedOutlineUrl ?? report.roofOutlineSnapshot}
              alt="Roof outline on satellite imagery"
              className="w-full h-auto block"
            />
          </div>
          {(outlineAnalysis || (report.outline?.points?.length ?? 0) > 0) && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
                <p className="text-slate-500">Vertices</p>
                <p className="text-slate-900 font-semibold">{report.outline?.points?.length ?? '—'}</p>
              </div>
              {outlineAnalysis && (
                <>
                  <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
                    <p className="text-slate-500">Outline quality</p>
                    <p className="text-slate-900 font-semibold">{Math.round(outlineAnalysis.qualityScore * 100)}%</p>
                  </div>
                  <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
                    <p className="text-slate-500">Coverage</p>
                    <p className="text-slate-900 font-semibold">{Math.round(outlineAnalysis.coverage * 100)}%</p>
                  </div>
                  <div className="rounded-lg border border-slate-100 p-2 bg-slate-50">
                    <p className="text-slate-500">Est. area</p>
                    <p className="text-slate-900 font-semibold">
                      {Math.round(outlineAnalysis.areaEstimateSqFt).toLocaleString()} sq ft
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
          {outlineAnalysis?.notes && (
            <p className="mt-2 text-xs text-slate-600 italic leading-relaxed">{outlineAnalysis.notes}</p>
          )}
        </div>
      )}

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

      {diagramBounds && reportPolygons.length > 0 && (() => {
        // ViewBox must include every painted primitive (fills, topology, structural cues,
        // label callouts). Using polygon points alone can clip edges/labels in PDF rasterization.
        const pad = 50;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let any = false;
        const add = (x: number, y: number) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          any = true;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        };

        reportPolygons
          .filter(p => p.points.length >= 3)
          .forEach(p => p.points.forEach(pt => add(pt.x, pt.y)));
        topoEdges.forEach(e => {
          add(e.x1, e.y1);
          add(e.x2, e.y2);
        });
        reportEdges.forEach(e => {
          add(e.x1, e.y1);
          add(e.x2, e.y2);
        });
        reportPolygons.forEach(p => {
          add(p.center.x - 70, p.center.y - 22);
          add(p.center.x + 70, p.center.y + 18);
        });

        const viewBox = !any
          ? `0 0 ${diagramWidth} ${diagramHeight}`
          : `${minX - pad} ${minY - pad} ${Math.max(1, maxX - minX + pad * 2)} ${Math.max(1, maxY - minY + pad * 2)}`;

        return (
        <div
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          data-pdf-keep-on-one-page
          data-pdf-no-scale
        >
          <h4 className="text-sm font-semibold text-slate-800 mb-1">Pitch and direction (schematic)</h4>
          <p className="text-[11px] text-slate-500 mb-3">
            Topology-corrected diagram — shared edges drawn once, vertices snapped.
            {reportPolygons.some(p => p.isDsm) && <span className="ml-1 text-cyan-600 font-medium">⚡ DSM pitch values</span>}
          </p>
          <div className="flex w-full justify-center overflow-visible" data-pdf-pitch-schematic-squash>
            <svg
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
              overflow="visible"
              className="rounded-lg border border-slate-200 bg-white mx-auto w-full max-w-full block"
              style={{ height: 'auto' }}
            >
              {/* ── Layer 1: fills (no stroke — edges drawn separately below) ── */}
              {reportPolygons.map(poly => (
                <polygon
                  key={`fill-${poly.id}`}
                  points={poly.points.map(p => `${p.x},${p.y}`).join(' ')}
                  fill={`${poly.color}28`}
                  stroke="none"
                />
              ))}

              {/* ── Layer 2: topology edges — one line per boundary ── */}
              {topoEdges.map((edge, i) => {
                const isShared = edge.polyIndices.length > 1;
                // For boundary edges use the owning segment's colour; shared = neutral dark
                const segColor = isShared
                  ? '#1e293b'
                  : (reportPolygons[edge.polyIndices[0]]?.color ?? '#64748b');
                return (
                  <line
                    key={`topo-${i}`}
                    x1={edge.x1} y1={edge.y1}
                    x2={edge.x2} y2={edge.y2}
                    stroke={segColor}
                    strokeWidth={isShared ? 1.5 : 2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isShared ? 0.55 : 1}
                  />
                );
              })}

              {/* ── Layer 3: structural cues (ridge / valley / hip etc.) ── */}
              {reportEdges.map(edge => (
                <line
                  key={edge.id}
                  x1={edge.x1} y1={edge.y1}
                  x2={edge.x2} y2={edge.y2}
                  stroke={edge.color}
                  strokeWidth={2.2}
                  strokeDasharray={edge.dash.length > 0 ? edge.dash.join(' ') : undefined}
                  strokeLinecap="round"
                  opacity={0.85}
                />
              ))}

              {/* ── Layer 4: labels at polygon centroid ── */}
              {reportPolygons.map(poly => {
                if (poly.points.length < 3) return null;
                const cx = poly.center.x;
                const cy = poly.center.y;
                const hasArea = poly.areaSqFt > 0;
                const rW = 72;
                const rH = hasArea ? 26 : 18;
                return (
                  <g key={`label-${poly.id}`}>
                    <rect
                      x={cx - rW / 2} y={cy - rH / 2}
                      width={rW} height={rH} rx={4}
                      fill="white" opacity={0.88}
                    />
                    <text
                      x={cx}
                      y={hasArea ? cy - 4 : cy + 4}
                      textAnchor="middle" dominantBaseline="middle"
                      fontSize="10" fontWeight="700" fill="#0f172a"
                    >
                      {poly.pitch} · {poly.facing}
                    </text>
                    {hasArea && (
                      <text
                        x={cx} y={cy + 9}
                        textAnchor="middle" dominantBaseline="middle"
                        fontSize="9" fill="#475569"
                      >
                        {poly.areaSqFt.toLocaleString()} sq ft
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Edge legend */}
          <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-slate-800 opacity-100" /> Boundary edge</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t border-slate-500 opacity-55" /> Shared edge (plane division)</span>
            {reportEdges.some(e => e.type === 'ridge') && <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-red-500" /> Ridge</span>}
            {reportEdges.some(e => e.type === 'valley') && <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-blue-500" /> Valley</span>}
            {reportEdges.some(e => e.type === 'hip') && <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-orange-500" /> Hip</span>}
          </div>
        </div>
        );
      })()}

      {/* ── 3D Roof Model ── */}
      {report.segments.length > 0 && (
        <div
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          style={{ maxHeight: 560 }}
          data-pdf-keep-on-one-page
        >
          <h4 className="text-sm font-semibold text-slate-800 mb-0.5">3D Roof Model</h4>
          <p className="text-[11px] text-slate-500 mb-3">
            Geometry-derived wireframe — pitch and facing direction inferred from mapped segment data.
          </p>
          <div className="max-h-[460px] overflow-hidden flex justify-center">
            <RoofModel3D segments={report.segments} center={report.coordinates} mapsApiKey={mapsApiKey} />
          </div>
        </div>
      )}

      {/* ── Google Solar API Structure Analysis ── */}
      {(() => {
        const solar = parseSolarStructure(report.solarStructure);
        if (!solar) return null;
        const m = solar.measurements;
        const FACET_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#6366f1','#10b981','#f43f5e'];
        const placedFacets = solar.facets.filter(f => f.placement);
        return (
          <div className="rounded-xl border border-sky-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between mb-1">
              <div>
                <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  Google Solar API — Roof Structure Analysis
                  {solar.confidenceBand && (
                    <span className={`report-pill-10 ${
                      solar.confidenceBand === 'high' ? 'bg-green-100 text-green-700'
                      : solar.confidenceBand === 'medium' ? 'bg-amber-100 text-amber-700'
                      : 'bg-red-100 text-red-700'
                    }`}>{solar.confidenceBand} confidence</span>
                  )}
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Automatically detected from 0.1 m/pixel Solar imagery — {m.facetCount} roof planes identified
                </p>
              </div>
            </div>

            {/* Measurements summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 mt-3">
              {[
                { label: 'Total roof area', value: `${Math.round(m.totalRoofAreaSqFt).toLocaleString()} sq ft` },
                { label: 'Ground area', value: `${Math.round(m.totalGroundAreaSqFt).toLocaleString()} sq ft` },
                { label: 'Predominant pitch', value: m.predominantPitch },
                { label: 'Roof planes', value: String(m.facetCount) },
              ].map(s => (
                <div key={s.label} className="rounded-lg bg-sky-50 border border-sky-100 px-3 py-2">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">{s.label}</p>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">{s.value}</p>
                </div>
              ))}
            </div>

            {/* Edge totals */}
            <div className="flex flex-wrap gap-3 text-xs text-slate-600 mb-4">
              {m.totalRidgeFt > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-red-500 inline-block" />Ridge {Math.round(m.totalRidgeFt)} ft</span>}
              {m.totalHipFt > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-orange-500 inline-block" />Hip {Math.round(m.totalHipFt)} ft</span>}
              {m.totalValleyFt > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-blue-500 inline-block" />Valley {Math.round(m.totalValleyFt)} ft</span>}
              {m.totalEaveFt > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-green-500 inline-block" />Eave {Math.round(m.totalEaveFt)} ft</span>}
              {m.totalRakeFt > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-purple-500 inline-block" />Rake {Math.round(m.totalRakeFt)} ft</span>}
            </div>

            {/* Inline unfolded diagram — uses pre-computed viewBox so no clipping */}
            {placedFacets.length > 0 && (() => {
              // Prefer the server-computed viewBox (accounts for minX/minY correctly).
              // Fall back to manual bounds if svg metadata wasn't stored.
              let viewBox = solar.svg?.viewBox ?? '';
              if (!viewBox) {
                const minX = Math.min(...placedFacets.map(f => f.placement!.x));
                const minY = Math.min(...placedFacets.map(f => f.placement!.y));
                const maxX = Math.max(...placedFacets.map(f => f.placement!.x + f.placement!.w));
                const maxY = Math.max(...placedFacets.map(f => f.placement!.y + f.placement!.h));
                const vpad = 20;
                viewBox = `${minX - vpad} ${minY - vpad} ${maxX - minX + vpad * 2} ${maxY - minY + vpad * 2}`;
              }
              // Expand viewBox to include actual polygon outline extremes (outlinePx can exceed placement rect)
              if (!solar.svg?.viewBox) {
                let exMinX = Infinity, exMinY = Infinity, exMaxX = -Infinity, exMaxY = -Infinity;
                for (const f of placedFacets) {
                  const p = f.placement!;
                  if (p.outlinePx && p.outlinePx.length > 0) {
                    for (const pt of p.outlinePx) {
                      exMinX = Math.min(exMinX, p.x + pt.x); exMinY = Math.min(exMinY, p.y + pt.y);
                      exMaxX = Math.max(exMaxX, p.x + pt.x); exMaxY = Math.max(exMaxY, p.y + pt.y);
                    }
                  } else {
                    exMinX = Math.min(exMinX, p.x); exMinY = Math.min(exMinY, p.y);
                    exMaxX = Math.max(exMaxX, p.x + p.w); exMaxY = Math.max(exMaxY, p.y + p.h);
                  }
                }
                if (isFinite(exMinX)) {
                  const vpad = 30;
                  viewBox = `${exMinX - vpad} ${exMinY - vpad} ${exMaxX - exMinX + vpad * 2} ${exMaxY - exMinY + vpad * 2}`;
                }
              }
              return (
                <div className="w-full mb-4 flex justify-center" data-pdf-keep-on-one-page>
                  <div className="w-full flex justify-center" data-pdf-solar-structure-diagram-shrink>
                    <svg viewBox={viewBox} overflow="visible" className="w-full h-auto rounded-lg border border-slate-200 bg-slate-50 block mx-auto">
                      {placedFacets.map((f, i) => {
                      const p = f.placement!;
                      const cx = p.x + p.w / 2;
                      const cy = p.y + p.h / 2;
                      const color = FACET_COLORS[i % FACET_COLORS.length];
                      const hasOutline = p.outlinePx && p.outlinePx.length >= 3;
                      const shapePoints = hasOutline
                        ? p.outlinePx!.map(pt => `${p.x + pt.x},${p.y + pt.y}`).join(' ')
                        : `${p.x},${p.y} ${p.x + p.w},${p.y} ${p.x + p.w},${p.y + p.h} ${p.x},${p.y + p.h}`;
                      const fontSize = Math.max(8, Math.min(13, p.w / 9));
                      return (
                        <g key={f.index}>
                          <polygon points={shapePoints} fill={`${color}22`} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
                          <text x={cx} y={cy - fontSize * 0.6} textAnchor="middle" fontSize={fontSize} fontWeight="700" fill="#0f172a">{f.pitchLabel} · {f.facingLabel}</text>
                          <text x={cx} y={cy + fontSize * 0.9} textAnchor="middle" fontSize={Math.max(7, fontSize - 1)} fill="#475569">{Math.round(f.actualAreaSqFt).toLocaleString()} sq ft</text>
                        </g>
                      );
                    })}
                    </svg>
                  </div>
                </div>
              );
            })()}

            {/* Facets table — keep together on one PDF page slice (see wizardReportExport keep-blocks). */}
            <div className="overflow-x-auto" data-pdf-keep-on-one-page>
            <table className="w-full text-xs min-w-[480px]">
              <thead>
                <tr className="bg-sky-50 border-b border-sky-100">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">#</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Pitch</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Facing</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Roof Area</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Ground Area</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {solar.facets.map((f, i) => (
                  <tr key={f.index} className="hover:bg-sky-50/50">
                    <td className="px-3 py-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5" style={{ backgroundColor: FACET_COLORS[i % FACET_COLORS.length] }} />
                      {i + 1}
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-700">{f.pitchLabel}</td>
                    <td className="px-3 py-2 text-slate-600">{f.facingLabel}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{Math.round(f.actualAreaSqFt).toLocaleString()} sq ft</td>
                    <td className="px-3 py-2 text-right text-slate-500">{Math.round(f.groundAreaSqFt).toLocaleString()} sq ft</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-sky-50 border-t border-sky-200 font-semibold">
                  <td colSpan={3} className="px-3 py-2 text-slate-700">Total</td>
                  <td className="px-3 py-2 text-right text-slate-800">{Math.round(m.totalRoofAreaSqFt).toLocaleString()} sq ft</td>
                  <td className="px-3 py-2 text-right text-slate-600">{Math.round(m.totalGroundAreaSqFt).toLocaleString()} sq ft</td>
                </tr>
              </tfoot>
            </table>
            </div>
          </div>
        );
      })()}

      {/* ── Multi-Angle Photo Analysis ── */}
      {report.photos.some(p => p.status === 'done') && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 className="text-sm font-semibold text-slate-800 mb-1">Multi-Angle Photo Analysis</h4>
          <p className="text-[11px] text-slate-500 mb-3">
            {report.photos.filter(p => p.status === 'done').length} of {report.photos.length} angles analyzed · AI + Depth Pro heat analysis per viewpoint
          </p>
          <div className="flex flex-col gap-3">
            {report.photos.filter(p => p.status === 'done' || p.captureImageDataUrl).map(photo => (
              <div
                key={photo.id}
                className="rounded-lg border border-slate-100 bg-slate-50 overflow-hidden"
                data-pdf-keep-on-one-page
              >
                <div className="flex gap-3 p-3">
                  {/* Photo thumbnail */}
                  {photo.captureImageDataUrl ? (
                    <div className="shrink-0 flex gap-1.5">
                      <img
                        src={photo.captureImageDataUrl}
                        alt={photo.label}
                        className="w-20 h-20 object-cover rounded-lg border border-slate-200 shadow-sm"
                      />
                      {photo.depthMapUrl && (
                        <img
                          src={photo.depthMapUrl}
                          alt="Depth map"
                          className="w-20 h-20 object-cover rounded-lg border border-violet-200 shadow-sm"
                          title="Depth Pro heat map"
                        />
                      )}
                    </div>
                  ) : (
                    <div className="shrink-0 w-20 h-20 rounded-lg bg-slate-200 flex items-center justify-center border border-slate-200">
                      <span className="text-[10px] text-slate-400 text-center px-1">{photo.label}</span>
                    </div>
                  )}
                  {/* Analysis data */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-slate-800">{photo.label}</span>
                      {photo.status === 'done' && (
                        <span className="report-pill-10 bg-emerald-100 text-emerald-700">Analyzed</span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mb-1.5">{photo.description}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {photo.qualityScore != null && (
                        <span className={`report-pill-10 ${
                          photo.qualityScore >= 0.7 ? 'bg-green-100 text-green-700'
                          : photo.qualityScore >= 0.4 ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-700'
                        }`}>
                          Quality {Math.round(photo.qualityScore * 100)}%
                        </span>
                      )}
                      {(photo.cueCount ?? 0) > 0 && (
                        <span className="report-pill-10 bg-blue-100 text-blue-700">
                          {photo.cueCount} cues
                        </span>
                      )}
                      {photo.depthPitchRatio && (
                        <span className="report-pill-10-wrap bg-violet-100 text-violet-700">
                          Depth pitch ~{photo.depthPitchRatio} ({photo.depthPitchDeg?.toFixed(1)}°)
                        </span>
                      )}
                    </div>
                    {photo.byType && Object.keys(photo.byType).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {Object.entries(photo.byType).filter(([, v]) => v > 0).map(([type, count]) => (
                          <span key={type} className="report-pill-9 bg-slate-200 text-slate-600 capitalize">
                            {type}: {count}
                          </span>
                        ))}
                      </div>
                    )}
                    {photo.notes && (
                      <p className="mt-1 text-[10px] text-slate-500 italic">{photo.notes}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
              <span className="report-pill-12 bg-white/80 border border-slate-200 text-slate-800">
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

      {/* ── Issues Found & Action Plan ── */}
      {finalAnalysis && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h4 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <AlertTriangle size={15} className={
              finalAnalysis.condition === 'Excellent' || finalAnalysis.condition === 'Good'
                ? 'text-green-500' : finalAnalysis.condition === 'Fair' ? 'text-amber-500' : 'text-red-500'
            } />
            Issues Found &amp; Action Plan
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Issues list */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Identified Issues</p>
              {finalAnalysis.issues && finalAnalysis.issues.length > 0 ? (
                <ul className="space-y-1.5">
                  {finalAnalysis.issues.map((issue: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                      <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-red-100 text-red-600 flex items-center justify-center text-[9px] font-bold leading-none">{i + 1}</span>
                      {issue}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex items-center gap-2 text-xs text-green-700">
                  <CheckCircle size={13} className="text-green-500" />
                  No significant issues identified
                </div>
              )}
            </div>
            {/* Timeline + recommendation */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Recommended Timeline</p>
              <div className="flex items-center gap-2 mb-2">
                <Clock size={13} className="text-slate-400 shrink-0" />
                <span className={`report-pill-12-md ${
                  finalAnalysis.urgency === 'Low' ? 'bg-green-100 text-green-700'
                  : finalAnalysis.urgency === 'Medium' ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-700'
                }`}>{finalAnalysis.urgency} urgency</span>
              </div>
              {finalAnalysis.estimated_remaining_life && (
                <p className="text-xs text-slate-600 mb-2">
                  <span className="font-medium">Estimated remaining life:</span> {finalAnalysis.estimated_remaining_life}
                </p>
              )}
              <p className="text-xs text-slate-600 leading-relaxed">{finalAnalysis.recommendation}</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Key Measurements Summary (keep on one PDF page slice — see wizardReportExport) ── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-pdf-keep-on-one-page>
        <h4 className="text-sm font-semibold text-slate-800 mb-3">Key Measurements Summary</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[400px]">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left pb-2 font-semibold text-slate-500 uppercase tracking-wide text-[10px]">Measurement</th>
                <th className="text-right pb-2 font-semibold text-slate-500 uppercase tracking-wide text-[10px]">Mapped (Wizard)</th>
                <th className="text-right pb-2 font-semibold text-slate-500 uppercase tracking-wide text-[10px]">Solar API</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(() => {
                const solar = parseSolarStructure(report.solarStructure);
                const sm = solar?.measurements;
                return [
                  { label: 'Total roof area', mapped: `${Math.round(structure?.totalAreaSqFt ?? mappedAreaSqFt).toLocaleString()} sq ft`, solar: sm ? `${Math.round(sm.totalRoofAreaSqFt).toLocaleString()} sq ft` : '—' },
                  { label: 'Ground footprint area', mapped: '—', solar: sm ? `${Math.round(sm.totalGroundAreaSqFt).toLocaleString()} sq ft` : '—' },
                  { label: 'Predominant pitch', mapped: structure?.predominantPitch ?? '—', solar: sm?.predominantPitch ?? '—' },
                  { label: 'Roof planes / segments', mapped: String(report.segments.length), solar: sm ? String(sm.facetCount) : '—' },
                  { label: 'Ridge length', mapped: `${edgeTotals.ridge} ft`, solar: sm && sm.totalRidgeFt > 0 ? `${Math.round(sm.totalRidgeFt)} ft` : '—' },
                  { label: 'Hip length', mapped: `${edgeTotals.hip} ft`, solar: sm && sm.totalHipFt > 0 ? `${Math.round(sm.totalHipFt)} ft` : '—' },
                  { label: 'Valley length', mapped: `${edgeTotals.valley} ft`, solar: sm && sm.totalValleyFt > 0 ? `${Math.round(sm.totalValleyFt)} ft` : '—' },
                  { label: 'Eave length', mapped: `${edgeTotals.eave} ft`, solar: sm && sm.totalEaveFt > 0 ? `${Math.round(sm.totalEaveFt)} ft` : '—' },
                  { label: 'Rake length', mapped: `${edgeTotals.rake} ft`, solar: sm && sm.totalRakeFt > 0 ? `${Math.round(sm.totalRakeFt)} ft` : '—' },
                  { label: 'Condition score', mapped: finalAnalysis ? `${finalAnalysis.condition_score}/100 (${finalAnalysis.condition})` : '—', solar: '—' },
                ].map(row => (
                  <tr key={row.label} className="text-slate-700">
                    <td className="py-2 font-medium text-slate-600">{row.label}</td>
                    <td className="py-2 text-right">{row.mapped}</td>
                    <td className="py-2 text-right text-sky-700">{row.solar}</td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
        {onOpenQuoteBuilder && savedSectionCount > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onOpenQuoteBuilder}
              className="text-sm font-semibold hover:opacity-80"
              style={{ color: branding.accentColor || '#1e40af' }}
            >
              Open full quote builder →
            </button>
          </div>
        )}
      </div>

      {/* ── Company Footer ── */}
      <div style={{ borderBottom: `3px solid ${branding.accentColor || '#1e40af'}` }} className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden mt-2">
        <div className="px-6 py-4 flex flex-col sm:flex-row items-center sm:items-start gap-4">
          <div className="flex items-center gap-3 shrink-0">
            {branding.logoDataUrl ? (
              <img src={branding.logoDataUrl} alt="Company logo" className="h-10 w-auto object-contain" />
            ) : (
              <div
                className="h-10 w-10 rounded-lg flex items-center justify-center text-white text-lg font-bold"
                style={{ backgroundColor: branding.accentColor || '#1e40af' }}
              >
                {(branding.companyName || 'R').charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-sm font-bold text-slate-800">{branding.companyName || 'RoofIQ'}</span>
          </div>
          <div className="flex-1 min-w-0 text-center sm:text-left">
            <div className="flex flex-wrap justify-center sm:justify-start gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
              {branding.address && <span>{branding.address}{branding.city ? `, ${branding.city}` : ''}</span>}
              {branding.phone && <span>{branding.phone}</span>}
              {branding.email && <span>{branding.email}</span>}
              {branding.website && <span>{branding.website}</span>}
              {branding.licenseNo && <span>Lic. #{branding.licenseNo}</span>}
            </div>
          </div>
        </div>
        <div className="px-6 pb-4">
          <p className="text-[10px] text-slate-400 leading-relaxed">
            <span className="font-medium">Disclaimer:</span> This report is generated using AI-assisted satellite imagery, Google Solar API data, and multi-angle photo analysis. It is intended as a preliminary assessment tool and does not constitute as-built field measurements or a formal engineering report. All figures are estimates and should be verified by a qualified roofing professional prior to any procurement or construction activity.
          </p>
        </div>
      </div>

      </div>
    </>
  );
}
