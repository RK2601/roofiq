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

      // Compute area without depending on Google Maps being loaded.
      // Spherical shoelace formula: project lat/lng to metres at the centroid latitude,
      // then apply the standard 2D shoelace formula. Accurate to <0.5% for roof-sized polygons.
      let areaSqFt = 0;
      if (segment.path.length >= 3) {
        try {
          const path = segment.path;
          const n = path.length;
          const centLat = (path.reduce((s, p) => s + p.lat, 0) / n) * (Math.PI / 180);
          const cosLat = Math.cos(centLat);
          const R = 6_371_000; // Earth radius metres
          let area = 0;
          for (let j = 0; j < n; j++) {
            const a = path[j];
            const b = path[(j + 1) % n];
            const ax = a.lng * (Math.PI / 180) * R * cosLat;
            const ay = a.lat * (Math.PI / 180) * R;
            const bx = b.lng * (Math.PI / 180) * R * cosLat;
            const by = b.lat * (Math.PI / 180) * R;
            area += ax * by - bx * ay;
          }
          areaSqFt = Math.round(Math.abs(area / 2) * 10.7639);
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

      {reportPolygons.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm overflow-hidden">
          <h4 className="text-sm font-semibold text-slate-800">Pitch and direction (schematic)</h4>
          <p className="text-[11px] text-slate-500 mt-0.5 mb-3">
            Topology-corrected diagram — shared edges drawn once, vertices snapped.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 overflow-hidden">
            <svg viewBox={`0 0 ${diagramWidth} ${diagramHeight}`} className="w-full h-auto max-h-[780px]">
              {reportPolygons.map(poly => (
                <g key={`fill-${poly.id}`}>
                  <polygon
                    points={poly.points.map(point => `${point.x},${point.y}`).join(' ')}
                    fill={`${poly.color}24`}
                    stroke="none"
                  />
                  <text
                    x={poly.center.x}
                    y={poly.center.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="13"
                    fontWeight="700"
                    fill="#0f172a"
                    fontFamily="Inter,system-ui,sans-serif"
                  >
                    {`${poly.pitch} · ${poly.facing}`}
                  </text>
                </g>
              ))}

              {/* Boundary/shared topology edges */}
              {topoEdges.map((edge, idx) => {
                const shared = edge.polyIndices.length > 1;
                const ownerIdx = edge.polyIndices[0] ?? 0;
                const ownerColor = reportPolygons[ownerIdx]?.color ?? '#334155';
                return (
                  <line
                    key={`topo-${idx}`}
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    stroke={shared ? '#94a3b8' : ownerColor}
                    strokeWidth={shared ? 1.1 : 1.9}
                    strokeLinecap="round"
                  />
                );
              })}

              {/* Structural edges */}
              {reportEdges.map(edge => (
                <line
                  key={edge.id}
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke={edge.color}
                  strokeWidth={edge.type === 'ridge' ? 2.2 : 1.8}
                  strokeDasharray={edge.dash.length >= 2 ? `${edge.dash[0]} ${edge.dash[1]}` : undefined}
                  strokeLinecap="round"
                />
              ))}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-slate-800 inline-block" />
              Boundary edge
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-[1.5px] border-slate-400 inline-block" />
              Shared edge (plane division)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-red-500 inline-block" />
              Ridge
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-blue-500 inline-block" />
              Valley
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-orange-500 inline-block" />
              Hip
            </span>
          </div>
        </div>
      )}

      {reportPolygons.length > 0 && (() => {
        const totalArea = reportPolygons.reduce((s, p) => s + p.areaSqFt, 0);
        const sorted = [...reportPolygons].sort((a, b) => b.areaSqFt - a.areaSqFt);
        const hasDsm = reportPolygons.some(p => p.isDsm);

        // Compass arrow: rotate a ↑ arrow to the facing direction
        const facingDeg: Record<string, number> = {
          N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
        };

        return (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-800">Segment breakdown</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Pitch · facing · area for each mapped roof plane — sorted largest first
                  {hasDsm && <span className="ml-1.5 text-cyan-600 font-medium">⚡ DSM values</span>}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Total mapped</p>
                <p className="text-sm font-bold text-slate-900">{totalArea.toLocaleString()} sq ft</p>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-4 py-2 font-semibold text-slate-500 w-8">#</th>
                    <th className="text-left px-4 py-2 font-semibold text-slate-500">Pitch</th>
                    <th className="text-left px-4 py-2 font-semibold text-slate-500">Facing</th>
                    <th className="text-right px-4 py-2 font-semibold text-slate-500">Area</th>
                    <th className="text-right px-4 py-2 font-semibold text-slate-500 pr-4">% of total</th>
                    <th className="px-4 py-2 w-32" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((poly, idx) => {
                    const pct = totalArea > 0 ? Math.round((poly.areaSqFt / totalArea) * 100) : 0;
                    const deg = facingDeg[poly.facing.toUpperCase()] ?? null;
                    return (
                      <tr
                        key={poly.id}
                        className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'}
                        style={{ borderLeft: `3px solid ${poly.color}` }}
                      >
                        {/* Index */}
                        <td className="px-3 py-2.5 text-slate-400 font-medium">{idx + 1}</td>

                        {/* Pitch badge */}
                        <td className="px-4 py-2.5">
                          <span
                            className="inline-block font-bold text-[11px] px-2 py-0.5 rounded"
                            style={{ backgroundColor: `${poly.color}22`, color: poly.color }}
                          >
                            {poly.pitch !== 'n/a' ? poly.pitch : '—'}
                          </span>
                        </td>

                        {/* Facing + compass arrow */}
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                            {deg !== null && (
                              <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: `rotate(${deg}deg)`, flexShrink: 0 }}>
                                <path d="M6 1 L8.5 9 L6 7.5 L3.5 9 Z" fill={poly.color} />
                              </svg>
                            )}
                            {poly.facing !== 'n/a' ? poly.facing : '—'}
                          </span>
                        </td>

                        {/* Area */}
                        <td className="px-4 py-2.5 text-right font-semibold text-slate-900">
                          {poly.areaSqFt > 0 ? `${poly.areaSqFt.toLocaleString()} sq ft` : '—'}
                        </td>

                        {/* % + bar */}
                        <td className="px-4 py-2.5 pr-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${pct}%`, backgroundColor: poly.color }}
                              />
                            </div>
                            <span className="text-slate-600 w-8 text-right">{pct}%</span>
                          </div>
                        </td>

                        {/* DSM badge */}
                        <td className="px-4 py-2.5">
                          {poly.isDsm && (
                            <span className="text-[10px] font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 px-1.5 py-0.5 rounded">
                              DSM
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Footer totals */}
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td colSpan={3} className="px-4 py-2 text-xs font-semibold text-slate-600">
                      {sorted.length} segment{sorted.length !== 1 ? 's' : ''}
                    </td>
                    <td className="px-4 py-2 text-right text-xs font-bold text-slate-900">
                      {totalArea.toLocaleString()} sq ft
                    </td>
                    <td colSpan={2} className="px-4 py-2 text-right text-xs font-semibold text-slate-500">100%</td>
                  </tr>
                </tfoot>
              </table>
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

            {/* Solar facet schematic — proportional plane layout */}
            {placedFacets.length > 0 && (() => {
              const xs = placedFacets.flatMap(f => [f.placement!.x, f.placement!.x + f.placement!.w]);
              const ys = placedFacets.flatMap(f => [f.placement!.y, f.placement!.y + f.placement!.h]);
              const pad = 24;
              const vbX = Math.min(...xs) - pad;
              const vbY = Math.min(...ys) - pad;
              const vbW = Math.max(...xs) - Math.min(...xs) + pad * 2;
              const vbH = Math.max(...ys) - Math.min(...ys) + pad * 2;
              const FC = FACET_COLORS;
              return (
                <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 overflow-hidden" data-pdf-keep-on-one-page data-pdf-no-scale>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold mb-2">Roof plane schematic — proportional to pitch &amp; area</p>
                  <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full h-auto rounded-lg" style={{ maxHeight: 300 }} overflow="visible">
                    {placedFacets.map((f, i) => {
                      const p = f.placement!;
                      const cx = p.x + p.w / 2;
                      const cy = p.y + p.h / 2;
                      const color = FC[i % FC.length];
                      const hasOutline = p.outlinePx && p.outlinePx.length >= 3;
                      const pts = hasOutline
                        ? p.outlinePx!.map(pt => `${p.x + pt.x},${p.y + pt.y}`).join(' ')
                        : `${p.x},${p.y} ${p.x+p.w},${p.y} ${p.x+p.w},${p.y+p.h} ${p.x},${p.y+p.h}`;
                      const fs = Math.max(7, Math.min(11, p.w / 9, p.h / 3));
                      return (
                        <g key={f.index}>
                          <polygon points={pts} fill={`${color}28`} stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
                          <text x={cx} y={cy - fs * 0.6} textAnchor="middle" fontSize={fs} fontWeight="600" fill="#0f172a" fontFamily="Inter,system-ui,sans-serif">{f.pitchLabel} · {f.facingLabel}</text>
                          <text x={cx} y={cy + fs * 1.1} textAnchor="middle" fontSize={Math.max(6, fs - 1.5)} fill="#475569" fontFamily="Inter,system-ui,sans-serif">{Math.round(f.actualAreaSqFt).toLocaleString()} sq ft</text>
                        </g>
                      );
                    })}
                  </svg>
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
                        <div className="relative w-20 h-20 shrink-0">
                          <img
                            src={photo.depthMapUrl}
                            alt="Depth map"
                            className="w-20 h-20 object-cover rounded-lg border border-violet-200 shadow-sm"
                            title="Depth Pro heat map"
                            onError={e => {
                              const img = e.currentTarget as HTMLImageElement;
                              img.style.display = 'none';
                              const sib = img.nextElementSibling as HTMLElement | null;
                              if (sib) sib.style.display = 'flex';
                            }}
                          />
                          {/* shown only when image fails to load */}
                          <div className="w-20 h-20 rounded-lg border border-violet-100 bg-violet-50 hidden flex-col items-center justify-center gap-0.5 absolute inset-0">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><path d="M12 2a10 10 0 1 1 0 20A10 10 0 0 1 12 2z"/><path d="M12 16v-4m0-4h.01"/></svg>
                            <span className="text-[8px] text-violet-400 text-center leading-tight px-1">Depth map<br/>unavailable</span>
                          </div>
                        </div>
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
