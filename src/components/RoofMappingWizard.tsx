/**
 * RoofMappingWizard – Three-phase AI + human roof analysis system.
 *
 * Phase 1: User draws roof outline → AI validates → user traces each segment
 *          → AI classifies each → AI detects all structural lines.
 * Phase 2: Multi-angle photo upload (top, front, back, left, right, street, 3D).
 *          Each photo is analyzed by Gemini for roof cues.
 * Phase 3: Combined final analysis merging structural map + photo results.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader } from '@googlemaps/js-api-loader';

// Shared loader singleton — must match the library list used in AnalysisPage
// (adding 'places' so this never conflicts with the parent page's loader).
let _mapsLoaderPromise: Promise<void> | null = null;
function ensureMapsLoaded(apiKey: string): Promise<void> {
  if (typeof window !== 'undefined' && typeof (window as typeof window & { google?: unknown }).google !== 'undefined') {
    return Promise.resolve();
  }
  if (!_mapsLoaderPromise) {
    const loader = new Loader({ apiKey, version: '3.64', libraries: ['places', 'drawing', 'geometry'] });
    _mapsLoaderPromise = loader.load().then(() => undefined);
  }
  return _mapsLoaderPromise;
}
import {
  X,
  ChevronRight,
  ChevronLeft,
  Brain,
  Camera,
  Check,
  Loader2,
  AlertCircle,
  Pencil,
  Trash2,
  Layers,
  RotateCcw,
  Map,
  FileImage,
  Star,
  ArrowRight,
  CheckCircle2,
  Download,
  Share2,
  FileSpreadsheet,
  Zap,
  Sparkles,
  Maximize2,
  ZoomIn,
  Navigation,
  Eye,
  EyeOff,
  Satellite,
  Undo2,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import type { Coordinates } from '../types';
import { formatArea } from '../utils/roofCalculations';
import type { SolarBuildingInsights, SolarDataLayersResponse } from '../utils/solar';
import { analyzeDsmForSegments, autoSegmentRoofPlanes, pitchDegToRatio, type DsmAnalysisResult } from '../utils/roofDsm';
import { analyzeSolarSegments, type RoofStructureAnalysis } from '../utils/roofStructure';
import { enrichDsmSegmentsWithSatelliteVision, type DsmVisionEnrichment } from '../utils/roofDsmVisionEnrich';
import { runPhotoDepthAnalysis, consensusDepthPitch, type PhotoDepthResult } from '../utils/roofPhotoDepth';
import {
  analyzeRoofOutline,
  analyzeRoofSegment,
  analyzeAllRoofSegments,
  detectRoofStructure,
  analyzeCombinedRoof,
  deriveVisionRoofCuesFromFile,
  latLngToImageNorm,
  type OutlineAnalysis,
  type SegmentAnalysis,
  type StructuralDetection,
  type StructuralLine,
  type RoofPhotoCueAnalysis,
} from '../utils/roofVision';
import { readGeminiApiKey } from '../utils/googleAiKey';
import {
  GEMINI_QUOTA_ERROR,
  formatGeminiQuotaUserMessage,
  isGemini429OrQuotaError,
  isGeminiQuotaPaused,
} from '../utils/gemini429';
import { shouldPreferOpenAiVision } from '../utils/aiProvider';
import { isDbConfigured, saveWizardWorkflowReport, type WizardWorkflowReportPayload } from '../utils/db';
import { buildRoofOutlineSnapshotDataUrl } from '../utils/wizardOutlineSnapshot';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import RoofVertexEdgeDrawer from './RoofVertexEdgeDrawer';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 1 | 2 | 3;

interface DrawnOutline {
  polygon: google.maps.Polygon;
  path: { lat: number; lng: number }[];
  analysis: OutlineAnalysis | null;
  analyzing: boolean;
}

interface DrawnSegment {
  id: string;
  index: number;
  polygon: google.maps.Polygon;
  path: { lat: number; lng: number }[];
  color: string;
  analysis: SegmentAnalysis | null;
  analyzing: boolean;
  /** Authoritative pitch/facing from DSM raster — set when segment comes from DSM Auto-Map */
  dsmPitchDeg?: number;
  dsmPitchRatio?: string;
  dsmFacingDirection?: string;
  dsmConfidence?: number;
}

/** Meters — max close radius; click within this of the first corner closes the outline (after ≥3 points). */
const OUTLINE_SKETCH_CLOSE_M = 9.0;
/** Meters — min close radius (floor for very small structures). */
const OUTLINE_SKETCH_CLOSE_MIN_M = 2.0;

function polyPathFromPolygon(poly: google.maps.Polygon): { lat: number; lng: number }[] {
  const path: { lat: number; lng: number }[] = [];
  poly.getPath().forEach(ll => path.push({ lat: ll.lat(), lng: ll.lng() }));
  return path;
}

/** Collapse nearly-identical vertices and redundant colinear points on a closed segment ring (save-time only). */
function dedupeSegmentPathForSave(points: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  const geom = typeof google !== 'undefined' ? google.maps?.geometry?.spherical : undefined;
  if (!geom || points.length < 3) return points;

  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    geom.computeDistanceBetween(new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(b.lat, b.lng));

  const MIN_GAP_M = 0.25;
  const COLINEAR_EXCESS_M = 0.12;

  let ring = points.map(p => ({ lat: p.lat, lng: p.lng }));

  for (let iter = 0; iter < ring.length + 8; iter++) {
    const prevLen = ring.length;
    const next: typeof ring = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (next.length === 0 || dist(next[next.length - 1], p) >= MIN_GAP_M) next.push(p);
    }
    ring = next;
    if (ring.length >= 2 && dist(ring[0], ring[ring.length - 1]) < MIN_GAP_M) ring.pop();
    if (ring.length === prevLen) break;
  }

  if (ring.length < 3) return points;

  for (let guard = 0; guard < ring.length + 24 && ring.length > 3; guard++) {
    let removed = false;
    for (let i = 0; i < ring.length; i++) {
      const A = ring[(i - 1 + ring.length) % ring.length];
      const B = ring[i];
      const C = ring[(i + 1) % ring.length];
      const dAB = dist(A, B);
      const dBC = dist(B, C);
      const dAC = dist(A, C);
      if (dAB < MIN_GAP_M || dBC < MIN_GAP_M) continue;
      if (dAB + dBC - dAC < COLINEAR_EXCESS_M) {
        ring.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }

  return ring.length >= 3 ? ring : points;
}

/** Reuse roof outline / existing segment corners when drawing a new segment. */
const SEGMENT_SHARED_VERTEX_SNAP_M = 4.5;
/** Snap clicks onto an existing edge so shared boundaries share one line (geodesic). */
const SEGMENT_SHARED_EDGE_SNAP_M = 7.0;

function closestPointOnGeodesicSegment(
  geom: { interpolate: (a: google.maps.LatLng, b: google.maps.LatLng, f: number) => google.maps.LatLng; computeDistanceBetween: (a: google.maps.LatLng, b: google.maps.LatLng) => number },
  a: google.maps.LatLng,
  b: google.maps.LatLng,
  p: google.maps.LatLng
): { point: google.maps.LatLng; dist: number } {
  let bestT = 0;
  let bestD = Infinity;
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const q = geom.interpolate(a, b, t);
    const d = geom.computeDistanceBetween(p, q);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let lo = Math.max(0, bestT - 0.03);
  let hi = Math.min(1, bestT + 0.03);
  for (let r = 0; r < 14; r++) {
    const t1 = lo + (hi - lo) / 3;
    const t2 = hi - (hi - lo) / 3;
    const d1 = geom.computeDistanceBetween(p, geom.interpolate(a, b, t1));
    const d2 = geom.computeDistanceBetween(p, geom.interpolate(a, b, t2));
    if (d1 < d2) hi = t2;
    else lo = t1;
  }
  bestT = (lo + hi) / 2;
  const point = geom.interpolate(a, b, bestT);
  return { point, dist: geom.computeDistanceBetween(p, point) };
}

function forEachPolygonRingEdge(
  path: google.maps.MVCArray<google.maps.LatLng>,
  fn: (a: google.maps.LatLng, b: google.maps.LatLng) => void
): void {
  const n = path.getLength();
  if (n < 2) return;
  for (let i = 0; i < n; i++) fn(path.getAt(i), path.getAt((i + 1) % n));
}

/** While drawing a segment: snap to outline / existing segments / prior sketch vertices. */
function snapSegmentSketchLatLng(
  raw: google.maps.LatLng,
  outlinePoly: google.maps.Polygon | null,
  neighborSegments: DrawnSegment[],
  sketchPathSoFar: google.maps.MVCArray<google.maps.LatLng> | null
): google.maps.LatLng {
  const geom = typeof google !== 'undefined' ? google.maps?.geometry?.spherical : undefined;
  if (!geom) return raw;

  type Hit = { ll: google.maps.LatLng; d: number };
  const vertexHits: Hit[] = [];
  const edgeHits: Hit[] = [];

  const pushVertex = (ll: google.maps.LatLng) => {
    const d = geom.computeDistanceBetween(raw, ll);
    if (d <= SEGMENT_SHARED_VERTEX_SNAP_M) vertexHits.push({ ll, d });
  };
  const pushEdge = (a: google.maps.LatLng, b: google.maps.LatLng) => {
    const { point, dist } = closestPointOnGeodesicSegment(geom, a, b, raw);
    if (dist <= SEGMENT_SHARED_EDGE_SNAP_M) edgeHits.push({ ll: point, d: dist });
  };

  if (outlinePoly) {
    const pth = outlinePoly.getPath();
    for (let i = 0; i < pth.getLength(); i++) pushVertex(pth.getAt(i));
    forEachPolygonRingEdge(pth, pushEdge);
  }
  for (const s of neighborSegments) {
    const pth = s.polygon.getPath();
    for (let i = 0; i < pth.getLength(); i++) pushVertex(pth.getAt(i));
    forEachPolygonRingEdge(pth, pushEdge);
  }
  if (sketchPathSoFar) {
    const n = sketchPathSoFar.getLength();
    for (let i = 0; i < n; i++) pushVertex(sketchPathSoFar.getAt(i));
  }

  if (vertexHits.length) {
    vertexHits.sort((u, v) => u.d - v.d);
    return vertexHits[0].ll;
  }
  if (edgeHits.length) {
    edgeHits.sort((u, v) => u.d - v.d);
    return edgeHits[0].ll;
  }
  return raw;
}

/** After closing a segment, move each corner onto outline / neighbor edges so borders line up exactly. */
function alignSegmentRingToNeighborGeometry(
  ring: { lat: number; lng: number }[],
  outlinePoly: google.maps.Polygon | null,
  neighborSegments: DrawnSegment[]
): { lat: number; lng: number }[] {
  const geom = typeof google !== 'undefined' ? google.maps?.geometry?.spherical : undefined;
  if (!geom || ring.length < 3) return ring;

  const vSnap = SEGMENT_SHARED_VERTEX_SNAP_M + 0.35;
  const eSnap = SEGMENT_SHARED_EDGE_SNAP_M + 0.45;

  return ring.map(p => {
    const raw = new google.maps.LatLng(p.lat, p.lng);
    type Hit = { ll: google.maps.LatLng; d: number };
    const vertexHits: Hit[] = [];
    const edgeHits: Hit[] = [];
    const pushVertex = (ll: google.maps.LatLng) => {
      const d = geom.computeDistanceBetween(raw, ll);
      if (d <= vSnap) vertexHits.push({ ll, d });
    };
    const pushEdge = (a: google.maps.LatLng, b: google.maps.LatLng) => {
      const { point, dist } = closestPointOnGeodesicSegment(geom, a, b, raw);
      if (dist <= eSnap) edgeHits.push({ ll: point, d: dist });
    };

    if (outlinePoly) {
      const pth = outlinePoly.getPath();
      for (let i = 0; i < pth.getLength(); i++) pushVertex(pth.getAt(i));
      forEachPolygonRingEdge(pth, pushEdge);
    }
    for (const s of neighborSegments) {
      const pth = s.polygon.getPath();
      for (let i = 0; i < pth.getLength(); i++) pushVertex(pth.getAt(i));
      forEachPolygonRingEdge(pth, pushEdge);
    }

    if (vertexHits.length) {
      vertexHits.sort((u, v) => u.d - v.d);
      const ll = vertexHits[0].ll;
      return { lat: ll.lat(), lng: ll.lng() };
    }
    if (edgeHits.length) {
      edgeHits.sort((u, v) => u.d - v.d);
      const ll = edgeHits[0].ll;
      return { lat: ll.lat(), lng: ll.lng() };
    }
    return { lat: p.lat, lng: p.lng };
  });
}

type PhotoSlotId = 'top' | 'front' | 'back' | 'left' | 'right' | 'street' | '3d';

interface PhotoSlot {
  id: PhotoSlotId;
  label: string;
  description: string;
  file: File | null;
  previewUrl: string | null;
  status: 'idle' | 'analyzing' | 'done' | 'error';
  analysis: RoofPhotoCueAnalysis | null;
  captureImageDataUrl?: string | null;
  capturedAtIso?: string | null;
  /** Depth Pro depth map colour image URL */
  depthMapUrl?: string | null;
  /** Depth-estimated pitch in degrees */
  depthPitchDeg?: number | null;
  /** Pitch as X/12 string */
  depthPitchRatio?: string | null;
  /** Depth analysis state */
  depthStatus?: 'idle' | 'analyzing' | 'done' | 'error';
  /** Full depth result for consensus computation */
  depthResult?: PhotoDepthResult | null;
}

interface CapturePreset {
  mode: 'satellite' | 'street';
  zoom?: number;
  tilt?: number;
  heading?: number;
  pitch?: number;
  fov?: number;
}

interface SegmentEdge {
  segmentIndex: number;
  edgeIndex: number;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  mid: { x: number; y: number };
  len: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEGMENT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#6366f1',
  '#14b8a6', '#a855f7',
];

const EDGE_COLORS: Record<StructuralLine['type'], string> = {
  ridge: '#ef4444',
  hip: '#f97316',
  valley: '#3b82f6',
  eave: '#22c55e',
  rake: '#a855f7',
  step: '#6b7280',
};

const EDGE_DASH_PATTERNS: Record<StructuralLine['type'], number[]> = {
  ridge: [],
  hip: [8, 4],
  valley: [4, 4],
  eave: [],
  rake: [12, 4],
  step: [4, 8],
};

function safeDashPattern(type: string): number[] {
  return EDGE_DASH_PATTERNS[type as StructuralLine['type']] ?? [];
}
function safeEdgeColor(type: string): string {
  return EDGE_COLORS[type as StructuralLine['type']] ?? '#94a3b8';
}

const INITIAL_PHOTO_SLOTS: PhotoSlot[] = [
  { id: 'top',    label: 'Top View',    description: 'Aerial/drone photo from directly above', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: 'front',  label: 'Front',       description: 'Ground-level front of the building', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: 'back',   label: 'Back',        description: 'Ground-level rear of the building', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: 'left',   label: 'Left Side',   description: 'Left side of the building', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: 'right',  label: 'Right Side',  description: 'Right side of the building', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: 'street', label: 'Street View', description: 'Street-level perspective', file: null, previewUrl: null, status: 'idle', analysis: null },
  { id: '3d',     label: '3D / Oblique', description: '45° oblique or 3D view', file: null, previewUrl: null, status: 'idle', analysis: null },
];

const PHOTO_CAPTURE_PRESETS: Record<PhotoSlotId, CapturePreset> = {
  top: { mode: 'satellite', zoom: 21, tilt: 0, heading: 0 },
  front: { mode: 'street', heading: 0, pitch: -4, fov: 90 },
  back: { mode: 'street', heading: 180, pitch: -4, fov: 90 },
  left: { mode: 'street', heading: 270, pitch: -2, fov: 85 },
  right: { mode: 'street', heading: 90, pitch: -2, fov: 85 },
  street: { mode: 'street', heading: 30, pitch: -3, fov: 95 },
  '3d': { mode: 'satellite', zoom: 20, tilt: 45, heading: 35 },
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  apiKey: string;
  address: string;
  coordinates: Coordinates;
  solarData: SolarBuildingInsights | null;
  solarDataLayers?: SolarDataLayersResponse | null;
  /** Link this wizard run to an existing project (skips address dedup). */
  existingProjectId?: string | null;
  /** True when user chose "Create new folder" — bypasses address-based dedup. */
  forceNewProject?: boolean;
  /** Fires after first successful save so parent can sync its projectId state. */
  onPersisted?: (projectId: string) => void;
  /** When true, auto-runs DSM plane detection as soon as solar data is available. */
  autoSegmentMode?: boolean;
  /** User label for a new project (from Save dialog). Stored as `project_name` on first save. */
  initialProjectFolderName?: string | null;
  /** Live list of completed / in-progress analyses for parent sidebar “project folder” UI. */
  onFolderManifestChange?: (entries: { id: string; label: string; done: boolean }[]) => void;
  /** Called after Save Project — parent should navigate to the New Analysis view. */
  onSaveAndNew?: () => void;
  onClose: () => void;
}

// ─── Helper components ────────────────────────────────────────────────────────

function PhaseTab({ phase, current, label, sublabel }: { phase: Phase; current: Phase; label: string; sublabel: string }) {
  const isActive = phase === current;
  const isDone = phase < current;
  return (
    <div className={`flex shrink-0 items-center gap-2 px-3 py-2 min-h-[44px] rounded-lg transition-all sm:px-4 ${
      isActive ? 'bg-blue-600 text-white' : isDone ? 'bg-green-600/20 text-green-400' : 'bg-slate-700/50 text-slate-400'
    }`}>
      <div className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
        isActive ? 'bg-white text-blue-600' : isDone ? 'bg-green-500 text-white' : 'bg-slate-600 text-slate-300'
      }`}>
        {isDone ? <Check size={12} /> : phase}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold whitespace-nowrap">{label}</div>
        <div className="text-xs opacity-70 hidden sm:block">{sublabel}</div>
      </div>
    </div>
  );
}

function QualityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'text-green-400' : pct >= 55 ? 'text-amber-400' : 'text-red-400';
  return <span className={`font-bold ${color}`}>{pct}%</span>;
}

/** White corner handles — match Google Maps drawing style (main vertices). */
function outlineSketchVertexIcon(): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 6,
    fillColor: '#ffffff',
    fillOpacity: 1,
    strokeColor: '#334155',
    strokeWeight: 1.5,
  };
}

/** Smaller semi-transparent dots mid-edge — like Maps “add a point here” handles while drawing. */
function outlineSketchMidpointIcon(): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 4,
    fillColor: '#ffffff',
    fillOpacity: 0.6,
    strokeColor: '#64748b',
    strokeWeight: 1,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RoofMappingWizard({ apiKey, address, coordinates, solarData, solarDataLayers, existingProjectId = null, forceNewProject = false, initialProjectFolderName = null, onPersisted, autoSegmentMode = false, onFolderManifestChange, onSaveAndNew, onClose }: Props) {
  // Map refs
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
  const outlineSketchPolylineRef = useRef<google.maps.Polyline | null>(null);
  const outlineSketchClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const outlineSketchDblClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const outlineSketchVertexMarkersRef = useRef<google.maps.Marker[]>([]);
  const outlineSketchPathListenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const outlineSketchPreviewPolylineRef = useRef<google.maps.Polyline | null>(null);
  const outlineSketchMouseMoveListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const outlineSketchCloseCircleRef = useRef<google.maps.Circle | null>(null);
  const outlineSketchCloseRadiusRef = useRef<number>(OUTLINE_SKETCH_CLOSE_M);
  const finalizeOutlineSketchRef = useRef<() => void>(() => {});

  const segmentSketchPolylineRef = useRef<google.maps.Polyline | null>(null);
  const segmentSketchPreviewPolylineRef = useRef<google.maps.Polyline | null>(null);
  const segmentSketchClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const segmentSketchDblClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const segmentSketchMouseMoveListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const segmentSketchPathListenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const segmentSketchVertexMarkersRef = useRef<google.maps.Marker[]>([]);
  const segmentSketchColorRef = useRef('#3b82f6');
  const segmentSketchCloseCircleRef = useRef<google.maps.Circle | null>(null);
  const finalizeSegmentSketchRef = useRef<() => void>(() => {});

  const structLinesRef = useRef<google.maps.Polyline[]>([]);
  const streetViewRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const labelsRef = useRef<google.maps.InfoWindow[]>([]);
  /** Keys: `'outline'`, `'segment:${id}'` — stays hidden after user closes that InfoWindow until Pins is toggled off then on. */
  const dismissedMapLabelsRef = useRef<Set<string>>(new Set());
  /** Ignore `closeclick` while effect replaces InfoWindows so user dismiss state is not polluted. */
  const suppressLabelCloseDismissRef = useRef(false);
  /**
   * DB `projects.id` for this wizard session. Synced from `existingProjectId` and set as soon as a save
   * returns so rapid autosaves never call `saveWizardWorkflowReport` without a project id (which, with
   * `forceNewProject`, would INSERT a new row every time).
   */
  const wizardLinkedProjectIdRef = useRef<string | null>(existingProjectId?.trim() ? existingProjectId.trim() : null);
  useEffect(() => {
    const p = existingProjectId?.trim();
    if (p) wizardLinkedProjectIdRef.current = p;
  }, [existingProjectId]);

  // ── Sequential segment-analysis queue ──────────────────────────────────────
  // All analyzeRoofSegment calls go through this queue so we never fire more
  // than one Gemini request at a time (prevents rate-limit failures when many
  // segments are committed at once).
  const segAnalysisQueueRef   = useRef<Array<() => Promise<void>>>([]);
  const segAnalysisActiveRef  = useRef(false);

  const [geminiQuotaNotice, setGeminiQuotaNotice] = useState<string | null>(null);

  const stopAnalyzingForQuota = useCallback(() => {
    setGeminiQuotaNotice(formatGeminiQuotaUserMessage());
    setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
    setOutline(o => (o?.analyzing ? { ...o, analyzing: false } : o));
  }, []);

  useEffect(() => {
    const sync = () => {
      setGeminiQuotaNotice(isGeminiQuotaPaused() ? formatGeminiQuotaUserMessage() : null);
    };
    sync();
    const id = window.setInterval(sync, 30_000);
    return () => clearInterval(id);
  }, []);

  const isQuotaFailure = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg === GEMINI_QUOTA_ERROR || isGemini429OrQuotaError(err) || /\b429\b|quota exceeded/i.test(msg);
  };

  const drainSegAnalysisQueue = useCallback(async () => {
    if (segAnalysisActiveRef.current) return;
    segAnalysisActiveRef.current = true;
    while (segAnalysisQueueRef.current.length > 0) {
      if (isGeminiQuotaPaused()) {
        segAnalysisQueueRef.current.length = 0;
        stopAnalyzingForQuota();
        break;
      }
      const task = segAnalysisQueueRef.current.shift();
      if (!task) break;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await Promise.race([
            task(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('QUEUE_TASK_TIMEOUT')), 90_000)
            ),
          ]);
          break;
        } catch (err) {
          console.warn(`[RoofWizard] seg-analysis attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
          if (isQuotaFailure(err)) {
            stopAnalyzingForQuota();
            segAnalysisQueueRef.current.length = 0;
            break;
          }
          if (attempt < 1) await new Promise<void>(r => setTimeout(r, 3_000));
        }
      }
      // Pace between calls to avoid 429 rate limits
      if (segAnalysisQueueRef.current.length > 0) {
        await new Promise<void>(r => setTimeout(r, 1_500));
      }
    }
    segAnalysisActiveRef.current = false;
  }, [stopAnalyzingForQuota]);

  const enqueueSegAnalysis = useCallback((task: () => Promise<void>) => {
    if (isGeminiQuotaPaused()) {
      stopAnalyzingForQuota();
      return;
    }
    segAnalysisQueueRef.current.push(task);
    void drainSegAnalysisQueue();
  }, [drainSegAnalysisQueue, stopAnalyzingForQuota]);

  // ── localStorage draft helpers ──────────────────────────────────────────────
  const draftKey = `roofiq_wizard_draft_${address.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;

  function loadDraft() {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      return JSON.parse(raw) as {
        phase: number;
        step1Sub: string;
        outlinePath: { lat: number; lng: number }[] | null;
        segmentPaths: { id: string; index: number; path: { lat: number; lng: number }[]; color: string; analysis: SegmentAnalysis | null; dsmPitchDeg?: number; dsmPitchRatio?: string; dsmFacingDirection?: string; dsmConfidence?: number }[];
      };
    } catch { return null; }
  }

  // State — restored from localStorage draft if available
  const [phase, setPhase] = useState<Phase>(1);
  /** Always start on Outline; DSM auto-map runs only after outline exists and user opens Segments. */
  const [step1Sub, setStep1Sub] = useState<'outline' | 'segments' | 'structure'>('outline');
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [mapType, setMapType] = useState<'satellite' | 'hybrid'>('satellite');
  const [tilt, setTilt] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const wasShowLabelsRef = useRef(showLabels);
  const [showStreetView, setShowStreetView] = useState(false);
  const [streetViewAvailable, setStreetViewAvailable] = useState(false);
  const [outlineSketchMode, setOutlineSketchMode] = useState(false);
  const [outlineSketchPointCount, setOutlineSketchPointCount] = useState(0);
  const [segmentSketchMode, setSegmentSketchMode] = useState(false);
  const [segmentSketchPointCount, setSegmentSketchPointCount] = useState(0);
  const [vertexEdgeActive, setVertexEdgeActive] = useState(false);

  const [outline, setOutline] = useState<DrawnOutline | null>(null);
  const [segments, setSegments] = useState<DrawnSegment[]>([]);
  // Mirror segments in a ref so callbacks can read current value without stale closures
  const segmentsRef = useRef<DrawnSegment[]>([]);
  segmentsRef.current = segments;
  const [structureResult, setStructureResult] = useState<StructuralDetection | null>(null);
  const [structureAnalyzing, setStructureAnalyzing] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [structureSource, setStructureSource] = useState<'ai' | 'fallback' | null>(null);

  const [dsmResult, setDsmResult] = useState<DsmAnalysisResult | null>(null);
  const [dsmAnalyzing, setDsmAnalyzing] = useState(false);
  const [dsmError, setDsmError] = useState<string | null>(null);

  const [autoSegmenting, setAutoSegmenting] = useState(false);
  const autoSegmentRanRef = useRef(false);
  /** DSM Auto-Map: one-shot trigger after user advances to Segments (avoids mount-time skip + effect retry loops on failure). */
  const pendingAutoSegmentAfterOutlineRef = useRef(false);
  const dsmVisionEnrichAppliedRef = useRef(false);

  const [photoSlots, setPhotoSlots] = useState<PhotoSlot[]>(INITIAL_PHOTO_SLOTS);
  const [activeCaptureSlot, setActiveCaptureSlot] = useState<PhotoSlotId>('top');
  const [photoStepError, setPhotoStepError] = useState<string | null>(null);

  const [finalAnalysis, setFinalAnalysis] = useState<Awaited<ReturnType<typeof analyzeCombinedRoof>>>(null);
  const [finalAnalyzing, setFinalAnalyzing] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  const [finalSource, setFinalSource] = useState<'ai' | 'fallback' | null>(null);
  const [showFullReport, setShowFullReport] = useState(false);
  const persistStatusRef = useRef<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [persistStatus, _setPersistStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const setPersistStatus = useCallback((s: 'idle' | 'saving' | 'saved' | 'error') => {
    persistStatusRef.current = s;
    _setPersistStatus(s);
  }, []);
  const [quoteDraftSaved, setQuoteDraftSaved] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);

  /** Append one history run on the next persistence cycle (consumed by the auto-save effect). */
  const appendHistoryNextRef = useRef(false);
  /** Used to trigger the auto-save effect to run once more on explicit actions. */
  const [historySaveNonce, setHistorySaveNonce] = useState(0);

  // Satellite image cache for Gemini calls
  const satelliteImageRef = useRef<{ data: string; mimeType: string } | null>(null);
  const [imageReady, setImageReady] = useState(false);

  const hasGeminiKey = !!readGeminiApiKey();
  const [hasServerOpenAi, setHasServerOpenAi] = useState(false);
  const hasAiVision = hasGeminiKey || hasServerOpenAi;

  useEffect(() => {
    void shouldPreferOpenAiVision().then(setHasServerOpenAi);
  }, []);

  const waitForSatelliteImage = useCallback(async (maxMs = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const r = satelliteImageRef.current;
      if (r?.data && r.data.length > 100) return r;
      await new Promise<void>(res => {
        window.setTimeout(res, 350);
      });
    }
    return satelliteImageRef.current?.data ? satelliteImageRef.current : null;
  }, []);

  // ── Map initialization ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!apiKey || !mapRef.current) return;
    let cancelled = false;

    ensureMapsLoaded(apiKey).then(() => {
      if (cancelled || !mapRef.current) return;
      try {
        const map = new google.maps.Map(mapRef.current, {
          center: coordinates,
          zoom: 20,
          mapTypeId: 'satellite',
          tilt: 0,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
          gestureHandling: 'greedy',
        });
        mapInstanceRef.current = map;

        const dm = new google.maps.drawing.DrawingManager({
          drawingMode: null,
          drawingControl: false,
          polygonOptions: {
            fillColor: '#3b82f6',
            fillOpacity: 0.25,
            strokeColor: '#2563eb',
            strokeWeight: 2.5,
            editable: true,
            draggable: false,
          },
        });
        dm.setMap(map);
        drawingManagerRef.current = dm;

        setMapLoaded(true);
      } catch {
        if (!cancelled) setMapError('Failed to initialize map.');
      }
    }).catch(() => {
      if (!cancelled) setMapError('Failed to load Google Maps.');
    });

    return () => {
      cancelled = true;
      labelsRef.current.forEach(iw => iw.close());
      labelsRef.current = [];
      panoramaRef.current = null;
      if (outlineSketchMouseMoveListenerRef.current) {
        google.maps.event.removeListener(outlineSketchMouseMoveListenerRef.current);
        outlineSketchMouseMoveListenerRef.current = null;
      }
      outlineSketchPreviewPolylineRef.current?.setMap(null);
      outlineSketchPreviewPolylineRef.current = null;
      if (outlineSketchClickListenerRef.current) {
        google.maps.event.removeListener(outlineSketchClickListenerRef.current);
        outlineSketchClickListenerRef.current = null;
      }
      outlineSketchPathListenersRef.current.forEach(l => google.maps.event.removeListener(l));
      outlineSketchPathListenersRef.current = [];
      outlineSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
      outlineSketchVertexMarkersRef.current = [];
      outlineSketchPolylineRef.current?.setMap(null);
      outlineSketchPolylineRef.current = null;

      if (segmentSketchMouseMoveListenerRef.current) {
        google.maps.event.removeListener(segmentSketchMouseMoveListenerRef.current);
        segmentSketchMouseMoveListenerRef.current = null;
      }
      if (segmentSketchClickListenerRef.current) {
        google.maps.event.removeListener(segmentSketchClickListenerRef.current);
        segmentSketchClickListenerRef.current = null;
      }
      segmentSketchPathListenersRef.current.forEach(l => google.maps.event.removeListener(l));
      segmentSketchPathListenersRef.current = [];
      segmentSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
      segmentSketchVertexMarkersRef.current = [];
      segmentSketchPreviewPolylineRef.current?.setMap(null);
      segmentSketchPreviewPolylineRef.current = null;
      segmentSketchPolylineRef.current?.setMap(null);
      segmentSketchPolylineRef.current = null;
      outline?.polygon.setMap(null);
      segments.forEach(s => s.polygon.setMap(null));
      clearStructureLines();
      drawingManagerRef.current?.setMap(null);
      drawingManagerRef.current = null;
      mapInstanceRef.current = null;
      if (mapRef.current) mapRef.current.innerHTML = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // ── Auto-save draft to localStorage ────────────────────────────────────────
  useEffect(() => {
    try {
      const draft = {
        phase,
        step1Sub,
        outlinePath: outline?.path ?? null,
        segmentPaths: segments.map(s => ({
          id: s.id,
          index: s.index,
          path: s.path,
          color: s.color,
          analysis: s.analysis,
          dsmPitchDeg: s.dsmPitchDeg,
          dsmPitchRatio: s.dsmPitchRatio,
          dsmFacingDirection: s.dsmFacingDirection,
          dsmConfidence: s.dsmConfidence,
        })),
      };
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch { /* storage full or unavailable */ }
  }, [phase, step1Sub, outline, segments, draftKey]);

  // ── Restore draft polygons onto map after map loads ─────────────────────────
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current) return;
    const draft = loadDraft();
    if (!draft) return;

    const map = mapInstanceRef.current;

    // Restore step position
    if (draft.phase && draft.phase >= 1) setPhase(draft.phase as Phase);
    if (draft.step1Sub) setStep1Sub(draft.step1Sub as 'outline' | 'segments' | 'structure');

    // Restore outline polygon
    if (draft.outlinePath && draft.outlinePath.length >= 3) {
      const polygon = new google.maps.Polygon({
        paths: draft.outlinePath,
        fillColor: '#3b82f6',
        fillOpacity: 0.15,
        strokeColor: '#2563eb',
        strokeWeight: 2,
        editable: true,
        draggable: false,
        map,
      });
      setOutline({ polygon, path: draft.outlinePath, analysis: null, analyzing: false });
    }

    // Restore segment polygons
    if (draft.segmentPaths.length > 0) {
      const restored: DrawnSegment[] = draft.segmentPaths.map(s => {
        const polygon = new google.maps.Polygon({
          paths: s.path,
          fillColor: s.color,
          fillOpacity: 0.35,
          strokeColor: s.color,
          strokeWeight: 2,
          editable: true,
          draggable: false,
          map,
        });
        return { id: s.id, index: s.index, polygon, path: s.path, color: s.color, analysis: s.analysis, analyzing: false, dsmPitchDeg: s.dsmPitchDeg, dsmPitchRatio: s.dsmPitchRatio, dsmFacingDirection: s.dsmFacingDirection, dsmConfidence: s.dsmConfidence };
      });
      setSegments(restored);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  // ── Fetch satellite image for Gemini once map is loaded ─────────────────────

  useEffect(() => {
    if (!mapLoaded || !apiKey) return;
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;

    const tryFetch = async (u: string) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size < 400) throw new Error('too small');
      return blob;
    };

    const proxyUrl = `${window.location.origin}/api/proxy-static-map?u=${encodeURIComponent(url)}`;

    (async () => {
      try {
        let blob: Blob;
        try { blob = await tryFetch(proxyUrl); }
        catch { blob = await tryFetch(url); }

        const reader = new FileReader();
        reader.onloadend = () => {
          const raw = reader.result as string;
          const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
          if (base64) {
            satelliteImageRef.current = { data: base64, mimeType: blob.type || 'image/png' };
            setImageReady(true);
          }
        };
        reader.readAsDataURL(blob);
      } catch {
        // Proceed without satellite image — Gemini calls will skip image part
        setImageReady(true);
      }
    })();
  }, [mapLoaded, apiKey, coordinates.lat, coordinates.lng]);

  // ── Drawing helpers ─────────────────────────────────────────────────────────

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
    drawingManagerRef.current?.setDrawingMode(null);
  }, []);

  const applyCompletedOutlinePolygon = useCallback(
    async (polygon: google.maps.Polygon) => {
      stopDrawing();
      polygon.setOptions({ fillColor: '#f97316', strokeColor: '#ea580c', editable: true });
      setOutline(prev => {
        prev?.polygon.setMap(null);
        return null;
      });

      const pathPts = polyPathFromPolygon(polygon);
      const newOutline: DrawnOutline = { polygon, path: pathPts, analysis: null, analyzing: hasAiVision };
      setOutline(newOutline);

      if (!hasAiVision) return;

      const normalized = pathPts.map(p => latLngToImageNorm(p, coordinates, 20, 640));
      const imgData = satelliteImageRef.current;

      try {
        const analysis = await analyzeRoofOutline(imgData, normalized);
        setOutline(prev => (prev ? { ...prev, analysis, analyzing: false } : prev));
      } catch {
        setOutline(prev => (prev ? { ...prev, analyzing: false } : prev));
      }
    },
    [stopDrawing, hasAiVision, coordinates]
  );

  const clearOutlineSketch = useCallback(() => {
    if (outlineSketchMouseMoveListenerRef.current) {
      google.maps.event.removeListener(outlineSketchMouseMoveListenerRef.current);
      outlineSketchMouseMoveListenerRef.current = null;
    }
    if (outlineSketchDblClickListenerRef.current) {
      google.maps.event.removeListener(outlineSketchDblClickListenerRef.current);
      outlineSketchDblClickListenerRef.current = null;
    }
    outlineSketchCloseCircleRef.current?.setMap(null);
    outlineSketchCloseCircleRef.current = null;
    outlineSketchPreviewPolylineRef.current?.setMap(null);
    outlineSketchPreviewPolylineRef.current = null;
    outlineSketchPathListenersRef.current.forEach(l => google.maps.event.removeListener(l));
    outlineSketchPathListenersRef.current = [];
    outlineSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
    outlineSketchVertexMarkersRef.current = [];
    if (outlineSketchClickListenerRef.current) {
      google.maps.event.removeListener(outlineSketchClickListenerRef.current);
      outlineSketchClickListenerRef.current = null;
    }
    outlineSketchPolylineRef.current?.setMap(null);
    outlineSketchPolylineRef.current = null;
    setOutlineSketchMode(false);
    setOutlineSketchPointCount(0);
    setIsDrawing(false);
  }, []);

  const finalizeOutlineSketch = useCallback(() => {
    const polyline = outlineSketchPolylineRef.current;
    const map = mapInstanceRef.current;
    if (!polyline || !map) return;
    const path = polyline.getPath();
    if (path.getLength() < 3) return;

    if (outlineSketchClickListenerRef.current) {
      google.maps.event.removeListener(outlineSketchClickListenerRef.current);
      outlineSketchClickListenerRef.current = null;
    }
    if (outlineSketchDblClickListenerRef.current) {
      google.maps.event.removeListener(outlineSketchDblClickListenerRef.current);
      outlineSketchDblClickListenerRef.current = null;
    }
    if (outlineSketchMouseMoveListenerRef.current) {
      google.maps.event.removeListener(outlineSketchMouseMoveListenerRef.current);
      outlineSketchMouseMoveListenerRef.current = null;
    }
    outlineSketchCloseCircleRef.current?.setMap(null);
    outlineSketchCloseCircleRef.current = null;
    outlineSketchPreviewPolylineRef.current?.setMap(null);
    outlineSketchPreviewPolylineRef.current = null;
    outlineSketchPathListenersRef.current.forEach(l => google.maps.event.removeListener(l));
    outlineSketchPathListenersRef.current = [];
    outlineSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
    outlineSketchVertexMarkersRef.current = [];

    const closedPath = path.getArray().map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
    polyline.setMap(null);
    outlineSketchPolylineRef.current = null;
    const polygon = new google.maps.Polygon({
      paths: closedPath,
      fillColor: '#f97316',
      strokeColor: '#ea580c',
      fillOpacity: 0.2,
      strokeWeight: 2.5,
      editable: true,
      draggable: false,
      map,
    });

    setOutlineSketchMode(false);
    setIsDrawing(false);
    setOutlineSketchPointCount(0);

    void applyCompletedOutlinePolygon(polygon);
  }, [applyCompletedOutlinePolygon]);

  finalizeOutlineSketchRef.current = finalizeOutlineSketch;

  const undoOutlineSketchLastPoint = useCallback(() => {
    const pl = outlineSketchPolylineRef.current;
    if (!pl) return;
    const path = pl.getPath();
    const n = path.getLength();
    if (n === 0) return;
    path.removeAt(n - 1);
    // insert_at / remove_at listeners refresh dots and point count
  }, []);

  const startOutlineSketch = useCallback(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapLoaded || step1Sub !== 'outline' || phase !== 1) return;

    drawingManagerRef.current?.setDrawingMode(null);
    clearOutlineSketch();
    setOutline(prev => {
      prev?.polygon.setMap(null);
      return null;
    });

    const path = new google.maps.MVCArray<google.maps.LatLng>();
    const polyline = new google.maps.Polyline({
      path,
      strokeColor: '#ea580c',
      strokeOpacity: 1,
      strokeWeight: 2.5,
      clickable: false,
      zIndex: 3,
      map,
    });
    outlineSketchPolylineRef.current = polyline;

    const previewPath = new google.maps.MVCArray<google.maps.LatLng>();
    const previewPolyline = new google.maps.Polyline({
      path: previewPath,
      strokeColor: '#fdba74',
      strokeOpacity: 0.98,
      strokeWeight: 2.5,
      zIndex: 4,
      clickable: false,
      map,
      icons: [
        {
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
          offset: '0',
          repeat: '10px',
        },
      ],
    });
    outlineSketchPreviewPolylineRef.current = previewPolyline;

    const moveListener = map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
      previewPath.clear();
      if (!e.latLng) return;
      const n = path.getLength();
      if (n >= 1) {
        previewPath.push(path.getAt(n - 1));
        previewPath.push(e.latLng);
      }
    });
    outlineSketchMouseMoveListenerRef.current = moveListener;

    const refreshOutlineSketchDots = () => {
      outlineSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
      outlineSketchVertexMarkersRef.current = [];
      const g = mapInstanceRef.current;
      if (!g) return;
      const n = path.getLength();
      const hasGeom = typeof google !== 'undefined' && !!google.maps?.geometry?.spherical;

      for (let i = 0; i < n; i++) {
        outlineSketchVertexMarkersRef.current.push(
          new google.maps.Marker({
            position: path.getAt(i),
            map: g,
            icon: outlineSketchVertexIcon(),
            zIndex: (google.maps.Marker.MAX_ZINDEX ?? 1000000) + 2,
            clickable: false,
            draggable: false,
          })
        );
      }

      if (hasGeom) {
        for (let i = 0; i < n - 1; i++) {
          const a = path.getAt(i);
          const b = path.getAt(i + 1);
          const mid = google.maps.geometry.spherical.interpolate(a, b, 0.5);
          outlineSketchVertexMarkersRef.current.push(
            new google.maps.Marker({
              position: mid,
              map: g,
              icon: outlineSketchMidpointIcon(),
              zIndex: (google.maps.Marker.MAX_ZINDEX ?? 1000000) + 1,
              clickable: false,
              draggable: false,
            })
          );
        }
      }

      setOutlineSketchPointCount(path.getLength());
    };

    const pathEvents: Array<'insert_at' | 'remove_at' | 'set_at'> = ['insert_at', 'remove_at', 'set_at'];
    for (const ev of pathEvents) {
      outlineSketchPathListenersRef.current.push(
        google.maps.event.addListener(path, ev, () => refreshOutlineSketchDots())
      );
    }

    const updateCloseCircle = () => {
      const n = path.getLength();
      if (n >= 3) {
        const first = path.getAt(0);
        let minDist = Infinity;
        for (let i = 1; i < n; i++) {
          const d = google.maps.geometry.spherical.computeDistanceBetween(first, path.getAt(i));
          if (d < minDist) minDist = d;
        }
        const adaptiveRadius = Math.max(
          OUTLINE_SKETCH_CLOSE_MIN_M,
          Math.min(OUTLINE_SKETCH_CLOSE_M, minDist * 0.35),
        );
        outlineSketchCloseRadiusRef.current = adaptiveRadius;
        if (!outlineSketchCloseCircleRef.current) {
          outlineSketchCloseCircleRef.current = new google.maps.Circle({
            center: first,
            radius: adaptiveRadius,
            strokeColor: '#22c55e',
            strokeOpacity: 0.85,
            strokeWeight: 2,
            fillColor: '#22c55e',
            fillOpacity: 0.18,
            clickable: false,
            zIndex: 5,
            map,
          });
        } else {
          outlineSketchCloseCircleRef.current.setCenter(first);
          outlineSketchCloseCircleRef.current.setRadius(adaptiveRadius);
          outlineSketchCloseCircleRef.current.setMap(map);
        }
      } else {
        outlineSketchCloseCircleRef.current?.setMap(null);
        outlineSketchCloseRadiusRef.current = OUTLINE_SKETCH_CLOSE_M;
      }
    };

    const listener = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const len = path.getLength();
      if (
        len >= 3 &&
        google.maps.geometry.spherical.computeDistanceBetween(path.getAt(0), e.latLng) <= outlineSketchCloseRadiusRef.current
      ) {
        finalizeOutlineSketchRef.current();
        return;
      }
      path.push(e.latLng);
      updateCloseCircle();
    });
    outlineSketchClickListenerRef.current = listener;

    // Double-click anywhere (with ≥3 pts) also closes the polygon
    const dblListener = map.addListener('dblclick', (e: google.maps.MapMouseEvent) => {
      e.stop?.();
      if (path.getLength() >= 3) finalizeOutlineSketchRef.current();
    });
    outlineSketchDblClickListenerRef.current = dblListener;

    refreshOutlineSketchDots();

    setOutlineSketchMode(true);
    setIsDrawing(true);
  }, [mapLoaded, step1Sub, phase, clearOutlineSketch]);

  useEffect(() => {
    if (step1Sub !== 'outline' || phase !== 1) {
      clearOutlineSketch();
    }
  }, [step1Sub, phase, clearOutlineSketch]);

  useEffect(() => {
    if (!outlineSketchMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearOutlineSketch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        undoOutlineSketchLastPoint();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [outlineSketchMode, clearOutlineSketch, undoOutlineSketchLastPoint]);

  const clearSegmentSketch = useCallback(() => {
    if (segmentSketchClickListenerRef.current) {
      google.maps.event.removeListener(segmentSketchClickListenerRef.current);
      segmentSketchClickListenerRef.current = null;
    }
    if (segmentSketchDblClickListenerRef.current) {
      google.maps.event.removeListener(segmentSketchDblClickListenerRef.current);
      segmentSketchDblClickListenerRef.current = null;
    }
    if (segmentSketchMouseMoveListenerRef.current) {
      google.maps.event.removeListener(segmentSketchMouseMoveListenerRef.current);
      segmentSketchMouseMoveListenerRef.current = null;
    }
    segmentSketchCloseCircleRef.current?.setMap(null);
    segmentSketchCloseCircleRef.current = null;
    segmentSketchPathListenersRef.current.forEach(l => google.maps.event.removeListener(l));
    segmentSketchPathListenersRef.current = [];
    segmentSketchVertexMarkersRef.current.forEach(m => m.setMap(null));
    segmentSketchVertexMarkersRef.current = [];
    segmentSketchPreviewPolylineRef.current?.setMap(null);
    segmentSketchPreviewPolylineRef.current = null;
    segmentSketchPolylineRef.current?.setMap(null);
    segmentSketchPolylineRef.current = null;
    setSegmentSketchMode(false);
    setSegmentSketchPointCount(0);
    setIsDrawing(false);
    outline?.polygon.setOptions({ clickable: true });
    segments.forEach(s => s.polygon.setOptions({ clickable: true }));
  }, [outline, segments]);

  const undoSegmentSketchLastPoint = useCallback(() => {
    const pl = segmentSketchPolylineRef.current;
    if (!pl) return;
    const path = pl.getPath();
    if (path.getLength() === 0) return;
    path.removeAt(path.getLength() - 1);
  }, []);

  // Called when DrawingManager fires polygoncomplete for a segment.
  const commitDrawnPolygon = useCallback((drawnPolygon: google.maps.Polygon) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // Stop DrawingManager and clean up sketch state
    drawingManagerRef.current?.setDrawingMode(null);
    clearSegmentSketch();

    const color = segmentSketchColorRef.current;

    // Apply snap alignment so shared edges line up with the outline/existing segments
    const closedPathRaw = drawnPolygon.getPath().getArray().map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
    drawnPolygon.setMap(null); // remove the DrawingManager version; we'll create our own below

    let closedPath = dedupeSegmentPathForSave(closedPathRaw);
    closedPath = alignSegmentRingToNeighborGeometry(closedPath, outline?.polygon ?? null, segments);
    closedPath = dedupeSegmentPathForSave(closedPath);
    if (closedPath.length < 3) closedPath = dedupeSegmentPathForSave(closedPathRaw);

    const polygon = new google.maps.Polygon({
      paths: closedPath,
      fillColor: color,
      strokeColor: color,
      fillOpacity: 0.22,
      strokeWeight: 2.5,
      editable: true,
      draggable: false,
      map,
    });

    const id = `seg_${Date.now()}`;
    const pathPts = polyPathFromPolygon(polygon);
    // Read current segments from ref so we don't need segments in deps (avoids stale closure)
    const currentSegs = segmentsRef.current;
    const idx = currentSegs.length;

    const newSeg: DrawnSegment = {
      id,
      index: idx,
      polygon,
      path: pathPts,
      color,
      analysis: null,
      analyzing: hasAiVision,
    };

    setSegments(prev => [...prev, newSeg]);

    // Batch-analyze ALL segments in one API call (1 call total instead of N).
    // When a new segment is committed, re-run batch analysis on every segment
    // that still needs analysis — this uses just 1 quota unit regardless of count.
    if (hasAiVision) {
      const batchId = Date.now();

      // Skip enqueue if a batch is already waiting — it reads segmentsRef at execution time
      // so it will pick up this newly committed segment automatically.
      if (segAnalysisQueueRef.current.length === 0) {
      enqueueSegAnalysis(async () => {
        // Read current segments from ref at execution time (state may have updated)
        const currentSegs = segmentsRef.current;
        const unanalyzed = currentSegs.filter(s => !s.analysis && s.analyzing);
        if (unanalyzed.length === 0) {
          setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
          return;
        }
        // Wait for satellite image to load (captures fresh ref, not stale enqueue-time value)
        const imgData = await waitForSatelliteImage(8_000);
        const allNorm = currentSegs.map(s => s.path.map(p => latLngToImageNorm(p, coordinates, 20, 640)));
        console.log(`[RoofWizard] Batch-analyzing ${unanalyzed.length} segments in 1 call (batch ${batchId})`);
        return analyzeAllRoofSegments(imgData, allNorm)
          .then(results => {
            console.log(`[RoofWizard] Batch ${batchId} result:`, results ? `${results.length} segments` : 'NULL');
            if (results && results.length > 0) {
              setSegments(curr => {
                return curr.map((seg, i) => {
                  const match = results.find(r => r.index === i);
                  if (match && (seg.analyzing || !seg.analysis)) {
                    return { ...seg, analysis: match, analyzing: false };
                  }
                  if (seg.analyzing && !seg.analysis) {
                    return { ...seg, analyzing: false };
                  }
                  return seg;
                });
              });
            } else {
              setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
            }
          })
          .catch(err => {
            console.warn(`[RoofWizard] Batch ${batchId} error:`, err);
            setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
          });
      });
      } // end: segAnalysisQueueRef.current.length === 0
    }
  }, [hasAiVision, coordinates, outline, clearSegmentSketch, enqueueSegAnalysis, waitForSatelliteImage]);

  // Keep ref in sync so startSegmentSketch closure always calls the latest version
  finalizeSegmentSketchRef.current = () => {}; // unused now — kept to avoid TS errors on callers

  // Called when RoofVertexEdgeDrawer finishes — convert detected faces to DrawnSegments.
  // Vertex positions are kept exactly as placed — no snapping or alignment applied.
  const onVertexEdgeDone = useCallback((faces: Array<{ path: { lat: number; lng: number }[] }>) => {
    setVertexEdgeActive(false);
    const map = mapInstanceRef.current;
    if (!map || faces.length === 0) return;

    // Read current segments from ref to get stable snapshot (avoids stale closure)
    const currentSegs = segmentsRef.current;
    const startIdx = currentSegs.length;

    // Build all segments BEFORE calling setSegments,
    // so we never run side effects inside a state updater.
    const added: DrawnSegment[] = [];
    const now = Date.now();

    faces.forEach((face, fi) => {
      const closedPath = face.path;
      if (closedPath.length < 3) return;

      const color = SEGMENT_COLORS[(startIdx + fi) % SEGMENT_COLORS.length];
      const polygon = new google.maps.Polygon({
        paths: closedPath,
        fillColor: color,
        strokeColor: color,
        fillOpacity: 0.22,
        strokeWeight: 2.5,
        editable: true,
        draggable: false,
        map,
      });

      const id = `seg_${now}_${fi}`;
      const idx = startIdx + fi;
      const newSeg: DrawnSegment = { id, index: idx, polygon, path: closedPath, color, analysis: null, analyzing: hasAiVision };
      added.push(newSeg);
    });

    if (added.length === 0) return;
    setSegments(prev => [...prev, ...added]);

    // Batch-analyze ALL segments (existing + new) in one API call
    if (hasAiVision && added.length > 0) {
      const imgData = satelliteImageRef.current;
      const batchId = Date.now();

      enqueueSegAnalysis(() => {
        const currentSegs = segmentsRef.current;
        const allNorm = currentSegs.map(s => s.path.map(p => latLngToImageNorm(p, coordinates, 20, 640)));
        console.log(`[RoofWizard] VertexEdge batch-analyzing ${currentSegs.length} segments in 1 call (batch ${batchId})`);
        return analyzeAllRoofSegments(imgData, allNorm)
          .then(results => {
            console.log(`[RoofWizard] VertexEdge batch ${batchId} result:`, results ? `${results.length} segments` : 'NULL');
            if (results && results.length > 0) {
              setSegments(curr => {
                return curr.map((seg, i) => {
                  const match = results.find(r => r.index === i);
                  if (match && (seg.analyzing || !seg.analysis)) {
                    return { ...seg, analysis: match, analyzing: false };
                  }
                  if (seg.analyzing && !seg.analysis) {
                    return { ...seg, analyzing: false };
                  }
                  return seg;
                });
              });
            } else {
              setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
            }
          })
          .catch(err => {
            console.warn(`[RoofWizard] VertexEdge batch ${batchId} error:`, err);
            setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
          });
      });
    }
  }, [hasAiVision, coordinates, enqueueSegAnalysis]);

  // Segment drawing uses Google's native DrawingManager — click to add vertices,
  // double-click to close. Much more reliable than a custom click handler.
  const commitDrawnPolygonRef = useRef(commitDrawnPolygon);
  commitDrawnPolygonRef.current = commitDrawnPolygon;

  const startSegmentSketch = useCallback(
    (color: string) => {
      const map = mapInstanceRef.current;
      const dm = drawingManagerRef.current;
      if (!map || !dm || !mapLoaded || step1Sub !== 'segments' || phase !== 1) return;

      clearSegmentSketch();
      segmentSketchColorRef.current = color;

      // Configure polygon style for this segment's color
      dm.setOptions({
        polygonOptions: {
          fillColor: color,
          fillOpacity: 0.22,
          strokeColor: color,
          strokeWeight: 2.5,
          editable: true,
          draggable: false,
          zIndex: 2,
        },
      });

      // Wire up polygoncomplete — fires when user double-clicks to close the polygon
      const completeListener = google.maps.event.addListenerOnce(dm, 'polygoncomplete', (polygon: google.maps.Polygon) => {
        commitDrawnPolygonRef.current(polygon);
      });
      segmentSketchClickListenerRef.current = completeListener;

      dm.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
      setSegmentSketchMode(true);
      setIsDrawing(true);
    },
    [mapLoaded, step1Sub, phase, clearSegmentSketch]
  );

  useEffect(() => {
    if (step1Sub !== 'segments' || phase !== 1) {
      clearSegmentSketch();
      drawingManagerRef.current?.setDrawingMode(null);
    }
  }, [step1Sub, phase, clearSegmentSketch]);

  useEffect(() => {
    if (!segmentSketchMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearSegmentSketch();
        drawingManagerRef.current?.setDrawingMode(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [segmentSketchMode, clearSegmentSketch]);

  const deleteSegment = useCallback((id: string) => {
    dismissedMapLabelsRef.current.delete(`segment:${id}`);
    setSegments(prev => {
      const seg = prev.find(s => s.id === id);
      seg?.polygon.setMap(null);
      return prev.filter(s => s.id !== id);
    });
  }, []);

  const reanalyzeSegment = useCallback(
    (id: string) => {
      if (!hasAiVision) return;
      if (isGeminiQuotaPaused()) {
        stopAnalyzingForQuota();
        return;
      }
      const list = segmentsRef.current;
      const seg = list.find(s => s.id === id);
      if (!seg || seg.analyzing) return;

      // Mark this segment for re-analysis
      setSegments(curr => curr.map(s => (s.id === id ? { ...s, analyzing: true, analysis: null } : s)));

      const batchId = Date.now();

      enqueueSegAnalysis(async () => {
        const currentSegs = segmentsRef.current;
        // Wait for satellite image at execution time, not stale enqueue-time capture
        const imgData = await waitForSatelliteImage(8_000);
        const allNorm = currentSegs.map(s => s.path.map(p => latLngToImageNorm(p, coordinates, 20, 640)));
        console.log(`[RoofWizard] Re-analyze batch (batch ${batchId})`);
        return analyzeAllRoofSegments(imgData, allNorm, { refinement: true })
          .then(results => {
            console.log(`[RoofWizard] Re-analyze batch ${batchId} result:`, results ? `${results.length} segments` : 'NULL');
            if (results && results.length > 0) {
              setSegments(curr => {
                return curr.map((s, i) => {
                  const match = results.find(r => r.index === i);
                  if (match) {
                    return { ...s, analysis: match, analyzing: false, path: polyPathFromPolygon(s.polygon) };
                  }
                  return s.analyzing ? { ...s, analyzing: false } : s;
                });
              });
            } else {
              setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
            }
          })
          .catch(err => {
            console.warn(`[RoofWizard] Re-analyze batch ${batchId} error:`, err);
            setSegments(curr => curr.map(s => (s.analyzing ? { ...s, analyzing: false } : s)));
          });
      });
    },
    [hasAiVision, coordinates, enqueueSegAnalysis, waitForSatelliteImage, stopAnalyzingForQuota]
  );

  // ── Step 1c: Structure detection ────────────────────────────────────────────

  function clearStructureLines() {
    structLinesRef.current.forEach(l => l.setMap(null));
    structLinesRef.current = [];
  }

  // Show structural lines only on the Structure sub-step; hide everywhere else.
  useEffect(() => {
    const targetMap = step1Sub === 'structure' ? mapInstanceRef.current : null;
    structLinesRef.current.forEach(l => l.setMap(targetMap));
  }, [step1Sub]);

  const safeComputeAreaSqFt = useCallback((polygon: google.maps.Polygon): number => {
    try {
      if (typeof google === 'undefined' || !google.maps?.geometry?.spherical) return 0;
      return google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
    } catch {
      return 0;
    }
  }, []);

  const centerOnMapProperty = useCallback(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setCenter(coordinates);
    mapInstanceRef.current.setZoom(20);
  }, [coordinates.lat, coordinates.lng]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setMapTypeId(mapType);
  }, [mapType]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setTilt(tilt ? 45 : 0);
  }, [tilt]);

  useEffect(() => {
    if (!mapLoaded || !streetViewRef.current || !mapInstanceRef.current) return;
    if (panoramaRef.current) return;
    const pano = new google.maps.StreetViewPanorama(streetViewRef.current, {
      position: coordinates,
      pov: { heading: 0, pitch: 0 },
      visible: false,
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      zoomControl: false,
      panControl: true,
    });
    panoramaRef.current = pano;
    mapInstanceRef.current.setStreetView(pano);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapLoaded) return;
    const svc = new google.maps.StreetViewService();
    svc.getPanorama({ location: coordinates, radius: 100 }, (_data, status) => {
      setStreetViewAvailable(status === google.maps.StreetViewStatus.OK);
    });
  }, [mapLoaded, coordinates.lat, coordinates.lng]);

  useEffect(() => {
    if (!panoramaRef.current) return;
    panoramaRef.current.setVisible(showStreetView);
    if (showStreetView) {
      panoramaRef.current.setPosition(coordinates);
    }
  }, [showStreetView, coordinates]);

  useEffect(() => {
    if (showLabels && wasShowLabelsRef.current === false) {
      dismissedMapLabelsRef.current.clear();
    }
    wasShowLabelsRef.current = showLabels;
  }, [showLabels]);

  useEffect(() => {
    if (!outline?.polygon) dismissedMapLabelsRef.current.delete('outline');
  }, [outline]);

  useEffect(() => {
    suppressLabelCloseDismissRef.current = true;
    labelsRef.current.forEach(iw => iw.close());
    labelsRef.current = [];
    queueMicrotask(() => {
      suppressLabelCloseDismissRef.current = false;
    });
    const map = mapInstanceRef.current;
    if (!showLabels || !map) return;
    if (outline?.polygon && !dismissedMapLabelsRef.current.has('outline')) {
      const bounds = new google.maps.LatLngBounds();
      outline.polygon.getPath().forEach(p => bounds.extend(p));
      const center = bounds.getCenter();
      const iw = new google.maps.InfoWindow({
        position: center,
        content: '<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;padding:2px 6px;background:#ea580c;border-radius:6px;color:white;">Roof outline</div>',
        disableAutoPan: true,
      });
      iw.addListener('closeclick', () => {
        if (suppressLabelCloseDismissRef.current) return;
        dismissedMapLabelsRef.current.add('outline');
      });
      iw.open(map);
      labelsRef.current.push(iw);
    }
    segments.forEach(s => {
      if (dismissedMapLabelsRef.current.has(`segment:${s.id}`)) return;
      const bounds = new google.maps.LatLngBounds();
      s.polygon.getPath().forEach(p => bounds.extend(p));
      const center = bounds.getCenter();
      const area = safeComputeAreaSqFt(s.polygon);
      const iw = new google.maps.InfoWindow({
        position: center,
        content: `<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;padding:2px 6px;background:${s.color};border-radius:6px;color:white;">Segment ${s.index + 1}<br/>${formatArea(area)}</div>`,
        disableAutoPan: true,
      });
      iw.addListener('closeclick', () => {
        if (suppressLabelCloseDismissRef.current) return;
        dismissedMapLabelsRef.current.add(`segment:${s.id}`);
      });
      iw.open(map);
      labelsRef.current.push(iw);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLabels, outline, segments, safeComputeAreaSqFt]);

  function estimateSegmentEdges(path: { x: number; y: number }[], segmentIndex: number): SegmentEdge[] {
    const edges: SegmentEdge[] = [];
    for (let i = 0; i < path.length; i += 1) {
      const p1 = path[i];
      const p2 = path[(i + 1) % path.length];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (len < 0.02) continue;
      edges.push({
        segmentIndex,
        edgeIndex: i,
        p1,
        p2,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        len,
      });
    }
    return edges.sort((a, b) => b.len - a.len);
  }

  function clampNorm(n: number): number {
    return Math.max(0, Math.min(1, n));
  }

  function facingToAngle(facing: string | undefined): number | null {
    const map: Record<string, number> = {
      N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
    };
    return facing && facing in map ? map[facing] : null;
  }

  function parsePitchValue(pitch: string | undefined): number {
    if (!pitch) return 4;
    if (pitch === 'flat') return 0;
    if (pitch === 'steep') return 12;
    const parsed = Number.parseFloat(pitch.split('/')[0] ?? '4');
    return Number.isFinite(parsed) ? parsed : 4;
  }

  function edgeDirection(edge: SegmentEdge): { x: number; y: number } {
    const dx = edge.p2.x - edge.p1.x;
    const dy = edge.p2.y - edge.p1.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  function edgeDirectionSimilarity(a: SegmentEdge, b: SegmentEdge): number {
    const da = edgeDirection(a);
    const db = edgeDirection(b);
    return Math.abs(da.x * db.x + da.y * db.y);
  }

  function midpointDistance(a: SegmentEdge, b: SegmentEdge): number {
    return Math.hypot(a.mid.x - b.mid.x, a.mid.y - b.mid.y);
  }

  function alignedPair(a: SegmentEdge, b: SegmentEdge) {
    const dSame = Math.hypot(a.p1.x - b.p1.x, a.p1.y - b.p1.y) + Math.hypot(a.p2.x - b.p2.x, a.p2.y - b.p2.y);
    const dFlip = Math.hypot(a.p1.x - b.p2.x, a.p1.y - b.p2.y) + Math.hypot(a.p2.x - b.p1.x, a.p2.y - b.p1.y);
    if (dSame <= dFlip) return { p1: b.p1, p2: b.p2 };
    return { p1: b.p2, p2: b.p1 };
  }

  function classifySharedKind(segA: DrawnSegment, segB: DrawnSegment): StructuralLine['type'] {
    const t1 = segA.analysis?.type;
    const t2 = segB.analysis?.type;
    if (t1 === 'valley' || t2 === 'valley') return 'valley';
    const p1 = parsePitchValue(segA.analysis?.pitchEstimate);
    const p2 = parsePitchValue(segB.analysis?.pitchEstimate);
    if ((p1 < 1.5 && p2 >= 1.5) || (p2 < 1.5 && p1 >= 1.5)) return 'step';

    const a1 = facingToAngle(segA.analysis?.facingDirection);
    const a2 = facingToAngle(segB.analysis?.facingDirection);
    if (a1 !== null && a2 !== null) {
      const raw = Math.abs(a1 - a2) % 360;
      const gap = raw > 180 ? 360 - raw : raw;
      if (gap >= 140) return 'ridge';
      if (gap >= 70 && gap <= 120) return 'valley';
      return 'hip';
    }
    return 'hip';
  }

  function classifyOuterKind(seg: DrawnSegment, edge: SegmentEdge): StructuralLine['type'] {
    if (seg.analysis?.type === 'flat') return 'eave';
    const dx = Math.abs(edge.p2.x - edge.p1.x);
    const dy = Math.abs(edge.p2.y - edge.p1.y);
    return dx >= dy ? 'eave' : 'rake';
  }

  function buildFallbackStructureDetection(
    allNorm: { x: number; y: number }[][],
    drawnSegments: DrawnSegment[],
    totalAreaSqFt: number
  ): StructuralDetection {
    const cues: StructuralLine[] = [];
    const allEdges = allNorm.flatMap((path, idx) => (path.length < 3 ? [] : estimateSegmentEdges(path, idx)));
    const candidates: Array<{ a: SegmentEdge; b: SegmentEdge; score: number }> = [];
    for (let i = 0; i < allEdges.length; i += 1) {
      for (let j = i + 1; j < allEdges.length; j += 1) {
        const a = allEdges[i];
        const b = allEdges[j];
        if (a.segmentIndex === b.segmentIndex) continue;
        const orient = edgeDirectionSimilarity(a, b);
        if (orient < 0.94) continue;
        const midDist = midpointDistance(a, b);
        if (midDist > 0.035) continue;
        const lenRatio = Math.min(a.len, b.len) / Math.max(a.len, b.len);
        if (lenRatio < 0.45) continue;
        const score = orient * 0.5 + (1 - midDist / 0.035) * 0.3 + lenRatio * 0.2;
        candidates.push({ a, b, score });
      }
    }
    candidates.sort((x, y) => y.score - x.score);

    const usedEdges = new Set<string>();
    const usedKey = (edge: SegmentEdge) => `${edge.segmentIndex}:${edge.edgeIndex}`;

    for (const item of candidates) {
      if (cues.length >= 20) break;
      const keyA = usedKey(item.a);
      const keyB = usedKey(item.b);
      if (usedEdges.has(keyA) || usedEdges.has(keyB)) continue;
      usedEdges.add(keyA);
      usedEdges.add(keyB);

      const segA = drawnSegments[item.a.segmentIndex];
      const segB = drawnSegments[item.b.segmentIndex];
      if (!segA || !segB) continue;
      const aligned = alignedPair(item.a, item.b);

      cues.push({
        type: classifySharedKind(segA, segB),
        x1: clampNorm((item.a.p1.x + aligned.p1.x) / 2),
        y1: clampNorm((item.a.p1.y + aligned.p1.y) / 2),
        x2: clampNorm((item.a.p2.x + aligned.p2.x) / 2),
        y2: clampNorm((item.a.p2.y + aligned.p2.y) / 2),
        confidence: 0.68,
        estimatedLengthFt: Math.max(10, Math.round(((item.a.len + item.b.len) / 2) * 420)),
      });
    }

    for (const edge of allEdges) {
      if (cues.length >= 20) break;
      if (usedEdges.has(usedKey(edge))) continue;
      const seg = drawnSegments[edge.segmentIndex];
      if (!seg) continue;
      cues.push({
        type: classifyOuterKind(seg, edge),
        x1: clampNorm(edge.p1.x),
        y1: clampNorm(edge.p1.y),
        x2: clampNorm(edge.p2.x),
        y2: clampNorm(edge.p2.y),
        confidence: 0.56,
        estimatedLengthFt: Math.max(8, Math.round(edge.len * 400)),
      });
    }

    const uniq = new globalThis.Map<string, StructuralLine>();
    cues.forEach(cue => {
      const key = `${cue.type}:${cue.x1.toFixed(3)}:${cue.y1.toFixed(3)}:${cue.x2.toFixed(3)}:${cue.y2.toFixed(3)}`;
      if (!uniq.has(key)) uniq.set(key, cue);
    });
    const mergedCues: StructuralLine[] = Array.from(uniq.values()).slice(0, 20);
    const pitchVotes = drawnSegments
      .map(segment => segment.analysis?.pitchEstimate)
      .filter((v): v is string => !!v && v.length > 0);
    const predominantPitch = pitchVotes.length > 0
      ? pitchVotes.sort((a, b) =>
          pitchVotes.filter(v => v === b).length - pitchVotes.filter(v => v === a).length
        )[0]
      : '4/12';

    return {
      cues: mergedCues,
      roofType: allNorm.length <= 2 ? 'simple gable/hip' : 'complex multi-plane',
      predominantPitch,
      totalAreaSqFt: Math.max(250, Math.round(totalAreaSqFt)),
      notes:
        'Primary AI structure detection was unavailable. Generated adjacency-aware fallback from traced segments; shared edges map ridge/hip/valley/step while outer edges map eave/rake.',
    };
  }

  const runStructureDetection = useCallback(async () => {
    if (!mapInstanceRef.current) return;
    if (segments.length === 0) {
      setStructureError('Add at least one traced segment before running structure detection.');
      return;
    }
    setStructureError(null);
    setStructureSource(null);
    setStructureAnalyzing(true);
    setDsmResult(null);
    setDsmError(null);
    clearStructureLines();

    const allNorm = segments.map(s => s.path.map(p => latLngToImageNorm(p, coordinates, 20, 640)));
    const imgData = satelliteImageRef.current; // null if not yet loaded — detectRoofStructure handles null
    const totalAreaSqFt = segments.reduce((sum, s) => sum + safeComputeAreaSqFt(s.polygon), 0);

    try {
      const result = await Promise.race([
        detectRoofStructure(imgData, allNorm),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 150_000)),
      ]);
      const resolved = result && result.cues.length > 0
        ? result
        : buildFallbackStructureDetection(allNorm, segments, totalAreaSqFt);
      if (!result || result.cues.length === 0) {
        setStructureError('AI returned no structural cues, so a geometry fallback was applied. You can re-run detection.');
        setStructureSource('fallback');
      } else {
        setStructureSource('ai');
      }
      setStructureResult(resolved);
      setFinalAnalysis(null);
      setFinalSource(null);
      setFinalError(null);

      // Draw structural lines on map
      if (resolved && mapInstanceRef.current) {
        // Compute map bounds from satellite image logical size
        const zoom = 20;
        const worldPx = 256 * Math.pow(2, zoom);
        const halfLng = (320 / worldPx) * 360;
        const halfLat = halfLng; // approx at these scales
        const bounds = {
          sw: { lat: coordinates.lat - halfLat, lng: coordinates.lng - halfLng },
          ne: { lat: coordinates.lat + halfLat, lng: coordinates.lng + halfLng },
        };

        const lines = resolved.cues.filter(c => c.confidence >= 0.4);
        lines.forEach(cue => {
          // denormalize from [0,1] image space back to lat/lng
          const lat1 = bounds.ne.lat - cue.y1 * (bounds.ne.lat - bounds.sw.lat);
          const lng1 = bounds.sw.lng + cue.x1 * (bounds.ne.lng - bounds.sw.lng);
          const lat2 = bounds.ne.lat - cue.y2 * (bounds.ne.lat - bounds.sw.lat);
          const lng2 = bounds.sw.lng + cue.x2 * (bounds.ne.lng - bounds.sw.lng);

          const dashPat = safeDashPattern(cue.type);
          const line = new google.maps.Polyline({
            path: [{ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }],
            strokeColor: safeEdgeColor(cue.type),
            strokeWeight: cue.type === 'ridge' ? 3 : 2,
            strokeOpacity: 0.9,
            icons: dashPat.length >= 2 ? [{
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
              offset: '0',
              repeat: `${dashPat[0] + dashPat[1]}px`,
            }] : undefined,
            map: mapInstanceRef.current,
          });
          structLinesRef.current.push(line);
        });
      }
    } catch {
      const fallback = buildFallbackStructureDetection(allNorm, segments, totalAreaSqFt);
      setStructureResult(fallback);
      setFinalAnalysis(null);
      setFinalSource(null);
      setFinalError(null);
      setStructureSource('fallback');
      setStructureError('AI detection failed. Geometry fallback was applied so you can continue without skipping.');
    } finally {
      setStructureAnalyzing(false);
    }
  }, [segments, coordinates, safeComputeAreaSqFt]);

  // ── DSM analysis ────────────────────────────────────────────────────────────

  const runDsmAnalysis = useCallback(async () => {
    const dsmUrl = solarDataLayers?.dsmUrl;
    if (!dsmUrl || segments.length === 0) return;
    setDsmAnalyzing(true);
    setDsmError(null);
    setDsmResult(null);
    try {
      const result = await analyzeDsmForSegments(dsmUrl, segments.map(s => s.path), apiKey);
      if (result) {
        setDsmResult(result);
      } else {
        setDsmError('DSM data unavailable for this location — Solar API may not have coverage here.');
      }
    } catch {
      setDsmError('DSM fetch failed. Check console for details.');
    } finally {
      setDsmAnalyzing(false);
    }
  }, [solarDataLayers, segments, apiKey]);

  // Auto-run DSM analysis when structure detection completes and DSM URL is available
  useEffect(() => {
    if (!structureResult || dsmResult || dsmAnalyzing) return;
    if (!solarDataLayers?.dsmUrl) return;
    void runDsmAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureResult]);

  // ── DSM Auto-segmentation ────────────────────────────────────────────────────

  const runAutoSegment = useCallback(async () => {
    const dsmUrl = solarDataLayers?.dsmUrl;
    if (!dsmUrl || !solarData?.boundingBox) return;
    if (segments.length > 0) return; // already have segments
    setAutoSegmenting(true);
    dsmVisionEnrichAppliedRef.current = false;
    try {
      const buildingBounds = {
        minLat: solarData.boundingBox.sw.latitude,
        maxLat: solarData.boundingBox.ne.latitude,
        minLng: solarData.boundingBox.sw.longitude,
        maxLng: solarData.boundingBox.ne.longitude,
      };
      const detected = await autoSegmentRoofPlanes(dsmUrl, buildingBounds, apiKey);
      if (detected.length === 0) {
        return;
      }
      if (!mapInstanceRef.current) {
        return;
      }

      const visionInputs = detected.map((seg, i) => ({
        index: i,
        path: seg.path,
        dsmPitchDeg: seg.pitchDeg,
        dsmPitchRatio: seg.pitchRatio,
        dsmFacing: seg.facingDirection,
      }));

      const enrichByIndex = new globalThis.Map<number, DsmVisionEnrichment>();
      const sat = await waitForSatelliteImage();
      if (sat && hasAiVision) {
        try {
          const enriched = await enrichDsmSegmentsWithSatelliteVision(
            sat.data,
            sat.mimeType,
            coordinates.lat,
            coordinates.lng,
            20,
            640,
            visionInputs,
          );
          enriched.forEach(e => enrichByIndex.set(e.index, e));
          dsmVisionEnrichAppliedRef.current = enrichByIndex.size > 0;
        } catch (e) {
          console.warn('[RoofWizard] DSM satellite vision enrich skipped', e);
        }
      }

      const newSegments = detected.map((seg, i) => {
        const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
        const polygon = new google.maps.Polygon({
          paths: seg.path,
          map: mapInstanceRef.current!,
          fillColor: color,
          strokeColor: color,
          fillOpacity: 0.3,
          strokeWeight: 2.5,
          editable: true,
          zIndex: 2,
        });
        const e = enrichByIndex.get(i);
        const notesDsm = `DSM: pitch ${seg.pitchDeg}° (${seg.pitchRatio}), facing ${seg.facingDirection}`;
        const notesVision = e
          ? ` · Vision (${Math.round((e.visionConfidence ?? 0) * 100)}%): ${e.label}. ${e.notes} Visual ${e.visionPitchEstimate} / ${e.visionFacing}${e.agreesWithDsm ? ', agrees with DSM' : ' — measurements use DSM'}.`
          : '';
        return {
          id: `auto_${i}_${Date.now()}`,
          index: i,
          polygon,
          path: seg.path,
          color,
          analysis: {
            type: e?.roofType ?? 'gable',
            facingDirection: seg.facingDirection,
            pitchEstimate: seg.pitchRatio,
            confidence: seg.confidence,
            notes: notesDsm + notesVision,
          },
          analyzing: false,
          dsmPitchDeg: seg.pitchDeg,
          dsmPitchRatio: seg.pitchRatio,
          dsmFacingDirection: seg.facingDirection,
          dsmConfidence: seg.confidence,
        };
      });
      setSegments(newSegments);
      autoSegmentRanRef.current = true;
      setStep1Sub('segments');
    } catch {
      /* silent — user can draw segments manually */
    } finally {
      setAutoSegmenting(false);
    }
  }, [solarDataLayers, solarData, segments.length, apiKey, mapInstanceRef, waitForSatelliteImage, coordinates.lat, coordinates.lng, hasAiVision]);

  // DSM Auto-Map: after outline + user opens Segments, run auto-detect when map/DSM are ready (no mount-time jump past Outline).
  useEffect(() => {
    if (!autoSegmentMode || !pendingAutoSegmentAfterOutlineRef.current) return;
    if (!mapLoaded || !solarDataLayers?.dsmUrl || !solarData?.boundingBox) return;
    if (!outline || step1Sub !== 'segments') return;
    if (segments.length > 0 || autoSegmenting) return;
    if (autoSegmentRanRef.current) {
      pendingAutoSegmentAfterOutlineRef.current = false;
      return;
    }
    pendingAutoSegmentAfterOutlineRef.current = false;
    void runAutoSegment();
  }, [autoSegmentMode, mapLoaded, solarDataLayers, solarData, outline, step1Sub, segments.length, autoSegmenting, runAutoSegment]);

  // ── Phase 2: Photo upload ───────────────────────────────────────────────────

  const fileToDataUrl = useCallback(async (file: File): Promise<string | null> => {
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === 'string' ? reader.result : null;
        resolve(result);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }, []);

  const buildFallbackPhotoAnalysis = useCallback((slotId: PhotoSlotId): RoofPhotoCueAnalysis | null => {
    if (!structureResult || structureResult.cues.length === 0) return null;
    const slotToTypes: Record<PhotoSlotId, Array<StructuralLine['type']>> = {
      top: ['ridge', 'hip', 'valley', 'eave', 'rake'],
      front: ['eave', 'rake', 'hip'],
      back: ['eave', 'rake', 'hip'],
      left: ['rake', 'hip', 'valley'],
      right: ['rake', 'hip', 'valley'],
      street: ['eave', 'rake', 'hip'],
      '3d': ['ridge', 'hip', 'valley', 'eave', 'rake'],
    };
    const allowed = new Set(slotToTypes[slotId]);
    const cues = structureResult.cues
      .filter(cue => allowed.has(cue.type))
      .slice(0, 10)
      .map(cue => ({
        type: cue.type as 'ridge' | 'hip' | 'valley' | 'eave' | 'rake',
        x1: cue.x1,
        y1: cue.y1,
        x2: cue.x2,
        y2: cue.y2,
        confidence: Math.max(0.35, Math.min(0.72, cue.confidence * 0.75)),
      }));
    if (cues.length === 0) return null;
    const byType = { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0 };
    cues.forEach(cue => {
      byType[cue.type] += 1;
    });
    return {
      qualityScore: 0.38,
      cues,
      byType,
    };
  }, [structureResult]);

  const handlePhotoUpload = useCallback(async (slotId: PhotoSlotId, file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const imageDataUrl = await fileToDataUrl(file);
    setPhotoSlots(prev => prev.map(s => {
      if (s.id !== slotId) return s;
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return {
        ...s,
        file,
        previewUrl,
        captureImageDataUrl: imageDataUrl,
        capturedAtIso: new Date().toISOString(),
        status: 'analyzing',
        analysis: null,
        depthStatus: 'analyzing',
        depthMapUrl: null,
        depthPitchDeg: null,
        depthPitchRatio: null,
        depthResult: null,
      };
    }));

    // Run Gemini cue analysis + Depth Pro in parallel
    const [geminiResult, depthResult] = await Promise.allSettled([
      (async () => {
        let analysis = await deriveVisionRoofCuesFromFile(file, slotId);
        if (!analysis) analysis = buildFallbackPhotoAnalysis(slotId);
        return analysis;
      })(),
      imageDataUrl ? runPhotoDepthAnalysis(imageDataUrl, slotId) : Promise.reject('no-image'),
    ]);

    const analysis = geminiResult.status === 'fulfilled' ? geminiResult.value : buildFallbackPhotoAnalysis(slotId);
    const depth = depthResult.status === 'fulfilled' ? depthResult.value : null;

    setPhotoSlots(prev => prev.map(s => s.id === slotId ? {
      ...s,
      status: analysis ? 'done' : 'error',
      analysis,
      depthStatus: depth?.depthMapUrl ? 'done' : 'error',
      depthMapUrl: depth?.depthMapUrl ?? null,
      depthPitchDeg: depth?.pitchEstimateDeg ?? null,
      depthPitchRatio: depth?.pitchRatio ?? null,
      depthResult: depth,
    } : s));

    setFinalAnalysis(null);
    setFinalSource(null);
    setFinalError(null);
    if (analysis) setPhotoStepError(null);
  }, [buildFallbackPhotoAnalysis, fileToDataUrl]);

  const removePhoto = useCallback((slotId: PhotoSlotId) => {
    setPhotoSlots(prev => prev.map(s => {
      if (s.id !== slotId) return s;
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return {
        ...s,
        file: null,
        previewUrl: null,
        captureImageDataUrl: null,
        capturedAtIso: null,
        status: 'idle',
        analysis: null,
      };
    }));
    setFinalAnalysis(null);
    setFinalSource(null);
    setFinalError(null);
  }, []);

  const reanalyzePhotoSlot = useCallback(async (slotId: PhotoSlotId) => {
    const slot = photoSlots.find(s => s.id === slotId);
    if (!slot?.file) return;
    await handlePhotoUpload(slotId, slot.file);
  }, [photoSlots, handlePhotoUpload]);

  const applyCaptureView = useCallback((slotId: PhotoSlotId) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const preset = PHOTO_CAPTURE_PRESETS[slotId];
    setActiveCaptureSlot(slotId);

    const panorama = map.getStreetView();
    if (preset.mode === 'street') {
      map.setMapTypeId('hybrid');
      map.setTilt(0);
      panorama.setPosition(coordinates);
      panorama.setPov({
        heading: preset.heading ?? 0,
        pitch: preset.pitch ?? -3,
      });
      panorama.setVisible(true);
      return;
    }

    panorama.setVisible(false);
    map.panTo(coordinates);
    map.setMapTypeId('satellite');
    map.setHeading(preset.heading ?? 0);
    map.setTilt(preset.tilt ?? 0);
    if (typeof preset.zoom === 'number') {
      map.setZoom(preset.zoom);
    }
  }, [coordinates]);

  const fetchCaptureBlob = useCallback(async (url: string): Promise<Blob> => {
    const proxied = `${window.location.origin}/api/proxy-static-map?u=${encodeURIComponent(url)}`;
    const tryFetch = async (target: string) => {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`CAPTURE_HTTP_${res.status}`);
      const blob = await res.blob();
      if (blob.size < 500) throw new Error('CAPTURE_TOO_SMALL');
      return blob;
    };
    try {
      return await tryFetch(proxied);
    } catch {
      return await tryFetch(url);
    }
  }, []);

  const buildCaptureUrlFromVisibleView = useCallback((): string => {
    const map = mapInstanceRef.current;
    const panorama = map?.getStreetView();
    const streetVisible = !!panorama?.getVisible();
    if (streetVisible) {
      const pos = panorama?.getPosition();
      const lat = pos?.lat() ?? coordinates.lat;
      const lng = pos?.lng() ?? coordinates.lng;
      const pov = panorama?.getPov();
      const heading = pov?.heading ?? 0;
      const pitch = pov?.pitch ?? -3;
      const zoom = panorama?.getZoom?.() ?? 1;
      const fov = Math.max(40, Math.min(100, 100 - zoom * 12));
      return (
        `https://maps.googleapis.com/maps/api/streetview?size=960x640` +
        `&location=${lat},${lng}&heading=${heading}&pitch=${pitch}&fov=${fov}&source=outdoor&key=${apiKey}`
      );
    }

    const center = map?.getCenter();
    const lat = center?.lat() ?? coordinates.lat;
    const lng = center?.lng() ?? coordinates.lng;
    const zoom = map?.getZoom() ?? 20;
    const mapType = map?.getMapTypeId() ?? 'satellite';
    return (
      `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
      `&zoom=${zoom}&size=640x640&maptype=${mapType}&format=jpg&key=${apiKey}`
    );
  }, [apiKey, coordinates.lat, coordinates.lng]);

  const capturePhotoFromMap = useCallback(async (slotId: PhotoSlotId) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    setActiveCaptureSlot(slotId);
    setPhotoSlots(prev => prev.map(s => s.id === slotId ? { ...s, status: 'analyzing', analysis: null } : s));
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const url = buildCaptureUrlFromVisibleView();
      const blob = await fetchCaptureBlob(url);
      const ext = blob.type.includes('jpeg') ? 'jpg' : 'png';
      const file = new File([blob], `map-capture-${slotId}-${Date.now()}.${ext}`, { type: blob.type || 'image/png' });
      await handlePhotoUpload(slotId, file);
    } catch {
      setPhotoSlots(prev => prev.map(s => s.id === slotId ? { ...s, status: 'error', analysis: null } : s));
    }
  }, [buildCaptureUrlFromVisibleView, fetchCaptureBlob, handlePhotoUpload]);

  // ── Phase 3: Combined analysis ──────────────────────────────────────────────

  const runFinalAnalysis = useCallback(async () => {
    setFinalAnalyzing(true);
    setFinalAnalysis(null);
    setFinalError(null);
    setFinalSource(null);

    const structural = {
      roofType: structureResult?.roofType ?? 'unknown',
      predominantPitch: structureResult?.predominantPitch ?? '4/12',
      totalAreaSqFt: structureResult?.totalAreaSqFt ?? 0,
      segmentCount: segments.length,
      ridgeFt: structureResult?.cues.filter(c => c.type === 'ridge').reduce((s, c) => s + c.estimatedLengthFt, 0) ?? 0,
      hipFt: structureResult?.cues.filter(c => c.type === 'hip').reduce((s, c) => s + c.estimatedLengthFt, 0) ?? 0,
      valleyFt: structureResult?.cues.filter(c => c.type === 'valley').reduce((s, c) => s + c.estimatedLengthFt, 0) ?? 0,
      eaveFt: structureResult?.cues.filter(c => c.type === 'eave').reduce((s, c) => s + c.estimatedLengthFt, 0) ?? 0,
      notes: structureResult?.notes ?? '',
    };

    const photoSummaries = photoSlots
      .filter(s => s.status === 'done' && s.analysis)
      .map(s => ({
        slot: s.label,
        qualityScore: s.analysis!.qualityScore,
        cueCount: s.analysis!.cues.length,
        byType: s.analysis!.byType as Record<string, number>,
      }));
    const cueTotal = photoSummaries.reduce((sum, p) => sum + p.cueCount, 0);

    const topImg = satelliteImageRef.current ?? undefined;

    const buildFallbackCombined = (): Awaited<ReturnType<typeof analyzeCombinedRoof>> => {
      const avgPhotoQuality =
        photoSummaries.length > 0
          ? photoSummaries.reduce((sum, p) => sum + p.qualityScore, 0) / photoSummaries.length
          : 0;
      const coverageFromCues = Math.min(cueTotal, 80) / 80;
      const coverageScore = Math.min(1, (photoSummaries.length / 7) * 0.45 + coverageFromCues * 0.2);
      const structureScore = Math.min(1, Math.max(0, structural.totalAreaSqFt > 0 ? 0.65 : 0.45));
      const score = Math.round(
        (structureScore * 0.45 + avgPhotoQuality * 0.35 + coverageScore * 0.2) * 100
      );
      const boundedScore = Math.max(35, Math.min(92, score));
      const condition =
        boundedScore >= 85 ? 'Excellent' :
        boundedScore >= 72 ? 'Good' :
        boundedScore >= 58 ? 'Fair' :
        boundedScore >= 42 ? 'Poor' : 'Critical';
      const urgency =
        boundedScore >= 72 ? 'Low' :
        boundedScore >= 58 ? 'Medium' :
        boundedScore >= 42 ? 'High' : 'Urgent';
      const issues: string[] = [];
      if (photoSummaries.length < 2) issues.push('Limited multi-angle photo evidence; add more views for higher confidence.');
      if (avgPhotoQuality < 0.45) issues.push('Low photo cue quality detected in one or more captures.');
      if ((structural.ridgeFt + structural.hipFt + structural.valleyFt) < 30) {
        issues.push('Structural line density is low; consider refining segment traces.');
      }
      if (issues.length === 0) issues.push('No major visual anomalies detected in captured evidence.');

      const life =
        condition === 'Excellent' ? '12-18 years' :
        condition === 'Good' ? '8-14 years' :
        condition === 'Fair' ? '4-8 years' :
        condition === 'Poor' ? '2-5 years' : '0-2 years';

      return {
        condition,
        condition_score: boundedScore,
        issues,
        urgency,
        estimated_remaining_life: life,
        recommendation:
          condition === 'Excellent'
            ? 'Continue routine inspections and preventive maintenance.'
            : condition === 'Good'
              ? 'Plan targeted maintenance on observed weak zones and monitor seasonally.'
              : condition === 'Fair'
                ? 'Schedule a professional inspection and repair plan within this season.'
                : condition === 'Poor'
                  ? 'Prioritize corrective repairs soon to avoid accelerated deterioration.'
                  : 'Immediate professional intervention is recommended due to elevated risk.',
        marketing_message:
          'We combined structural mapping and multi-angle AI evidence to deliver a data-backed roof action plan.',
        structuralSummary:
          `Structural map indicates ${structural.segmentCount} segment(s), ${Math.round(structural.ridgeFt)} ft ridge, ${Math.round(structural.hipFt)} ft hip, and ${Math.round(structural.valleyFt)} ft valley lines.`,
        photoSummary:
          `Photo route analyzed ${photoSummaries.length} capture(s) with average quality ${Math.round(avgPhotoQuality * 100)}% and ${cueTotal} total geometry cues.`,
      };
    };

    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const id = window.setTimeout(() => reject(new Error('FINAL_ANALYSIS_TIMEOUT')), ms);
        promise
          .then(value => {
            window.clearTimeout(id);
            resolve(value);
          })
          .catch(error => {
            window.clearTimeout(id);
            reject(error);
          });
      });
    };

    try {
      const result = await withTimeout(analyzeCombinedRoof(structural, photoSummaries, topImg), 45000);
      if (!result) {
        setFinalAnalysis(buildFallbackCombined());
        setFinalSource('fallback');
        setFinalError('AI returned no final report. Generated fallback synthesis from Step 1 + Step 2 data.');
      } else {
        setFinalAnalysis(result);
        setFinalSource('ai');
      }
    } catch {
      setFinalAnalysis(buildFallbackCombined());
      setFinalSource('fallback');
      setFinalError('Final AI analysis timed out or failed. Generated fallback synthesis so workflow can continue.');
    } finally {
      setFinalAnalyzing(false);
    }
  }, [segments, structureResult, photoSlots]);

  const buildFinalPayload = useCallback(() => {
    if (!finalAnalysis) return null;
    return {
      generatedAtIso: new Date().toISOString(),
      address,
      coordinates,
      structural: {
        segmentCount: segments.length,
        roofType: structureResult?.roofType ?? 'unknown',
        predominantPitch: structureResult?.predominantPitch ?? '4/12',
        totalAreaSqFt: structureResult?.totalAreaSqFt ?? 0,
        cues: structureResult?.cues ?? [],
      },
      photos: photoSlots.map(slot => ({
        slot: slot.label,
        status: slot.status,
        quality: slot.analysis?.qualityScore ?? null,
        cueCount: slot.analysis?.cues.length ?? 0,
      })),
      final: finalAnalysis,
    };
  }, [finalAnalysis, address, coordinates, segments.length, structureResult, photoSlots]);

  const downloadFinalReport = useCallback(() => {
    const payload = buildFinalPayload();
    if (!payload || !finalAnalysis) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 44;

    doc.setFontSize(18);
    doc.text('Roof Intelligence Final Report', 40, y);
    y += 20;
    doc.setFontSize(10);
    doc.setTextColor(80);
    doc.text(address, 40, y);
    y += 14;
    doc.text(`Generated: ${new Date(payload.generatedAtIso).toLocaleString()}`, 40, y);
    y += 24;

    doc.setTextColor(20);
    doc.setFontSize(12);
    doc.text(`Condition: ${finalAnalysis.condition} (${finalAnalysis.condition_score}/100)`, 40, y);
    y += 14;
    doc.text(`Urgency: ${finalAnalysis.urgency}`, 40, y);
    y += 20;

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Value']],
      body: [
        ['Roof Type', String(payload.structural.roofType)],
        ['Predominant Pitch', String(payload.structural.predominantPitch)],
        ['Segments', String(payload.structural.segmentCount)],
        ['Total Area (sq ft)', String(Math.round(payload.structural.totalAreaSqFt))],
        ['Photo Slots Analyzed', String(payload.photos.filter((p: { status: string }) => p.status === 'done').length)],
      ],
      styles: { fontSize: 9 },
      theme: 'grid',
    });

    const afterMetrics = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 120;
    autoTable(doc, {
      startY: afterMetrics + 16,
      head: [['Section', 'Summary']],
      body: [
        ['Structural Summary', finalAnalysis.structuralSummary],
        ['Photo Summary', finalAnalysis.photoSummary],
        ['Recommendation', finalAnalysis.recommendation],
      ],
      styles: { fontSize: 9, cellPadding: 5 },
      theme: 'striped',
      columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: pageWidth - 210 } },
    });

    const afterSummary = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? afterMetrics + 140;
    const issues = finalAnalysis.issues.length > 0 ? finalAnalysis.issues : ['No major issues flagged by combined analysis.'];
    autoTable(doc, {
      startY: afterSummary + 16,
      head: [['Identified Issues']],
      body: issues.map(issue => [issue]),
      styles: { fontSize: 9 },
      theme: 'grid',
    });

    doc.save(`roof-report-${Date.now()}.pdf`);
  }, [buildFinalPayload, finalAnalysis, address]);

  const shareFinalReport = useCallback(async () => {
    const payload = buildFinalPayload();
    if (!payload) return;
    const text = [
      `Roof Report — ${address}`,
      `Condition: ${finalAnalysis?.condition} (${finalAnalysis?.condition_score}/100)`,
      `Urgency: ${finalAnalysis?.urgency}`,
      `Recommendation: ${finalAnalysis?.recommendation ?? ''}`,
    ].join('\n');

    try {
      if (navigator.share) {
        await navigator.share({ title: 'Roof Analysis Report', text });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n\n${JSON.stringify(payload, null, 2)}`);
    } catch {
      // Intentionally no-op; share can be blocked by browser permissions.
    }
  }, [buildFinalPayload, address, finalAnalysis]);

  const saveQuoteDraftToProject = useCallback(async () => {
    if (!finalAnalysis || quoteDraftSaved) return;
    // The auto-save already persists everything; this is an explicit "confirm saved" action.
    // If the project hasn't been persisted yet (no DB or first save pending) we nudge it by
    // updating persistStatus so the user sees the in-header save indicator.
    setQuoteDraftSaved(true);
    setTimeout(() => setQuoteDraftSaved(false), 2500);
  }, [finalAnalysis, quoteDraftSaved]);

  const handleSaveAndNew = useCallback(async () => {
    if (projectSaving) return;
    setProjectSaving(true);
    // Poll the ref (not state) so the closure always sees the latest value.
    await new Promise<void>(resolve => {
      if (persistStatusRef.current === 'saved') { resolve(); return; }
      const start = Date.now();
      const check = () => {
        if (persistStatusRef.current === 'saved' || Date.now() - start > 6_000) { resolve(); return; }
        setTimeout(check, 200);
      };
      check();
    });
    // Persist exactly one history entry on explicit user confirmation.
    appendHistoryNextRef.current = true;
    setHistorySaveNonce(n => n + 1);

    // Wait for the next persistence cycle to finish (saving → saved).
    await new Promise<void>(resolve => {
      const start = Date.now();
      let sawSaving = false;
      const tick = () => {
        if (persistStatusRef.current === 'saving') sawSaving = true;
        if (sawSaving && persistStatusRef.current === 'saved') { resolve(); return; }
        if (Date.now() - start > 12_000) { resolve(); return; }
        setTimeout(tick, 200);
      };
      tick();
    });

    setProjectSaving(false);
    onSaveAndNew?.();
  }, [projectSaving, onSaveAndNew]);

  // ── Step navigation ─────────────────────────────────────────────────────────

  function goToSegments() {
    setStep1Sub('segments');
    stopDrawing();
    if (autoSegmentMode && outline) pendingAutoSegmentAfterOutlineRef.current = true;
  }

  function goToStructure() {
    setStep1Sub('structure');
    stopDrawing();
    // Make segment polygons non-editable to avoid confusion
    segments.forEach(s => s.polygon.setOptions({ editable: false }));
  }

  function goToPhotos() {
    if (!structureResult) {
      setStructureError('Complete structural detection before moving to Photo Analysis.');
      return;
    }
    setPhase(2);
    setShowFullReport(false);
    stopDrawing();
  }

  function goToFinal() {
    if (photosAnalyzed === 0) {
      setPhotoStepError('Analyze at least 1 captured photo before continuing to Final Report.');
      return;
    }
    setPhotoStepError(null);
    setFinalAnalysis(null);
    setFinalSource(null);
    setFinalError(null);
    setPhase(3);
    setShowFullReport(true);
  }

  // ── Derived stats ───────────────────────────────────────────────────────────

  const photosAnalyzed = photoSlots.filter(s => s.status === 'done').length;
  const totalCues = photoSlots.filter(s => s.analysis).reduce((n, s) => n + s.analysis!.cues.length, 0);
  const activeSlotLabel = photoSlots.find(slot => slot.id === activeCaptureSlot)?.label ?? 'Top View';
  const photoCaptured = photoSlots.filter(slot => !!slot.file).length;
  const canMeasureArea = typeof google !== 'undefined' && !!google.maps?.geometry?.spherical;
  const mappedAreaSqFt = segments.reduce((sum, segment) => {
    if (!canMeasureArea) return sum;
    return sum + safeComputeAreaSqFt(segment.polygon);
  }, 0);
  const edgeTotals = (['ridge', 'hip', 'valley', 'eave', 'rake', 'step'] as const).reduce(
    (acc, type) => {
      acc[type] = Math.round(
        (structureResult?.cues ?? [])
          .filter(cue => cue.type === type)
          .reduce((sum, cue) => sum + cue.estimatedLengthFt, 0)
      );
      return acc;
    },
    { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0, step: 0 }
  );
  const pitchMix = segments.reduce<Record<string, number>>((acc, segment) => {
    // DSM pitch is authoritative; fall back to AI estimate
    const pitch = segment.dsmPitchRatio ?? segment.analysis?.pitchEstimate ?? 'unknown';
    acc[pitch] = (acc[pitch] ?? 0) + 1;
    return acc;
  }, {});
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
  // Prefer DSM 3D area (most accurate) > AI structure estimate > mapped polygon area
  const bestAreaSqFt = dsmResult?.totalSloped3dAreaSqFt ?? structureResult?.totalAreaSqFt ?? mappedAreaSqFt;
  const areaSquares = Math.max(1, Math.round(bestAreaSqFt / 100));
  const quoteSubtotal = Math.round(areaSquares * quoteBaseRatePerSq);
  const quoteLineItems = [
    { label: 'Roof system replacement', qty: `${areaSquares} sq`, unit: `$${quoteBaseRatePerSq}`, total: `$${quoteSubtotal}` },
    { label: 'Ridge / hip treatment', qty: `${edgeTotals.ridge + edgeTotals.hip} ft`, unit: '$4.25', total: `$${Math.round((edgeTotals.ridge + edgeTotals.hip) * 4.25)}` },
    { label: 'Valley waterproofing', qty: `${edgeTotals.valley} ft`, unit: '$6.5', total: `$${Math.round(edgeTotals.valley * 6.5)}` },
    { label: 'Eave + rake finishing', qty: `${edgeTotals.eave + edgeTotals.rake} ft`, unit: '$2.1', total: `$${Math.round((edgeTotals.eave + edgeTotals.rake) * 2.1)}` },
  ];
  const quoteTotal = quoteLineItems.reduce((sum, item) => sum + Number(item.total.replace('$', '')), 0);
  const allLatLng = segments.flatMap(segment => segment.path);
  const diagramBounds = allLatLng.length > 0
    ? {
        minLat: Math.min(...allLatLng.map(point => point.lat)),
        maxLat: Math.max(...allLatLng.map(point => point.lat)),
        minLng: Math.min(...allLatLng.map(point => point.lng)),
        maxLng: Math.max(...allLatLng.map(point => point.lng)),
      }
    : null;
  const diagramWidth = 920;
  const diagramPadding = 28;
  // Preserve true geographic aspect ratio: 1° lng ≠ 1° lat in meters.
  // At latitude φ: 1° lng = cos(φ) × (1° lat). Compute the real width-to-height ratio
  // so the diagram isn't vertically squished or stretched.
  const _midLat = diagramBounds
    ? (diagramBounds.minLat + diagramBounds.maxLat) / 2
    : 37;
  const _cosLat = Math.cos(_midLat * Math.PI / 180);
  const _spanLng = diagramBounds ? Math.max(1e-9, diagramBounds.maxLng - diagramBounds.minLng) : 1;
  const _spanLat = diagramBounds ? Math.max(1e-9, diagramBounds.maxLat - diagramBounds.minLat) : 1;
  // Real width and height in "equivalent degrees"
  const _realW = _spanLng * _cosLat;
  const _realH = _spanLat;
  const _geoAspect = _realW / _realH; // > 1 = wider than tall
  const _innerW = diagramWidth - 2 * diagramPadding;
  const _innerH = Math.round(_innerW / Math.max(0.2, Math.min(6, _geoAspect)));
  const diagramHeight = _innerH + 2 * diagramPadding;
  // Uniform px-per-meter scale so shapes look correct
  const _pxPerDegLat = _innerH / _spanLat;
  const _pxPerDegLng = _innerW / _spanLng;
  const _pxPerM_lat = _pxPerDegLat / 111111;
  const _pxPerM_lng = _pxPerDegLng / (111111 * _cosLat);
  const _pxPerM = Math.min(_pxPerM_lat, _pxPerM_lng);
  const _usedW = _spanLng * 111111 * _cosLat * _pxPerM;
  const _usedH = _spanLat * 111111 * _pxPerM;
  const _xOff = diagramPadding + (_innerW - _usedW) / 2;
  const _yOff = diagramPadding + (_innerH - _usedH) / 2;
  const toDiagramPoint = (point: { lat: number; lng: number }) => {
    if (!diagramBounds) return { x: diagramPadding, y: diagramPadding };
    return {
      x: _xOff + (point.lng - diagramBounds.minLng) * 111111 * _cosLat * _pxPerM,
      y: _yOff + (diagramBounds.maxLat - point.lat) * 111111 * _pxPerM,
    };
  };
  const reportPolygons = segments.map(segment => {
    const pts = segment.path.map(toDiagramPoint);
    return {
      id: segment.id,
      color: segment.color,
      pitch: segment.dsmPitchRatio ?? segment.analysis?.pitchEstimate ?? 'n/a',
      facing: segment.dsmFacingDirection ?? segment.analysis?.facingDirection ?? 'n/a',
      points: pts,
      center:
        pts.length > 0
          ? {
              x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
              y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
            }
          : { x: 0, y: 0 },
      areaSqFt: canMeasureArea ? Math.round(safeComputeAreaSqFt(segment.polygon)) : 0,
    };
  });
  const reportEdges = (structureResult?.cues ?? []).map((cue, idx) => ({
    id: `edge-${idx}`,
    type: cue.type,
    color: safeEdgeColor(cue.type),
    x1: diagramPadding + cue.x1 * (diagramWidth - diagramPadding * 2),
    y1: diagramPadding + cue.y1 * (diagramHeight - diagramPadding * 2),
    x2: diagramPadding + cue.x2 * (diagramWidth - diagramPadding * 2),
    y2: diagramPadding + cue.y2 * (diagramHeight - diagramPadding * 2),
    dash: safeDashPattern(cue.type),
  }));

  // Phase 3: AI analysis is triggered MANUALLY by the user, not auto-run.

  useEffect(() => {
    const hasMeaningfulData =
      !!outline ||
      segments.length > 0 ||
      photoSlots.some(slot => !!slot.file || slot.status === 'done' || slot.status === 'error') ||
      !!structureResult ||
      !!finalAnalysis;
    if (!hasMeaningfulData) return;
    if (!isDbConfigured()) {
      setPersistStatus('error');
      return;
    }

    let cancelled = false;
    const debounceMs = 700;
    const debounceTimer = window.setTimeout(() => {
      if (cancelled) return;
      setPersistStatus('saving');
      void (async () => {
      try {
        const outlinePointsLive = outline ? polyPathFromPolygon(outline.polygon) : null;
        const roofOutlineSnapshot =
          outlinePointsLive && outlinePointsLive.length >= 3
            ? await buildRoofOutlineSnapshotDataUrl(
                outlinePointsLive,
                coordinates,
                satelliteImageRef.current,
                20,
                640
              )
            : null;

        const payload: WizardWorkflowReportPayload = {
          version: 'v1',
          source: 'roof-mapping-wizard',
          projectFolderName: initialProjectFolderName?.trim() ? initialProjectFolderName.trim() : null,
          address,
          coordinates,
          outline: outlinePointsLive
            ? {
                points: outlinePointsLive,
                analysis: outline?.analysis ?? null,
              }
            : null,
          segments: segments.map(segment => ({
            id: segment.id,
            index: segment.index,
            color: segment.color,
            path: segment.path,
            analysis: segment.analysis,
            flatAreaSqFt: safeComputeAreaSqFt(segment.polygon),
            dsmPitchDeg: segment.dsmPitchDeg,
            dsmPitchRatio: segment.dsmPitchRatio,
            dsmFacingDirection: segment.dsmFacingDirection,
            dsmConfidence: segment.dsmConfidence,
          })),
          structure: structureResult,
          photos: photoSlots.map(slot => ({
            id: slot.id,
            label: slot.label,
            description: slot.description,
            status: slot.status,
            qualityScore: slot.analysis?.qualityScore ?? null,
            cueCount: slot.analysis?.cues.length ?? 0,
            byType: slot.analysis?.byType,
            captureImageDataUrl:
              slot.captureImageDataUrl && slot.captureImageDataUrl.length < 600_000
                ? slot.captureImageDataUrl
                : null,
            capturedAtIso: slot.capturedAtIso ?? null,
            depthPitchDeg: slot.depthPitchDeg ?? null,
            depthPitchRatio: slot.depthPitchRatio ?? null,
            depthMapUrl: slot.depthMapUrl ?? null,
            notes: slot.analysis?.cues.length
              ? `${slot.analysis.cues.length} cues · quality ${Math.round((slot.analysis.qualityScore ?? 0) * 100)}%`
              : null,
          })),
          finalAnalysis,
          solarStructure: (() => {
            if (!solarData?.roofSegmentStats?.length) return null;
            try {
              return analyzeSolarSegments(solarData.roofSegmentStats, solarData.center, {
                imageryQuality: solarData.imageryQuality,
                hasDsm: !!solarDataLayers?.dsmUrl,
              });
            } catch {
              return null;
            }
          })(),
          satelliteSnapshot: (() => {
            const sat = satelliteImageRef.current;
            if (!sat?.data) return null;
            const dataUrl = `data:${sat.mimeType};base64,${sat.data}`;
            return dataUrl.length < 800_000 ? dataUrl : null;
          })(),
          roofOutlineSnapshot,
          updatedAtIso: new Date().toISOString(),
        };
        const linkedProjectId =
          existingProjectId?.trim() || wizardLinkedProjectIdRef.current?.trim() || undefined;
        // Consume the "append history once" flag so we only write to history on explicit completion.
        const appendHistory = appendHistoryNextRef.current;
        appendHistoryNextRef.current = false;
        const saved = await saveWizardWorkflowReport(payload, {
          projectId: linkedProjectId,
          forceNewProject: forceNewProject && !linkedProjectId,
          appendHistory,
        });
        if (!cancelled) {
          wizardLinkedProjectIdRef.current = saved.projectId;
          setPersistStatus('saved');
          onPersisted?.(saved.projectId);
        }
      } catch {
        if (!cancelled) setPersistStatus('error');
      }
      })();
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
    };
  }, [address, coordinates, outline, segments, structureResult, photoSlots, finalAnalysis, initialProjectFolderName, solarData, solarDataLayers, existingProjectId, forceNewProject, historySaveNonce]);

  // Capture snapshot of previewUrls for cleanup on unmount only (not on every photoSlots change,
  // which would revoke URLs that are still being displayed).
  const photoSlotsRef = useRef(photoSlots);
  useEffect(() => {
    photoSlotsRef.current = photoSlots;
  });
  useEffect(() => {
    return () => {
      photoSlotsRef.current.forEach(slot => {
        if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
      });
    };
  }, []);

  const structLineSummary = structureResult
    ? (['ridge', 'hip', 'valley', 'eave', 'rake'] as const).map(type => ({
        type,
        count: structureResult.cues.filter(c => c.type === type).length,
        ft: Math.round(structureResult.cues.filter(c => c.type === type).reduce((s, c) => s + c.estimatedLengthFt, 0)),
      })).filter(r => r.count > 0)
    : [];

  useEffect(() => {
    if (!onFolderManifestChange) return;
    const entries: { id: string; label: string; done: boolean }[] = [];

    if (outline || step1Sub !== 'outline') {
      entries.push({
        id: 'outline',
        label: 'Roof outline (AI validation)',
        done: !!outline?.analysis && !outline?.analyzing,
      });
    }
    if (segments.length > 0 || step1Sub === 'segments' || step1Sub === 'structure') {
      const n = segments.length;
      const analyzed = segments.filter(s => s.analysis).length;
      const segmentLabel =
        autoSegmentMode && (autoSegmenting || n > 0)
          ? n
            ? `DSM roof planes (${analyzed}/${n})`
            : 'DSM roof planes (auto-detect…)'
          : n
            ? `Segments classified (${analyzed}/${n})`
            : 'Segments';
      entries.push({
        id: 'segments',
        label: segmentLabel,
        done: n > 0 && analyzed === n && segments.every(s => !s.analyzing) && !autoSegmenting,
      });
    }

    if (structureAnalyzing || structureResult || phase >= 2 || (segments.length > 0 && step1Sub === 'structure')) {
      entries.push({
        id: 'structure',
        label: 'Structural lines & geometry',
        done: !!structureResult && !structureAnalyzing,
      });
    }

    if (phase >= 2) {
      const doneSlots = photoSlots.filter(p => p.status === 'done' && p.analysis).length;
      entries.push({
        id: 'photos',
        label: `Multi-angle photos (${doneSlots} analyzed)`,
        done: phase >= 3,
      });
    }

    if (phase >= 3) {
      entries.push({
        id: 'final',
        label: 'Final combined AI report',
        done: !!finalAnalysis && !finalAnalyzing,
      });
    }

    if (persistStatus === 'saved') {
      entries.push({
        id: 'persisted',
        label: 'Report saved to project',
        done: true,
      });
    }

    onFolderManifestChange(entries);
  }, [
    onFolderManifestChange,
    autoSegmentMode,
    autoSegmenting,
    dsmAnalyzing,
    dsmResult,
    outline,
    step1Sub,
    segments,
    phase,
    structureResult,
    structureAnalyzing,
    photoSlots,
    finalAnalysis,
    finalAnalyzing,
    persistStatus,
  ]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
      {/* ── Top bar ── */}
      <div className="shrink-0 bg-slate-900 border-b border-slate-700 px-3 py-2.5 sm:px-4 sm:py-3 safe-pt flex flex-col gap-2">
        <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => { try { localStorage.removeItem(draftKey); } catch { /* ok */ } onClose(); }}
          className="tap-target shrink-0 text-slate-400 hover:text-white transition-colors rounded-lg -ml-1"
          aria-label="Close wizard"
        >
          <X size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-400 truncate">{address}</div>
          {initialProjectFolderName?.trim() && (
            <div className="text-[11px] text-cyan-300/90 font-medium truncate mt-0.5">
              {initialProjectFolderName.trim()}
            </div>
          )}
          <div className="text-sm font-semibold text-white truncate">Smart Roof Mapping Wizard</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 flex-wrap justify-end">
        {!hasAiVision && (
          <div className="flex items-center gap-1.5 bg-amber-900/40 border border-amber-700/50 text-amber-300 text-[10px] sm:text-xs px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg">
            <AlertCircle size={13} className="shrink-0" />
            <span className="hidden sm:inline">No AI key — add Gemini in Settings or OPENAI_API_KEY on server</span>
            <span className="sm:hidden">No AI key</span>
          </div>
        )}
        {hasAiVision && hasGeminiKey && geminiQuotaNotice && (
          <div className="flex items-center gap-1.5 bg-red-900/40 border border-red-700/50 text-red-200 text-[10px] sm:text-xs px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg max-w-[min(100%,280px)]">
            <AlertCircle size={13} className="shrink-0" />
            <span className="line-clamp-2">Rate limited</span>
          </div>
        )}
        {persistStatus !== 'idle' && (
          <div
            className={`text-[10px] sm:text-[11px] px-2 py-1 sm:px-2.5 rounded-md border whitespace-nowrap ${
              persistStatus === 'saving'
                ? 'bg-blue-900/30 border-blue-700/50 text-blue-200'
                : persistStatus === 'saved'
                  ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-200'
                  : 'bg-red-900/30 border-red-700/50 text-red-200'
            }`}
          >
            {persistStatus === 'saving' ? 'Saving…' : persistStatus === 'saved' ? 'Saved' : 'Save failed'}
          </div>
        )}
        </div>
        </div>
        <div className="mobile-scroll-x flex items-center gap-1 pb-0.5 -mx-1 px-1">
          <PhaseTab phase={1} current={phase} label="Structural Map" sublabel="Draw & analyze" />
          <ChevronRight size={14} className="text-slate-600 shrink-0 hidden sm:block" />
          <PhaseTab phase={2} current={phase} label="Photo Analysis" sublabel="Multi-angle" />
          <ChevronRight size={14} className="text-slate-600 shrink-0 hidden sm:block" />
          <PhaseTab phase={3} current={phase} label="Final Report" sublabel="Combined AI" />
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">

        {/* ── Map ── */}
        <div className="relative min-h-0 h-[42dvh] max-h-[50dvh] shrink-0 lg:h-auto lg:flex-1 lg:max-h-none">
          {mapError ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-red-400 text-sm">{mapError}</div>
          ) : (
            <div className="relative flex h-full w-full min-h-0">
              <div
                ref={mapRef}
                className={`h-full min-h-0 transition-all duration-300 ${
                  showStreetView ? 'max-lg:hidden lg:w-1/2 lg:block w-full' : 'w-full'
                }`}
              />
              <div
                ref={streetViewRef}
                className={`h-full min-h-0 border-slate-700 transition-all duration-300 ${
                  showStreetView
                    ? 'max-lg:absolute max-lg:inset-0 max-lg:z-20 max-lg:border-0 lg:relative lg:border-l-2 lg:w-1/2 w-full'
                    : 'w-0 overflow-hidden lg:w-0'
                }`}
              >
                {showStreetView && !streetViewAvailable && (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-slate-950 px-4 text-center">
                    <Navigation size={32} className="text-slate-500" />
                    <p className="text-sm font-medium text-slate-300">Street View not available</p>
                    <p className="text-xs text-slate-500">No street-level imagery within 100 m of this address.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {mapLoaded && !mapError && (
            <div className="absolute top-[max(0.5rem,env(safe-area-inset-top,0px))] left-2 right-2 z-20 flex flex-wrap gap-1.5 max-w-full">
              <div className="flex gap-1 bg-white rounded-xl shadow-md border border-slate-200 p-1">
                <button
                  type="button"
                  onClick={centerOnMapProperty}
                  title="Re-center on property"
                  className="touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg text-slate-600 hover:bg-slate-100 transition-all"
                >
                  <Maximize2 size={13} />
                  <span className="hidden sm:inline">Center</span>
                </button>
                <div className="w-px bg-slate-200 my-1" />
                {([
                  { label: 'Street', zoom: 17, title: 'Street level — see block context' },
                  { label: 'Block', zoom: 19, title: 'Block level — see neighboring buildings' },
                  { label: 'Roof', zoom: 21, title: 'Roof level — maximum detail' },
                ] as const).map(({ label, zoom, title }) => (
                  <button
                    key={label}
                    type="button"
                    title={title}
                    onClick={() => {
                      if (!mapInstanceRef.current) return;
                      mapInstanceRef.current.setCenter(coordinates);
                      mapInstanceRef.current.setZoom(zoom);
                    }}
                    className="touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg text-slate-600 hover:bg-slate-100 transition-all"
                  >
                    <ZoomIn size={12} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex gap-1 bg-white rounded-xl shadow-md border border-slate-200 p-1">
                <button
                  type="button"
                  onClick={() => setMapType(t => (t === 'satellite' ? 'hybrid' : 'satellite'))}
                  title={mapType === 'satellite' ? 'Show street labels (Hybrid view)' : 'Hide street labels (Satellite view)'}
                  className={`touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg transition-all ${
                    mapType === 'hybrid' ? 'bg-green-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Map size={13} />
                  <span className="hidden sm:inline">{mapType === 'hybrid' ? 'Labels On' : 'Labels'}</span>
                </button>
                <div className="w-px bg-slate-200 my-1" />
                <button
                  type="button"
                  onClick={() => setTilt(t => !t)}
                  title="Toggle 3D tilt"
                  className={`touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg transition-all ${
                    tilt ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Satellite size={13} />
                  <span className="hidden sm:inline">3D</span>
                </button>
                <div className="w-px bg-slate-200 my-1" />
                <button
                  type="button"
                  onClick={() => setShowLabels(l => !l)}
                  title="Toggle segment labels"
                  className={`touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg transition-all ${
                    showLabels ? 'text-slate-600 hover:bg-slate-100' : 'bg-slate-700 text-white'
                  }`}
                >
                  {showLabels ? <Eye size={13} /> : <EyeOff size={13} />}
                  <span className="hidden sm:inline">Pins</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowStreetView(v => !v)}
                title={showStreetView ? 'Close Street View' : 'Open Street View — confirm building identity from street level'}
                className={`touch-manipulation flex items-center gap-1.5 text-xs font-semibold px-3 py-2 min-h-[36px] rounded-xl shadow-md border transition-all ${
                  showStreetView
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-orange-50 hover:border-orange-300 hover:text-orange-700'
                }`}
              >
                <Navigation size={13} />
                <span>{showStreetView ? 'Close Street View' : 'Street View'}</span>
                {!streetViewAvailable && !showStreetView && (
                  <span className="text-[10px] text-slate-400 hidden sm:inline">(checking…)</span>
                )}
              </button>

              {solarData?.imageryQuality === 'LOW' && (
                <div className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-3 py-2 min-h-[36px] rounded-xl shadow-md">
                  <AlertCircle size={13} />
                  <span className="hidden sm:inline">Low imagery quality — use Street View or upload a photo</span>
                  <span className="sm:hidden">Low quality</span>
                </div>
              )}
            </div>
          )}

          {/* Drawing instructions overlay */}
          {isDrawing && (
            <div className="absolute top-4 left-1/2 z-20 -translate-x-1/2 max-w-[min(100vw-2rem,440px)] bg-blue-600/90 backdrop-blur text-white text-xs sm:text-sm px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
              <Pencil size={14} className="shrink-0" />
              <span className="min-w-0 leading-snug">
                {outlineSketchMode
                  ? 'Click corners → double-click or click green circle to close. ⌘Z undoes.'
                  : segmentSketchMode
                    ? 'Click corners on the map — double-click the final point to finish the segment.'
                    : 'Click the map to continue drawing.'}
              </span>
              <button
                type="button"
                onClick={() => {
                  clearOutlineSketch();
                  clearSegmentSketch();
                }}
                className="ml-1 shrink-0 text-white/70 hover:text-white"
                aria-label="Cancel drawing"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Structural line legend (step 1c) */}
          {phase === 1 && step1Sub === 'structure' && structureResult && (
            <div className="absolute bottom-4 left-4 z-10 bg-slate-900/90 backdrop-blur border border-slate-700 rounded-xl p-3">
              <div className="text-xs font-semibold text-white mb-2">Structural Lines</div>
              <div className="flex flex-col gap-1">
                {Object.entries(EDGE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex items-center gap-2">
                    <div className="w-6 h-0.5 rounded" style={{ backgroundColor: color }} />
                    <span className="text-xs text-slate-300 capitalize">{type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {phase === 2 && (
            <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur border border-slate-700 rounded-xl p-3 max-w-[300px]">
              <div className="text-xs font-semibold text-white mb-1.5">Map Capture Mode</div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Active viewpoint: <span className="text-blue-300 font-medium">{activeSlotLabel}</span>.
                Click a slot's <span className="text-slate-100">Show View</span>, adjust map if needed, then press <span className="text-slate-100">Capture</span>.
              </p>
            </div>
          )}
        </div>

        {/* ── Side panel ── */}
        <div className="w-full lg:w-80 shrink-0 bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-700 flex flex-col overflow-hidden flex-1 min-h-0 lg:flex-none lg:max-h-none max-h-[52dvh]">

          {/* ────────── Phase 1 ────────── */}
          {phase === 1 && (
            <div className="flex-1 flex flex-col overflow-hidden">

              {/* Sub-step tabs */}
              <div className="flex border-b border-slate-700 text-xs font-medium shrink-0">
                {(['outline', 'segments', 'structure'] as const).map((sub, i) => (
                  <button
                    key={sub}
                    onClick={() => {
                      if (sub === 'segments' && !outline) return;
                      if (sub === 'structure' && segments.length === 0) return;
                      if (sub === 'outline') { setStep1Sub('outline'); stopDrawing(); }
                      else if (sub === 'segments') goToSegments();
                      else goToStructure();
                    }}
                    className={`flex-1 py-3 min-h-[44px] capitalize transition-colors touch-manipulation ${
                      step1Sub === sub
                        ? 'text-blue-400 border-b-2 border-blue-500 bg-blue-950/30'
                        : 'text-slate-400 hover:text-slate-200'
                    } ${
                      (sub === 'segments' && !outline) || (sub === 'structure' && segments.length === 0)
                        ? 'opacity-40 cursor-not-allowed'
                        : ''
                    }`}
                  >
                    {i + 1}. {sub}
                  </button>
                ))}
              </div>

              {geminiQuotaNotice && (
                <div className="shrink-0 mx-3 mt-2 mb-0 rounded-lg border border-red-700/50 bg-red-950/50 px-3 py-2 text-xs text-red-200 leading-snug">
                  <p className="font-semibold text-red-100 mb-0.5">AI paused (quota / rate limit)</p>
                  <p>{geminiQuotaNotice}</p>
                </div>
              )}

              {/* Step 1a: Outline */}
              {step1Sub === 'outline' && (
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                  <div>
                    <h3 className="text-white font-semibold text-sm mb-1">Step 1 — Draw Roof Outline</h3>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      Trace the <strong className="text-slate-200">complete outer boundary</strong> of the roof. Include all sections — gables, overhangs, and additions.
                      AI will validate your outline and estimate coverage quality.
                      <span className="block mt-1.5 text-slate-500">
                        A <strong className="text-slate-400">dashed line follows your cursor</strong> from the last corner so you can see the next edge before you click.
                        {' '}
                        <kbd className="rounded border border-slate-600 bg-slate-800/80 px-1 py-0.5 font-mono text-[10px]">⌘Z</kbd>{' '}
                        / <kbd className="rounded border border-slate-600 bg-slate-800/80 px-1 py-0.5 font-mono text-[10px]">Ctrl+Z</kbd> undo last corner ·{' '}
                        <span className="text-slate-400">click near the first corner to close</span> (or use Close outline).
                        {' '}<kbd className="rounded border border-slate-600 bg-slate-800/80 px-1 py-0.5 font-mono text-[10px]">Esc</kbd> cancels.
                      </span>
                    </p>
                  </div>

                  {!outline && !outlineSketchMode && (
                    <button
                      onClick={() => startOutlineSketch()}
                      disabled={!mapLoaded || isDrawing}
                      className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                    >
                      <Pencil size={14} />
                      Draw Roof Outline
                    </button>
                  )}

                  {!outline && outlineSketchMode && (
                    <div className="flex flex-col gap-2 rounded-xl border border-orange-700/40 bg-orange-950/25 p-3">
                      <div className="text-xs text-orange-100/90 leading-snug">
                        {outlineSketchPointCount === 0
                          ? 'Click the map to place the first corner of the roof outline.'
                          : `${outlineSketchPointCount} corner${outlineSketchPointCount === 1 ? '' : 's'} placed — add more, undo a mistake, or close the outline.`}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={undoOutlineSketchLastPoint}
                          disabled={outlineSketchPointCount === 0}
                          className="touch-manipulation inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Undo2 size={14} aria-hidden />
                          Undo last point
                        </button>
                        <button
                          type="button"
                          onClick={() => finalizeOutlineSketch()}
                          disabled={outlineSketchPointCount < 3}
                          className="touch-manipulation inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-500 disabled:bg-slate-600 disabled:text-slate-400 disabled:cursor-not-allowed"
                        >
                          Close outline
                        </button>
                      </div>
                    </div>
                  )}

                  {outline && (
                    <div className="flex flex-col gap-3">
                      <div className="bg-orange-900/30 border border-orange-700/40 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-orange-300">Roof Outline</span>
                          <div className="flex items-center gap-1.5">
                            {outline.analyzing && <Loader2 size={12} className="animate-spin text-blue-400" />}
                            <button
                              onClick={() => {
                                outline.polygon.setMap(null);
                                setOutline(null);
                              }}
                              className="text-slate-400 hover:text-red-400 transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                        <div className="text-xs text-slate-400">{outline.path.length} vertices drawn</div>
                        {outline.analyzing && (
                          <div className="text-xs text-blue-400 mt-1 flex items-center gap-1">
                            <Loader2 size={11} className="animate-spin" /> AI analyzing outline…
                          </div>
                        )}
                        {outline.analysis && (
                          <div className="mt-2 flex flex-col gap-1.5 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Quality</span>
                              <QualityBadge score={outline.analysis.qualityScore} />
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Coverage</span>
                              <QualityBadge score={outline.analysis.coverage} />
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Est. Area</span>
                              <span className="text-white font-medium">{Math.round(outline.analysis.areaEstimateSqFt).toLocaleString()} sqft</span>
                            </div>
                            {outline.analysis.notes && (
                              <div className="mt-1 text-slate-300 italic leading-relaxed">{outline.analysis.notes}</div>
                            )}
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => startOutlineSketch()}
                        className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
                      >
                        <RotateCcw size={12} /> Redraw outline
                      </button>
                    </div>
                  )}

                  {outline && (
                    <button
                      onClick={goToSegments}
                      className="mt-auto flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                    >
                      Next: Trace Segments <ChevronRight size={15} />
                    </button>
                  )}
                </div>
              )}

              {/* Step 1b: Segments */}
              {step1Sub === 'segments' && (
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                  <div>
                    <h3 className="text-white font-semibold text-sm mb-1">Step 2 — Trace Each Segment</h3>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      Draw each <strong className="text-slate-200">roof section</strong> one at a time. When you{' '}
                      <strong className="text-slate-200">finish</strong> a segment (double-click to close), AI classifies{' '}
                      <strong className="text-slate-200">that segment immediately</strong> (one at a time in the queue). After
                      editing vertices on the map, use <strong className="text-slate-200">Re-analyze</strong> on a card to refresh
                      pitch and facing.
                    </p>
                  </div>

                  {/* Vertex+Edge drawer (active) */}
                  {vertexEdgeActive && mapInstanceRef.current && (
                    <RoofVertexEdgeDrawer
                      map={mapInstanceRef.current}
                      outline={outline?.polygon ?? null}
                      onDone={onVertexEdgeDone}
                      onCancel={() => setVertexEdgeActive(false)}
                    />
                  )}

                  {/* DrawingManager polygon mode (active) */}
                  {segmentSketchMode && (
                    <div className="flex flex-col gap-2 rounded-xl border border-blue-700/40 bg-blue-900/20 p-3">
                      <div className="text-xs font-semibold text-blue-200">Drawing active</div>
                      <div className="text-xs text-slate-300 leading-relaxed">
                        Click corners on the map to trace the segment outline.{' '}
                        <strong className="text-white">Double-click</strong> the last point to finish.
                      </div>
                      <button
                        type="button"
                        onClick={() => { clearSegmentSketch(); drawingManagerRef.current?.setDrawingMode(null); }}
                        className="touch-manipulation inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700"
                      >
                        <X size={13} aria-hidden />
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Drawing mode buttons — shown when neither drawer is active */}
                  {!segmentSketchMode && !vertexEdgeActive && (
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => {
                          clearSegmentSketch();
                          drawingManagerRef.current?.setDrawingMode(null);
                          setVertexEdgeActive(true);
                        }}
                        disabled={!mapLoaded || isDrawing || autoSegmenting}
                        className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors shrink-0"
                      >
                        <Pencil size={14} />
                        {autoSegmenting ? 'Please wait…' : `Draw Segment${segments.length > 0 ? 's' : ''}`}
                      </button>
                      <button
                        onClick={() => startSegmentSketch(SEGMENT_COLORS[segments.length % SEGMENT_COLORS.length])}
                        disabled={!mapLoaded || isDrawing || autoSegmenting}
                        className="flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 text-xs font-medium py-2 px-4 rounded-lg transition-colors shrink-0"
                      >
                        <Pencil size={12} />
                        Quick draw (polygon)
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    {segments.map(seg => (
                      <div
                        key={seg.id}
                        className="rounded-xl border p-3"
                        style={{ borderColor: seg.color + '60', backgroundColor: seg.color + '18' }}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
                            <span className="text-xs font-semibold text-white">Segment {seg.index + 1}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {seg.analyzing && <Loader2 size={12} className="animate-spin text-blue-400" />}
                            {hasAiVision && (
                              <button
                                type="button"
                                title="Re-run AI on this polygon (use after editing shape)"
                                disabled={seg.analyzing}
                                onClick={() => reanalyzeSegment(seg.id)}
                                className="text-slate-400 hover:text-blue-300 transition-colors disabled:opacity-40"
                              >
                                <RefreshCw size={13} />
                              </button>
                            )}
                            <button onClick={() => deleteSegment(seg.id)} className="text-slate-400 hover:text-red-400 transition-colors">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                        {seg.analyzing && (
                          <div className="text-xs text-blue-400 flex items-center gap-1">
                            <Loader2 size={11} className="animate-spin" /> AI classifying…
                          </div>
                        )}
                        {seg.dsmPitchDeg !== undefined && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            <span className="bg-cyan-800 text-cyan-200 text-xs px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                              <Zap size={9} /> DSM
                            </span>
                            <span className="bg-cyan-900/70 text-cyan-300 text-xs px-2 py-0.5 rounded-full">{seg.dsmPitchRatio} ({seg.dsmPitchDeg}°)</span>
                            <span className="bg-cyan-900/70 text-cyan-300 text-xs px-2 py-0.5 rounded-full">{seg.dsmFacingDirection}</span>
                            <span className="text-xs text-cyan-500">{Math.round((seg.dsmConfidence ?? 0) * 100)}% conf</span>
                          </div>
                        )}
                        {!seg.dsmPitchDeg && seg.analysis && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full capitalize">{seg.analysis.type}</span>
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full">{seg.analysis.facingDirection}</span>
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full">{seg.analysis.pitchEstimate}</span>
                            <span className="text-xs text-slate-400">{Math.round(seg.analysis.confidence * 100)}% conf</span>
                          </div>
                        )}
                        {!seg.dsmPitchDeg && seg.analysis?.notes && (
                          <div className="text-xs text-slate-400 mt-1 italic">{seg.analysis.notes}</div>
                        )}
                        {!seg.analyzing && !seg.analysis && !hasAiVision && (
                          <div className="text-xs text-slate-500">{seg.path.length} vertices</div>
                        )}
                      </div>
                    ))}
                    {segments.length === 0 && !autoSegmenting && (
                      <div className="text-center py-6 text-slate-500 text-xs">
                        No segments drawn yet.<br />Draw each distinct roof section<br />or use auto-detect below.
                      </div>
                    )}
                    {autoSegmenting && (
                      <div className="flex flex-col items-center gap-2 py-6 text-cyan-400 text-xs">
                        <Loader2 size={20} className="animate-spin" />
                        <span>Analysing DSM elevation, then satellite vision (Gemini)…</span>
                      </div>
                    )}
                  </div>

                  {/* DSM Auto-detect */}
                  {solarDataLayers?.dsmUrl && segments.length === 0 && !autoSegmenting && (
                    <button
                      onClick={runAutoSegment}
                      className="flex items-center justify-center gap-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors"
                    >
                      <Zap size={13} /> Auto-detect roof planes from DSM + vision
                    </button>
                  )}
                  {segments.length > 0 && !autoSegmenting && (
                    <>
                      {autoSegmentRanRef.current && (
                        <div className="rounded-lg bg-cyan-900/20 border border-cyan-700/40 px-3 py-2 text-xs text-cyan-300">
                          {segments.length} roof plane{segments.length !== 1 ? 's' : ''} from DSM auto-map
                          {dsmVisionEnrichAppliedRef.current ? ' · Gemini added satellite labels & visual checks' : ''}
                          {' · '}Adjust vertices if needed
                        </div>
                      )}
                      <button
                        onClick={goToStructure}
                        className="mt-auto flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors shrink-0"
                      >
                        All done → Detect Structure <ChevronRight size={15} />
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Step 1c: Structure */}
              {step1Sub === 'structure' && (
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                  <div>
                    <h3 className="text-white font-semibold text-sm mb-1">Step 3 — Structural Map</h3>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      AI analyzes all {segments.length} segment{segments.length !== 1 ? 's' : ''} + the satellite image to detect ridges, hips, valleys, eaves, and rakes.
                    </p>
                  </div>

                  {!structureResult && !structureAnalyzing && (
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={runStructureDetection}
                        disabled={segments.length === 0}
                        className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                      >
                        <Brain size={15} />
                        {hasAiVision ? 'Detect Roof Structure' : 'Build Structure (Fallback)'}
                      </button>
                    </div>
                  )}
                  {structureError && (
                    <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                      {structureError}
                    </div>
                  )}

                  {structureAnalyzing && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-purple-400 text-sm">
                        <Loader2 size={16} className="animate-spin" />
                        AI detecting structural lines…
                      </div>
                      <p className="text-xs text-slate-500 pl-6">If rate-limited, AI pauses ~15 min to protect your quota.</p>
                    </div>
                  )}

                  {structureResult && (
                    <div className="flex flex-col gap-3">
                      <div className="bg-purple-900/30 border border-purple-700/40 rounded-xl p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle2 size={14} className="text-green-400" />
                          <span className="text-xs font-semibold text-white">Structure Detected</span>
                          {structureSource && (
                            <span
                              className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                                structureSource === 'ai'
                                  ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40'
                                  : 'bg-amber-500/20 text-amber-200 border-amber-400/40'
                              }`}
                            >
                              {structureSource === 'ai' ? 'AI model lines' : 'Fallback geometry lines'}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-xs mb-2">
                          <div className="flex justify-between col-span-2">
                            <span className="text-slate-400">Roof type</span>
                            <span className="text-white font-medium capitalize">{structureResult.roofType}</span>
                          </div>
                          <div className="flex justify-between col-span-2">
                            <span className="text-slate-400">Pitch</span>
                            <span className="text-white font-medium">{structureResult.predominantPitch}</span>
                          </div>
                          <div className="flex justify-between col-span-2">
                            <span className="text-slate-400">{dsmResult ? 'DSM 3D area' : 'Area est.'}</span>
                            <span className={`font-medium ${dsmResult ? 'text-cyan-300' : 'text-white'}`}>
                              {dsmResult
                                ? `${dsmResult.totalSloped3dAreaSqFt.toLocaleString()} sqft`
                                : `${Math.round(structureResult.totalAreaSqFt).toLocaleString()} sqft`}
                            </span>
                          </div>
                        </div>
                        <div className="border-t border-slate-700 pt-2 mt-2 flex flex-col gap-1">
                          {structLineSummary.map(r => (
                            <div key={r.type} className="flex items-center gap-2">
                              <div className="w-5 h-0.5 rounded shrink-0" style={{ backgroundColor: EDGE_COLORS[r.type as keyof typeof EDGE_COLORS] }} />
                              <span className="text-xs text-slate-300 capitalize flex-1">{r.type}</span>
                              <span className="text-xs text-slate-400">{r.count}× · ~{r.ft} ft</span>
                            </div>
                          ))}
                        </div>
                        {structureResult.notes && (
                          <div className="text-xs text-slate-400 italic mt-2 leading-relaxed">{structureResult.notes}</div>
                        )}
                      </div>

                      <button
                        onClick={runStructureDetection}
                        className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
                      >
                        <RotateCcw size={12} /> Re-run detection
                      </button>
                    </div>
                  )}

                  {/* DSM Measurements panel */}
                  {structureResult && (dsmAnalyzing || dsmResult || dsmError) && (
                    <div className="bg-cyan-900/20 border border-cyan-700/40 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Layers size={13} className="text-cyan-400" />
                        <span className="text-xs font-semibold text-white">DSM Measurements</span>
                        {dsmResult && (
                          <span className="ml-auto text-[10px] text-cyan-500 font-medium">{dsmResult.dsmResolutionM}m/px</span>
                        )}
                        {!dsmAnalyzing && (
                          <button
                            onClick={runDsmAnalysis}
                            className="ml-auto text-[10px] text-slate-400 hover:text-cyan-300 flex items-center gap-1"
                            title="Re-run DSM analysis"
                          >
                            <RotateCcw size={10} />
                          </button>
                        )}
                      </div>

                      {dsmAnalyzing && (
                        <div className="flex items-center gap-2 text-cyan-400 text-xs">
                          <Loader2 size={12} className="animate-spin" />
                          Fetching Solar DSM elevation data…
                        </div>
                      )}

                      {dsmError && !dsmAnalyzing && (
                        <div className="text-xs text-amber-300 leading-relaxed">{dsmError}</div>
                      )}

                      {dsmResult && !dsmAnalyzing && (
                        <div className="flex flex-col gap-2">
                          {/* Overall totals */}
                          <div className="grid grid-cols-1 gap-1 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-400">True 3D area</span>
                              <span className="text-cyan-300 font-semibold">{dsmResult.totalSloped3dAreaSqFt.toLocaleString()} sqft</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Ground footprint</span>
                              <span className="text-white font-medium">{dsmResult.totalGroundAreaSqFt.toLocaleString()} sqft</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Avg pitch</span>
                              <span className="text-white font-medium">
                                {dsmResult.overallPitchDeg}° · {pitchDegToRatio(dsmResult.overallPitchDeg)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Predominant facing</span>
                              <span className="text-white font-medium">{dsmResult.overallFacingDirection}</span>
                            </div>
                          </div>

                          {/* Per-segment breakdown */}
                          {dsmResult.segments.some(s => s.pixelCount > 0) && (
                            <div className="border-t border-slate-700 pt-2">
                              <div className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-wide">Per segment</div>
                              <div className="flex flex-col gap-1.5">
                                {dsmResult.segments.map((seg, i) => seg.pixelCount > 0 && (
                                  <div key={i} className="rounded-lg bg-slate-800/60 px-2 py-1.5">
                                    <div className="flex items-center justify-between mb-1">
                                      <div className="flex items-center gap-1.5">
                                        <div
                                          className="w-2.5 h-2.5 rounded-full shrink-0"
                                          style={{ backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
                                        />
                                        <span className="text-xs font-medium text-white">Segment {i + 1}</span>
                                      </div>
                                      <span className="text-[10px] text-cyan-300 font-semibold">{seg.sloped3dAreaSqFt.toLocaleString()} sqft</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                                      <div>Pitch: <span className="text-slate-200">{seg.pitchDeg}° ({seg.pitchRatio})</span></div>
                                      <div>Facing: <span className="text-slate-200">{seg.facingDirection}</span></div>
                                      <div>Ground: <span className="text-slate-200">{seg.groundAreaSqFt.toLocaleString()} sqft</span></div>
                                      <div>Rise: <span className="text-slate-200">{seg.heightDiffFt} ft</span></div>
                                      <div>Ridge ht: <span className="text-slate-200">{seg.ridgeElevationFt} ft</span></div>
                                      <div>Eave ht: <span className="text-slate-200">{seg.eaveElevationFt} ft</span></div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="text-[10px] text-slate-600 italic">
                            Measured from Google Solar DSM · {dsmResult.dsmResolutionM}m/pixel resolution
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Button to manually trigger DSM if not available yet */}
                  {structureResult && !dsmResult && !dsmAnalyzing && !dsmError && solarDataLayers?.dsmUrl && (
                    <button
                      onClick={runDsmAnalysis}
                      className="flex items-center justify-center gap-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-medium py-2 px-4 rounded-lg transition-colors"
                    >
                      <Layers size={13} /> Measure with DSM
                    </button>
                  )}

                  {/* Show "Next" whenever detection is done (success or skip) */}
                  {structureResult && !structureAnalyzing && (
                    <button
                      onClick={goToPhotos}
                      className="mt-auto flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors shrink-0"
                    >
                      Next: Photo Analysis <ChevronRight size={15} />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ────────── Phase 2 ────────── */}
          {phase === 2 && (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              <div>
                <h3 className="text-white font-semibold text-sm mb-1">Multi-Angle Photo Analysis</h3>
                <p className="text-slate-400 text-xs leading-relaxed">
                  Use map viewpoints to capture top/front/back/side/street/3D shots. AI analyzes each captured frame and fuses cues with the structural map.
                </p>
              </div>

              <div className="text-xs text-slate-500">
                {photosAnalyzed}/{photoSlots.length} photos analyzed · {totalCues} total cues
              </div>
              {photoStepError && (
                <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                  {photoStepError}
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                {photoSlots.map(slot => (
                  <div key={slot.id} className="rounded-xl border border-slate-700 overflow-hidden bg-slate-800/50">
                    <div className="flex items-center gap-3 p-2.5">
                      <div className="flex gap-1 shrink-0">
                        <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-700">
                          {slot.previewUrl ? (
                            <img src={slot.previewUrl} alt={slot.label} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500">
                              <Camera size={16} />
                            </div>
                          )}
                        </div>
                        {slot.depthMapUrl && (
                          <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-700 ring-1 ring-violet-500/40" title="Depth map from Depth Pro">
                            <img src={slot.depthMapUrl} alt="depth map" className="w-full h-full object-cover" />
                          </div>
                        )}
                        {slot.depthStatus === 'analyzing' && !slot.depthMapUrl && (
                          <div className="w-12 h-12 rounded-lg bg-slate-700 ring-1 ring-violet-500/30 flex items-center justify-center">
                            <Loader2 size={14} className="animate-spin text-violet-400" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-white">{slot.label}</span>
                          {slot.status === 'analyzing' && <Loader2 size={11} className="animate-spin text-blue-400" />}
                          {slot.status === 'done' && <CheckCircle2 size={11} className="text-green-400" />}
                          {slot.status === 'error' && <AlertCircle size={11} className="text-red-400" />}
                          {slot.depthStatus === 'analyzing' && (
                            <span className="flex items-center gap-0.5 text-[10px] text-violet-400">
                              <Loader2 size={9} className="animate-spin" /> depth
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 truncate">{slot.description}</div>
                        {slot.analysis && (
                          <div className="text-xs text-slate-400 mt-0.5">
                            Quality: <QualityBadge score={slot.analysis.qualityScore} /> · {slot.analysis.cues.length} cues
                            {slot.depthPitchDeg !== null && slot.depthPitchDeg !== undefined && (
                              <span className="ml-2 text-violet-300 font-medium">
                                · Depth pitch ~{slot.depthPitchDeg}° ({slot.depthPitchRatio})
                              </span>
                            )}
                          </div>
                        )}
                        {slot.status === 'done' && slot.analysis && slot.analysis.qualityScore < 0.45 && (
                          <div className="text-[11px] text-amber-300 mt-0.5">
                            Low-confidence cues captured. Reframe and capture again for better accuracy.
                          </div>
                        )}
                        {slot.status === 'error' && (
                          <button
                            onClick={() => reanalyzePhotoSlot(slot.id)}
                            className="mt-1 text-[11px] text-amber-300 hover:text-amber-200 transition-colors"
                          >
                            Re-analyze this capture
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => applyCaptureView(slot.id)}
                          className={`text-slate-300 hover:text-white transition-colors p-1 rounded ${
                            activeCaptureSlot === slot.id ? 'bg-blue-500/20 text-blue-300' : ''
                          }`}
                          title="Show this view on map"
                        >
                          <Map size={13} />
                        </button>
                        <button
                          onClick={() => capturePhotoFromMap(slot.id)}
                          disabled={slot.status === 'analyzing'}
                          className="text-slate-300 hover:text-blue-300 transition-colors p-1 disabled:opacity-40"
                          title="Capture from current map view"
                        >
                          <Camera size={13} />
                        </button>
                        {slot.file && (
                          <button onClick={() => removePhoto(slot.id)} className="text-slate-400 hover:text-red-400 transition-colors p-1">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 mt-auto shrink-0">
                <button
                  onClick={() => setPhase(1)}
                  className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white px-3 py-2 rounded-lg border border-slate-700 hover:border-slate-500 transition-colors"
                >
                  <ChevronLeft size={14} /> Back
                </button>
                <button
                  onClick={goToFinal}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Continue to Final Report
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

          {/* ────────── Phase 3 ────────── */}
          {phase === 3 && (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              <div>
                <h3 className="text-white font-semibold text-sm mb-1">Step 3 · AI Fusion Analysis</h3>
                <p className="text-slate-400 text-xs leading-relaxed">
                  All structural and photo data is ready. Click below to run the AI fusion — then open your full report.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div className="rounded-xl border border-purple-700/40 bg-purple-900/20 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-purple-200 flex items-center gap-1.5">
                      <Layers size={12} /> Step 1 · Structural Map
                    </div>
                    <span className="text-[11px] text-slate-300">{segments.length} segment{segments.length !== 1 ? 's' : ''}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">
                    Roof type {structureResult?.roofType ?? 'unknown'} · pitch {structureResult?.predominantPitch ?? 'n/a'} ·
                    {` cues ${structureResult?.cues.length ?? 0}`}
                  </p>
                  {/* DSM pitch summary when auto-segmented */}
                  {segments.some(s => s.dsmPitchDeg !== undefined) && (
                    <div className="mt-2 pt-2 border-t border-purple-700/30">
                      <div className="flex items-center gap-1 mb-1">
                        <Zap size={10} className="text-cyan-400" />
                        <span className="text-[10px] font-semibold text-cyan-300 uppercase tracking-wide">DSM measurements (authoritative)</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {segments.filter(s => s.dsmPitchDeg !== undefined).map((s, i) => (
                          <span key={s.id} className="bg-cyan-900/50 text-cyan-200 text-[10px] px-1.5 py-0.5 rounded-full">
                            Seg {i + 1}: {s.dsmPitchRatio} · {s.dsmFacingDirection}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-blue-700/40 bg-blue-900/20 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-blue-200 flex items-center gap-1.5">
                      <Camera size={12} /> Step 2 · Multi-Angle Photos
                    </div>
                    <span className="text-[11px] text-slate-300">{photosAnalyzed}/{photoSlots.length} analyzed</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">
                    Captured {photoCaptured} frame{photoCaptured !== 1 ? 's' : ''} · {totalCues} total cues extracted
                  </p>
                  {/* Depth consensus row */}
                  {(() => {
                    const consensus = consensusDepthPitch(photoSlots.map(s => s.depthResult ?? null));
                    if (!consensus) return null;
                    return (
                      <div className="mt-2 pt-2 border-t border-blue-700/30 flex items-center justify-between">
                        <span className="text-[11px] text-violet-300 flex items-center gap-1">
                          <Sparkles size={10} /> Depth Pro consensus pitch
                        </span>
                        <span className="text-[11px] font-semibold text-violet-200">
                          ~{consensus.deg}° ({consensus.ratio}) · {consensus.sourceCount} readings
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Data summary cards */}
              <div className="grid grid-cols-1 gap-2">
                <div className="rounded-xl border border-purple-700/40 bg-purple-900/20 p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-purple-200"><Layers size={12} /> Structural Map</div>
                  <span className="text-[11px] text-slate-300">{segments.length} segments · {structureResult?.cues.length ?? 0} cues</span>
                </div>
                <div className="rounded-xl border border-blue-700/40 bg-blue-900/20 p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-blue-200"><Camera size={12} /> Multi-Angle Photos</div>
                  <span className="text-[11px] text-slate-300">{photosAnalyzed}/{photoSlots.length} analyzed · {totalCues} cues</span>
                </div>
              </div>

              {/* ── Not yet run ── */}
              {!finalAnalysis && !finalAnalyzing && (
                <div className="flex flex-col gap-3">
                  {!hasAiVision && (
                    <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                      Gemini API key required for AI fusion. Add it in Settings.
                    </div>
                  )}
                  {finalError && (
                    <div className="rounded-lg border border-red-700/40 bg-red-900/30 px-3 py-2 text-xs text-red-200">
                      {finalError}
                    </div>
                  )}
                  <button
                    onClick={runFinalAnalysis}
                    disabled={!hasAiVision}
                    className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 px-4 rounded-xl transition-colors"
                  >
                    <Brain size={16} /> Run AI Analysis
                  </button>
                </div>
              )}

              {/* ── Running ── */}
              {finalAnalyzing && (
                <div className="flex flex-col items-center gap-3 py-8 rounded-xl border border-purple-700/40 bg-purple-900/20">
                  <Loader2 size={32} className="animate-spin text-purple-400" />
                  <div className="text-sm font-medium text-purple-200">AI synthesizing all data…</div>
                  <div className="text-xs text-slate-400">Combining structural map, {photosAnalyzed} photos, and satellite imagery</div>
                </div>
              )}

              {/* ── Done ── */}
              {finalAnalysis && !finalAnalyzing && (
                <div className="flex flex-col gap-3">
                  {/* Result badge */}
                  <div className={`rounded-xl p-4 border flex items-center justify-between ${
                    finalAnalysis.condition === 'Excellent' || finalAnalysis.condition === 'Good'
                      ? 'bg-green-900/40 border-green-700/50'
                      : finalAnalysis.condition === 'Fair'
                      ? 'bg-amber-900/40 border-amber-700/50'
                      : 'bg-red-900/40 border-red-700/50'
                  }`}>
                    <div>
                      <div className="text-xs text-slate-400 mb-0.5">Roof Condition</div>
                      <div className="text-xl font-bold text-white">{finalAnalysis.condition} <span className="text-slate-400 text-sm font-normal">{finalAnalysis.condition_score}/100</span></div>
                      <div className="text-xs text-slate-400 mt-0.5">{finalAnalysis.estimated_remaining_life} remaining</div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      finalAnalysis.urgency === 'Low' ? 'bg-green-500/20 text-green-300'
                      : finalAnalysis.urgency === 'Medium' ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-red-500/20 text-red-300'
                    }`}>{finalAnalysis.urgency} urgency</span>
                  </div>

                  {/* Open Full Report — primary CTA */}
                  <button
                    onClick={() => setShowFullReport(true)}
                    className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold py-3 px-4 rounded-xl transition-colors"
                  >
                    <FileSpreadsheet size={16} /> Open Full Report
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={downloadFinalReport} className="text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-600 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5">
                      <Download size={12} /> Download
                    </button>
                    <button onClick={() => void shareFinalReport()} className="text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-600 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5">
                      <Share2 size={12} /> Share
                    </button>
                    <button
                      onClick={() => void saveQuoteDraftToProject()}
                      disabled={quoteDraftSaved}
                      className="col-span-2 text-xs text-white bg-emerald-700 hover:bg-emerald-600 disabled:opacity-70 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      {quoteDraftSaved ? <><CheckCircle2 size={12} /> Saved to project</> : <><FileSpreadsheet size={12} /> Save Quote Draft</>}
                    </button>
                  </div>

                  {/* Save Project — persists everything and opens a fresh analysis */}
                  <button
                    onClick={() => void handleSaveAndNew()}
                    disabled={projectSaving}
                    className="flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-white text-sm font-semibold py-2.5 px-4 rounded-xl transition-colors"
                  >
                    {projectSaving
                      ? <><Loader2 size={14} className="animate-spin" /> Saving…</>
                      : <><FolderOpen size={14} /> Save Project</>}
                  </button>

                  <button onClick={runFinalAnalysis} className="text-xs text-slate-500 hover:text-white flex items-center gap-1.5 transition-colors">
                    <RotateCcw size={11} /> Re-run analysis
                  </button>
                </div>
              )}

              {!hasAiVision && !finalAnalysis && !finalAnalyzing && (
                <p className="text-[11px] text-slate-500">Add your Gemini key in Settings to enable AI fusion.</p>
              )}

              <button
                onClick={() => setPhase(2)}
                className="shrink-0 flex items-center gap-1.5 text-sm text-slate-400 hover:text-white px-3 py-2 rounded-lg border border-slate-700 hover:border-slate-500 transition-colors"
              >
                <ChevronLeft size={14} /> Back to Photos
              </button>
            </div>
          )}
        </div>
      </div>

      {phase === 3 && showFullReport && (finalAnalyzing || finalAnalysis) && (
        <div className="fixed inset-0 z-[80] bg-slate-950/85 backdrop-blur-sm p-4 sm:p-6">
          <div className="h-full w-full rounded-2xl border border-slate-300 bg-slate-100 shadow-2xl overflow-hidden flex flex-col">
            <div className="shrink-0 border-b border-slate-300 bg-white px-4 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-500 truncate">{address}</p>
                <h2 className="text-sm sm:text-base font-semibold text-slate-900">AI Roof Intelligence Report</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadFinalReport}
                  className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5"
                >
                  <Download size={12} /> Download
                </button>
                <button
                  onClick={() => void shareFinalReport()}
                  className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5"
                >
                  <Share2 size={12} /> Share
                </button>
                <button
                  onClick={() => void saveQuoteDraftToProject()}
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5"
                >
                  <FileSpreadsheet size={12} /> {quoteDraftSaved ? 'Saved ✓' : 'Quote'}
                </button>
                <button
                  onClick={() => setShowFullReport(false)}
                  className="text-xs bg-slate-900 text-white px-2.5 py-1.5 rounded-md"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="rounded-xl border border-slate-300 bg-white p-4 lg:col-span-2">
                  <h3 className="text-sm font-semibold text-slate-800 mb-2">All Structures Summary</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Roof Area</p>
                      <p className="text-slate-900 font-semibold">{Math.round(structureResult?.totalAreaSqFt ?? mappedAreaSqFt).toLocaleString()} sq ft</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Segments</p>
                      <p className="text-slate-900 font-semibold">{segments.length}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Predominant Pitch</p>
                      <p className="text-slate-900 font-semibold">{structureResult?.predominantPitch ?? 'n/a'}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Final Score</p>
                      <p className="text-slate-900 font-semibold">{finalAnalysis ? `${finalAnalysis.condition_score}/100` : 'running…'}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Ridges</p>
                      <p className="text-slate-900 font-semibold">{edgeTotals.ridge} ft</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Hips</p>
                      <p className="text-slate-900 font-semibold">{edgeTotals.hip} ft</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Valleys</p>
                      <p className="text-slate-900 font-semibold">{edgeTotals.valley} ft</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-2">
                      <p className="text-slate-500">Eaves + Rakes</p>
                      <p className="text-slate-900 font-semibold">{edgeTotals.eave + edgeTotals.rake} ft</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-300 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-800 mb-2">Pitch Mix</h3>
                  <div className="space-y-1.5 text-xs">
                    {Object.keys(pitchMix).length === 0 && <p className="text-slate-500">No pitch data yet</p>}
                    {Object.entries(pitchMix).map(([pitch, count]) => (
                      <div key={pitch} className="flex items-center justify-between border-b border-slate-100 pb-1">
                        <span className="text-slate-600">{pitch}</span>
                        <span className="font-semibold text-slate-900">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-2">Pitch & Direction Measurement Report</h3>
                <div className="overflow-x-auto">
                  <svg viewBox={`0 0 ${diagramWidth} ${diagramHeight}`} className="w-full h-auto rounded-lg border border-slate-200 bg-slate-50">
                    {reportPolygons.map(poly => {
                      const hasPitch  = poly.pitch  && poly.pitch  !== 'n/a';
                      const hasFacing = poly.facing && poly.facing !== 'n/a';
                      const label = hasPitch && hasFacing
                        ? `${poly.pitch} · ${poly.facing}`
                        : hasPitch  ? poly.pitch
                        : hasFacing ? poly.facing
                        : null;
                      return (
                        <g key={poly.id}>
                          <polygon
                            points={poly.points.map(p => `${p.x},${p.y}`).join(' ')}
                            fill={`${poly.color}2A`}
                            stroke={poly.color}
                            strokeWidth={2}
                          />
                          {label && (
                            <text x={poly.center.x} y={poly.center.y - 8} textAnchor="middle" fontSize="16" fontWeight="700" fill="#0f172a">
                              {label}
                            </text>
                          )}
                          <text x={poly.center.x} y={label ? poly.center.y + 14 : poly.center.y + 6} textAnchor="middle" fontSize="14" fill="#334155">
                            {poly.areaSqFt > 0 ? `${poly.areaSqFt} sq ft` : ''}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  Imagery source: {solarData?.imageryQuality ?? 'unknown'} quality
                  {solarData?.imageryDate ? ` · ${solarData.imageryDate.year}-${String(solarData.imageryDate.month).padStart(2, '0')}-${String(solarData.imageryDate.day).padStart(2, '0')}` : ''}
                </div>
              </div>

              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-2">Area Measurement Report</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-slate-500">Total Roof Area</p>
                    <p className="text-slate-900 font-semibold">{Math.round(structureResult?.totalAreaSqFt ?? mappedAreaSqFt)} sq ft</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-slate-500">Flat Roof Area</p>
                    <p className="text-slate-900 font-semibold">
                      {Math.round(
                        reportPolygons
                          .filter(poly => poly.pitch === 'flat' || poly.pitch === '2/12')
                          .reduce((sum, poly) => sum + poly.areaSqFt, 0)
                      )} sq ft
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-slate-500">Pitched Roof Area</p>
                    <p className="text-slate-900 font-semibold">
                      {Math.max(
                        0,
                        Math.round(structureResult?.totalAreaSqFt ?? mappedAreaSqFt) -
                          Math.round(
                            reportPolygons
                              .filter(poly => poly.pitch === 'flat' || poly.pitch === '2/12')
                              .reduce((sum, poly) => sum + poly.areaSqFt, 0)
                          )
                      )} sq ft
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2">
                    <p className="text-slate-500">Predominant Pitch</p>
                    <p className="text-slate-900 font-semibold">{structureResult?.predominantPitch ?? 'n/a'}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-2">Material Quote Preview</h3>
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
                      <div className="col-span-9 text-right">Estimated Total</div>
                      <div className="col-span-3 text-right">${quoteTotal.toLocaleString()}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-300 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-800 mb-1.5">Pathway 1: Structural</h3>
                  <p className="text-xs text-slate-600">{structureResult?.notes ?? 'Mapped from user traces and AI edge extraction.'}</p>
                </div>
                <div className="rounded-xl border border-slate-300 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-800 mb-1.5">Pathway 2: Multi-Angle</h3>
                  <p className="text-xs text-slate-600">
                    {photosAnalyzed}/{photoSlots.length} analyzed · {totalCues} cues · source {finalSource ?? 'pending'}.
                  </p>
                </div>
              </div>

              {finalAnalyzing && (
                <div className="rounded-xl border border-blue-300 bg-blue-50 p-4">
                  <div className="flex items-center gap-2 text-blue-700 text-sm font-medium">
                    <Loader2 size={16} className="animate-spin" />
                    Running deep fusion analysis across both pathways…
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
