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
    const loader = new Loader({ apiKey, version: 'weekly', libraries: ['places', 'drawing', 'geometry'] });
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
} from 'lucide-react';
import type { Coordinates } from '../types';
import type { SolarBuildingInsights, SolarDataLayersResponse } from '../utils/solar';
import { analyzeDsmForSegments, autoSegmentRoofPlanes, pitchDegToRatio, type DsmAnalysisResult } from '../utils/roofDsm';
import { segmentRoofFromSatellite } from '../utils/roofAiSegment';
import {
  analyzeRoofOutline,
  analyzeRoofSegment,
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
import { isDbConfigured, saveWizardWorkflowReport, type WizardWorkflowReportPayload } from '../utils/db';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

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
  /** When true, auto-runs Gemini AI visual segmentation as soon as satellite image is ready. */
  aiSegmentMode?: boolean;
  onClose: () => void;
}

// ─── Helper components ────────────────────────────────────────────────────────

function PhaseTab({ phase, current, label, sublabel }: { phase: Phase; current: Phase; label: string; sublabel: string }) {
  const isActive = phase === current;
  const isDone = phase < current;
  return (
    <div className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
      isActive ? 'bg-blue-600 text-white' : isDone ? 'bg-green-600/20 text-green-400' : 'bg-slate-700/50 text-slate-400'
    }`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
        isActive ? 'bg-white text-blue-600' : isDone ? 'bg-green-500 text-white' : 'bg-slate-600 text-slate-300'
      }`}>
        {isDone ? <Check size={12} /> : phase}
      </div>
      <div>
        <div className="text-xs font-semibold">{label}</div>
        <div className="text-xs opacity-70">{sublabel}</div>
      </div>
    </div>
  );
}

function QualityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'text-green-400' : pct >= 55 ? 'text-amber-400' : 'text-red-400';
  return <span className={`font-bold ${color}`}>{pct}%</span>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RoofMappingWizard({ apiKey, address, coordinates, solarData, solarDataLayers, existingProjectId = null, forceNewProject = false, onPersisted, autoSegmentMode = false, aiSegmentMode = false, onClose }: Props) {
  // Map refs
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
  const structLinesRef = useRef<google.maps.Polyline[]>([]);

  // State
  const [phase, setPhase] = useState<Phase>(1);
  const [step1Sub, setStep1Sub] = useState<'outline' | 'segments' | 'structure'>('outline');
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);

  const [outline, setOutline] = useState<DrawnOutline | null>(null);
  const [segments, setSegments] = useState<DrawnSegment[]>([]);
  const [structureResult, setStructureResult] = useState<StructuralDetection | null>(null);
  const [structureAnalyzing, setStructureAnalyzing] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [structureSource, setStructureSource] = useState<'ai' | 'fallback' | null>(null);

  const [dsmResult, setDsmResult] = useState<DsmAnalysisResult | null>(null);
  const [dsmAnalyzing, setDsmAnalyzing] = useState(false);
  const [dsmError, setDsmError] = useState<string | null>(null);

  const [autoSegmenting, setAutoSegmenting] = useState(false);
  const [autoSegmentError, setAutoSegmentError] = useState<string | null>(null);
  const autoSegmentRanRef = useRef(false);

  const [aiSegmenting, setAiSegmenting] = useState(false);
  const [aiSegmentError, setAiSegmentError] = useState<string | null>(null);
  const aiSegmentRanRef = useRef(false);

  const [photoSlots, setPhotoSlots] = useState<PhotoSlot[]>(INITIAL_PHOTO_SLOTS);
  const [activeCaptureSlot, setActiveCaptureSlot] = useState<PhotoSlotId>('top');
  const [photoStepError, setPhotoStepError] = useState<string | null>(null);

  const [finalAnalysis, setFinalAnalysis] = useState<Awaited<ReturnType<typeof analyzeCombinedRoof>>>(null);
  const [finalAnalyzing, setFinalAnalyzing] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  const [finalSource, setFinalSource] = useState<'ai' | 'fallback' | null>(null);
  const [showFullReport, setShowFullReport] = useState(false);
  const [persistStatus, setPersistStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Satellite image cache for Gemini calls
  const satelliteImageRef = useRef<{ data: string; mimeType: string } | null>(null);
  const [imageReady, setImageReady] = useState(false);

  const hasGeminiKey = !!readGeminiApiKey();

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

  const startDrawing = useCallback((color = '#3b82f6') => {
    if (!drawingManagerRef.current) return;
    drawingManagerRef.current.setOptions({
      polygonOptions: {
        fillColor: color,
        strokeColor: color,
        fillOpacity: 0.2,
        strokeWeight: 2.5,
        editable: true,
        draggable: false,
      },
    });
    drawingManagerRef.current.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    setIsDrawing(true);
  }, []);

  function polyPath(poly: google.maps.Polygon): { lat: number; lng: number }[] {
    const path: { lat: number; lng: number }[] = [];
    poly.getPath().forEach(ll => path.push({ lat: ll.lat(), lng: ll.lng() }));
    return path;
  }

  function normalizePath(path: { lat: number; lng: number }[]) {
    return path.map(p => latLngToImageNorm(p, coordinates, 20, 640));
  }

  // ── Step 1a: Outline ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapLoaded || step1Sub !== 'outline' || phase !== 1) return;
    const dm = drawingManagerRef.current;
    if (!dm) return;

    const listener = google.maps.event.addListener(dm, 'polygoncomplete', async (polygon: google.maps.Polygon) => {
      stopDrawing();
      polygon.setOptions({ fillColor: '#f97316', strokeColor: '#ea580c', editable: true });

      // Remove previous outline polygon if any
      setOutline(prev => {
        prev?.polygon.setMap(null);
        return null;
      });

      const path = polyPath(polygon);
      const newOutline: DrawnOutline = { polygon, path, analysis: null, analyzing: hasGeminiKey };
      setOutline(newOutline);

      if (!hasGeminiKey) return;

      const normalized = normalizePath(path);
      const imgData = satelliteImageRef.current;

      try {
        const analysis = await analyzeRoofOutline(imgData, normalized);
        setOutline(prev => prev ? { ...prev, analysis, analyzing: false } : prev);
      } catch {
        setOutline(prev => prev ? { ...prev, analyzing: false } : prev);
      }
    });

    return () => google.maps.event.removeListener(listener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, step1Sub, phase, hasGeminiKey]);

  // ── Step 1b: Segments ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapLoaded || step1Sub !== 'segments' || phase !== 1) return;
    const dm = drawingManagerRef.current;
    if (!dm) return;

    const listener = google.maps.event.addListener(dm, 'polygoncomplete', async (polygon: google.maps.Polygon) => {
      stopDrawing();

      setSegments(prev => {
        const idx = prev.length;
        const color = SEGMENT_COLORS[idx % SEGMENT_COLORS.length];
        polygon.setOptions({ fillColor: color, strokeColor: color, fillOpacity: 0.22, editable: true });

        const id = `seg_${Date.now()}`;
        const path = polyPath(polygon);
        const newSeg: DrawnSegment = { id, index: idx, polygon, path, color, analysis: null, analyzing: hasGeminiKey };
        const updated = [...prev, newSeg];

        // Kick off Gemini analysis async
        if (hasGeminiKey) {
          const normalized = path.map(p => latLngToImageNorm(p, coordinates, 20, 640));
          const allPrev = prev.map(s => s.path.map(p => latLngToImageNorm(p, coordinates, 20, 640)));
          const imgData = satelliteImageRef.current;

          analyzeRoofSegment(imgData, normalized, idx, allPrev)
            .then(analysis => {
              setSegments(curr => curr.map(s => s.id === id ? { ...s, analysis, analyzing: false } : s));
            })
            .catch(() => {
              setSegments(curr => curr.map(s => s.id === id ? { ...s, analyzing: false } : s));
            });
        }

        return updated;
      });
    });

    return () => google.maps.event.removeListener(listener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, step1Sub, phase, hasGeminiKey]);

  const deleteSegment = useCallback((id: string) => {
    setSegments(prev => {
      const seg = prev.find(s => s.id === id);
      seg?.polygon.setMap(null);
      return prev.filter(s => s.id !== id);
    });
  }, []);

  // ── Step 1c: Structure detection ────────────────────────────────────────────

  function clearStructureLines() {
    structLinesRef.current.forEach(l => l.setMap(null));
    structLinesRef.current = [];
  }

  const safeComputeAreaSqFt = useCallback((polygon: google.maps.Polygon): number => {
    try {
      if (typeof google === 'undefined' || !google.maps?.geometry?.spherical) return 0;
      return google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
    } catch {
      return 0;
    }
  }, []);

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
        new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000)),
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
    setAutoSegmentError(null);
    try {
      const buildingBounds = {
        minLat: solarData.boundingBox.sw.latitude,
        maxLat: solarData.boundingBox.ne.latitude,
        minLng: solarData.boundingBox.sw.longitude,
        maxLng: solarData.boundingBox.ne.longitude,
      };
      const detected = await autoSegmentRoofPlanes(dsmUrl, buildingBounds, apiKey);
      if (detected.length === 0) {
        setAutoSegmentError('No distinct roof planes could be detected — DSM may lack sufficient resolution for this building. Draw segments manually.');
        return;
      }
      // Convert to DrawnSegment[] by creating Google Maps polygons
      if (!mapInstanceRef.current) {
        setAutoSegmentError('Map not ready — please try again.');
        return;
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
        return {
          id: `auto_${i}_${Date.now()}`,
          index: i,
          polygon,
          path: seg.path,
          color,
          analysis: null,
          analyzing: false,
        };
      });
      setSegments(newSegments);
      // Jump straight to structure detection step
      setStep1Sub('structure');
    } catch {
      setAutoSegmentError('Auto-detection failed. Please draw segments manually.');
    } finally {
      setAutoSegmenting(false);
    }
  }, [solarDataLayers, solarData, segments.length, apiKey, mapInstanceRef]);

  // When autoSegmentMode is on, trigger once map + solar data are ready
  useEffect(() => {
    if (!autoSegmentMode || autoSegmentRanRef.current) return;
    if (!mapLoaded || !solarDataLayers?.dsmUrl || !solarData?.boundingBox) return;
    autoSegmentRanRef.current = true;
    void runAutoSegment();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSegmentMode, mapLoaded, solarDataLayers, solarData]);

  // ── AI Visual Segmentation (Gemini DeepLabv3+-inspired) ──────────────────────

  const runAiSegment = useCallback(async () => {
    const imgData = satelliteImageRef.current;
    if (!imgData?.data) return;
    if (segments.length > 0) return;
    setAiSegmenting(true);
    setAiSegmentError(null);
    try {
      const detected = await segmentRoofFromSatellite(
        imgData.data,
        imgData.mimeType,
        coordinates.lat,
        coordinates.lng,
        20,   // zoom level used when capturing satellite image
        640,  // logical image size
      );
      if (detected.length === 0) {
        setAiSegmentError('No roof planes detected — Gemini could not identify distinct planes in this image. Try the DSM Auto-Map route or draw manually.');
        return;
      }
      if (!mapInstanceRef.current) {
        setAiSegmentError('Map not ready — please try again.');
        return;
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
        return {
          id: `ai_${i}_${Date.now()}`,
          index: i,
          polygon,
          path: seg.path,
          color,
          analysis: null,
          analyzing: false,
        };
      });
      setSegments(newSegments);
      setStep1Sub('structure');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiSegmentError(
        msg.includes('NO_GEMINI_KEY')
          ? 'No Gemini API key found. Add your key in Settings → API Keys.'
          : msg.includes('NO_IMAGE')
          ? 'Satellite image not yet loaded — please wait a moment and try again.'
          : 'AI segmentation failed. Please draw segments manually or use DSM Auto-Map.'
      );
    } finally {
      setAiSegmenting(false);
    }
  }, [satelliteImageRef, segments.length, coordinates, mapInstanceRef]);

  // When aiSegmentMode is on, trigger once the satellite image is ready
  useEffect(() => {
    if (!aiSegmentMode || aiSegmentRanRef.current) return;
    if (!imageReady || !satelliteImageRef.current?.data) return;
    aiSegmentRanRef.current = true;
    void runAiSegment();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSegmentMode, imageReady]);

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
      };
    }));

    try {
      let analysis = await deriveVisionRoofCuesFromFile(file, slotId);
      if (!analysis) analysis = buildFallbackPhotoAnalysis(slotId);
      setPhotoSlots(prev => prev.map(s => s.id === slotId
        ? { ...s, status: analysis ? 'done' : 'error', analysis }
        : s
      ));
      setFinalAnalysis(null);
      setFinalSource(null);
      setFinalError(null);
      if (analysis) setPhotoStepError(null);
    } catch {
      const fallback = buildFallbackPhotoAnalysis(slotId);
      setPhotoSlots(prev => prev.map(s => s.id === slotId
        ? { ...s, status: fallback ? 'done' : 'error', analysis: fallback }
        : s
      ));
      setFinalAnalysis(null);
      setFinalSource(null);
      setFinalError(null);
      if (fallback) setPhotoStepError(null);
    }
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

  const downloadQuoteDraft = useCallback(() => {
    if (!finalAnalysis) return;
    const mappedArea = segments.reduce((sum, segment) => sum + safeComputeAreaSqFt(segment.polygon), 0);
    const structureArea = Math.max(1, Math.round(structureResult?.totalAreaSqFt ?? mappedArea));
    const squares = Math.max(1, Math.round(structureArea / 100));
    const baseRate =
      finalAnalysis.condition === 'Excellent'
        ? 380
        : finalAnalysis.condition === 'Good'
          ? 430
          : finalAnalysis.condition === 'Fair'
            ? 520
            : finalAnalysis.condition === 'Poor'
              ? 610
              : 690;
    const subtotal = squares * baseRate;
    const tax = Math.round(subtotal * 0.13);
    const total = subtotal + tax;

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = 44;
    doc.setFontSize(18);
    doc.text('Roof Quote Draft', 40, y);
    y += 20;
    doc.setFontSize(10);
    doc.setTextColor(80);
    doc.text(address, 40, y);
    y += 16;
    doc.text(`Condition: ${finalAnalysis.condition} (${finalAnalysis.condition_score}/100)`, 40, y);
    y += 12;
    doc.text(`Urgency: ${finalAnalysis.urgency}`, 40, y);
    y += 18;

    autoTable(doc, {
      startY: y,
      head: [['Line Item', 'Qty', 'Unit', 'Amount']],
      body: [
        ['Roof System', `${squares} sq`, `$${baseRate}`, `$${subtotal}`],
        ['Assessment/QA', '1', '$350', '$350'],
        ['Disposal & Cleanup', '1', '$420', '$420'],
      ],
      styles: { fontSize: 10 },
      theme: 'grid',
    });
    const afterItems = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 100;
    doc.setTextColor(20);
    doc.setFontSize(11);
    doc.text(`Subtotal: $${(subtotal + 770).toLocaleString()}`, 40, afterItems + 20);
    doc.text(`Estimated Tax: $${tax.toLocaleString()}`, 40, afterItems + 36);
    doc.setFontSize(13);
    doc.text(`Estimated Total: $${(total + 770).toLocaleString()}`, 40, afterItems + 56);
    doc.setFontSize(10);
    doc.setTextColor(70);
    doc.text(`Recommended Scope: ${finalAnalysis.recommendation}`, 40, afterItems + 82, { maxWidth: 500 });
    doc.save(`quote-draft-${Date.now()}.pdf`);
  }, [address, finalAnalysis, structureResult, segments, safeComputeAreaSqFt]);

  // ── Step navigation ─────────────────────────────────────────────────────────

  function goToSegments() {
    setStep1Sub('segments');
    stopDrawing();
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
    const pitch = segment.analysis?.pitchEstimate ?? 'unknown';
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
  const diagramHeight = 560;
  const diagramPadding = 28;
  const toDiagramPoint = (point: { lat: number; lng: number }) => {
    if (!diagramBounds) return { x: diagramPadding, y: diagramPadding };
    const spanLng = Math.max(1e-6, diagramBounds.maxLng - diagramBounds.minLng);
    const spanLat = Math.max(1e-6, diagramBounds.maxLat - diagramBounds.minLat);
    const xNorm = (point.lng - diagramBounds.minLng) / spanLng;
    const yNorm = (diagramBounds.maxLat - point.lat) / spanLat;
    return {
      x: diagramPadding + xNorm * (diagramWidth - diagramPadding * 2),
      y: diagramPadding + yNorm * (diagramHeight - diagramPadding * 2),
    };
  };
  const reportPolygons = segments.map(segment => {
    const pts = segment.path.map(toDiagramPoint);
    return {
      id: segment.id,
      color: segment.color,
      pitch: segment.analysis?.pitchEstimate ?? 'n/a',
      facing: segment.analysis?.facingDirection ?? 'n/a',
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

  useEffect(() => {
    if (phase !== 3 || finalAnalyzing || finalAnalysis) return;
    void runFinalAnalysis();
  }, [phase, finalAnalyzing, finalAnalysis, runFinalAnalysis]);

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
    const timer = window.setTimeout(() => {
      if (!cancelled) setPersistStatus('saving');
    }, 250);
    (async () => {
      try {
        const payload: WizardWorkflowReportPayload = {
          version: 'v1',
          source: 'roof-mapping-wizard',
          address,
          coordinates,
          outline: outline
            ? {
                points: outline.path,
                analysis: outline.analysis,
              }
            : null,
          segments: segments.map(segment => ({
            id: segment.id,
            index: segment.index,
            color: segment.color,
            path: segment.path,
            analysis: segment.analysis,
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
              slot.captureImageDataUrl && slot.captureImageDataUrl.length < 350_000
                ? slot.captureImageDataUrl
                : null,
            capturedAtIso: slot.capturedAtIso ?? null,
          })),
          finalAnalysis,
          updatedAtIso: new Date().toISOString(),
        };
        const saved = await saveWizardWorkflowReport(payload, {
          projectId: existingProjectId ?? undefined,
          forceNewProject: forceNewProject && !existingProjectId,
        });
        if (!cancelled) {
          setPersistStatus('saved');
          onPersisted?.(saved.projectId);
        }
      } catch {
        if (!cancelled) setPersistStatus('error');
      } finally {
        window.clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [address, coordinates, outline, segments, structureResult, photoSlots, finalAnalysis]);

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
      {/* ── Top bar ── */}
      <div className="shrink-0 bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center gap-4">
        <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1">
          <X size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-400 truncate">{address}</div>
          <div className="text-sm font-semibold text-white">Smart Roof Mapping Wizard</div>
        </div>
        <div className="flex items-center gap-2">
          <PhaseTab phase={1} current={phase} label="Structural Map" sublabel="Draw & analyze" />
          <ChevronRight size={14} className="text-slate-600" />
          <PhaseTab phase={2} current={phase} label="Photo Analysis" sublabel="Multi-angle" />
          <ChevronRight size={14} className="text-slate-600" />
          <PhaseTab phase={3} current={phase} label="Final Report" sublabel="Combined AI" />
        </div>
        {!hasGeminiKey && (
          <div className="flex items-center gap-1.5 bg-amber-900/40 border border-amber-700/50 text-amber-300 text-xs px-3 py-1.5 rounded-lg">
            <AlertCircle size={13} />
            No Gemini key — AI disabled
          </div>
        )}
        {persistStatus !== 'idle' && (
          <div
            className={`text-[11px] px-2.5 py-1 rounded-md border ${
              persistStatus === 'saving'
                ? 'bg-blue-900/30 border-blue-700/50 text-blue-200'
                : persistStatus === 'saved'
                  ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-200'
                  : 'bg-red-900/30 border-red-700/50 text-red-200'
            }`}
          >
            {persistStatus === 'saving' ? 'Saving analysis...' : persistStatus === 'saved' ? 'Analysis saved' : 'Save failed'}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Map ── */}
        <div className="flex-1 relative">
          {mapError ? (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{mapError}</div>
          ) : (
            <div ref={mapRef} className="w-full h-full" />
          )}

          {/* Drawing instructions overlay */}
          {isDrawing && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-blue-600/90 backdrop-blur text-white text-sm px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
              <Pencil size={14} />
              Click to place points · Double-click to finish
              <button onClick={stopDrawing} className="ml-2 text-white/70 hover:text-white">
                <X size={14} />
              </button>
            </div>
          )}

          {/* Structural line legend (step 1c) */}
          {phase === 1 && step1Sub === 'structure' && structureResult && (
            <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur border border-slate-700 rounded-xl p-3">
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
        <div className="w-80 shrink-0 bg-slate-900 border-l border-slate-700 flex flex-col overflow-hidden">

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
                    className={`flex-1 py-2.5 capitalize transition-colors ${
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

              {/* Step 1a: Outline */}
              {step1Sub === 'outline' && (
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                  <div>
                    <h3 className="text-white font-semibold text-sm mb-1">Step 1 — Draw Roof Outline</h3>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      Trace the <strong className="text-slate-200">complete outer boundary</strong> of the roof. Include all sections — gables, overhangs, and additions.
                      AI will validate your outline and estimate coverage quality.
                    </p>
                  </div>

                  {!outline ? (
                    <button
                      onClick={() => startDrawing('#f97316')}
                      disabled={!mapLoaded || isDrawing}
                      className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                    >
                      <Pencil size={14} />
                      {isDrawing ? 'Drawing...' : 'Draw Roof Outline'}
                    </button>
                  ) : (
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
                        onClick={() => startDrawing('#f97316')}
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
                      Draw each <strong className="text-slate-200">distinct roof section</strong> one at a time — main slopes, dormers, flat sections, additions. AI will classify each as you go.
                    </p>
                  </div>

                  <button
                    onClick={() => startDrawing(SEGMENT_COLORS[segments.length % SEGMENT_COLORS.length])}
                    disabled={!mapLoaded || isDrawing}
                    className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors shrink-0"
                  >
                    <Pencil size={14} />
                    {isDrawing ? 'Drawing segment...' : `Draw Segment ${segments.length + 1}`}
                  </button>

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
                        {seg.analysis && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full capitalize">{seg.analysis.type}</span>
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full">{seg.analysis.facingDirection}</span>
                            <span className="bg-slate-700 text-slate-200 text-xs px-2 py-0.5 rounded-full">{seg.analysis.pitchEstimate}</span>
                            <span className="text-xs text-slate-400">{Math.round(seg.analysis.confidence * 100)}% conf</span>
                          </div>
                        )}
                        {seg.analysis?.notes && (
                          <div className="text-xs text-slate-400 mt-1 italic">{seg.analysis.notes}</div>
                        )}
                        {!seg.analyzing && !seg.analysis && !hasGeminiKey && (
                          <div className="text-xs text-slate-500">{seg.path.length} vertices</div>
                        )}
                      </div>
                    ))}
                    {segments.length === 0 && !autoSegmenting && (
                      <div className="text-center py-6 text-slate-500 text-xs">
                        No segments drawn yet.<br />Draw each distinct roof section<br />or use DSM Auto-Detect below.
                      </div>
                    )}
                    {autoSegmenting && (
                      <div className="flex flex-col items-center gap-2 py-6 text-cyan-400 text-xs">
                        <Loader2 size={20} className="animate-spin" />
                        <span>Analysing elevation map — detecting roof planes…</span>
                      </div>
                    )}
                  </div>

                  {/* DSM Auto-detect */}
                  {solarDataLayers?.dsmUrl && segments.length === 0 && !autoSegmenting && !aiSegmenting && (
                    <button
                      onClick={runAutoSegment}
                      className="flex items-center justify-center gap-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors"
                    >
                      <Zap size={13} /> Auto-detect roof planes from DSM
                    </button>
                  )}

                  {/* AI Visual Segment (Gemini vision) */}
                  {segments.length === 0 && !autoSegmenting && !aiSegmenting && imageReady && (
                    <button
                      onClick={runAiSegment}
                      className="flex items-center justify-center gap-2 bg-rose-700 hover:bg-rose-600 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors"
                    >
                      <Sparkles size={13} /> AI Visual Segment (Gemini Vision)
                    </button>
                  )}
                  {aiSegmenting && (
                    <div className="flex flex-col items-center gap-2 py-3 text-rose-300 text-xs">
                      <Loader2 size={18} className="animate-spin" />
                      <span>Gemini is analysing the satellite image…</span>
                    </div>
                  )}
                  {aiSegmentError && (
                    <div className="rounded-lg border border-rose-600/40 bg-rose-900/30 px-3 py-2 text-xs text-rose-200">
                      {aiSegmentError}
                    </div>
                  )}

                  {autoSegmentError && (
                    <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                      {autoSegmentError}
                    </div>
                  )}
                  {segments.length > 0 && !autoSegmenting && !aiSegmenting && (
                    <>
                      {autoSegmentRanRef.current && (
                        <div className="rounded-lg bg-cyan-900/20 border border-cyan-700/40 px-3 py-2 text-xs text-cyan-300">
                          {segments.length} roof plane{segments.length !== 1 ? 's' : ''} auto-detected via DSM · Adjust vertices if needed
                        </div>
                      )}
                      {aiSegmentRanRef.current && (
                        <div className="rounded-lg bg-rose-900/20 border border-rose-700/40 px-3 py-2 text-xs text-rose-300">
                          <Sparkles size={11} className="inline mr-1" />
                          {segments.length} roof plane{segments.length !== 1 ? 's' : ''} detected via AI Vision · Adjust vertices if needed
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
                        {hasGeminiKey ? 'Detect Roof Structure' : 'Build Structure (Fallback)'}
                      </button>
                    </div>
                  )}
                  {structureError && (
                    <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                      {structureError}
                    </div>
                  )}

                  {structureAnalyzing && (
                    <div className="flex items-center gap-2 text-purple-400 text-sm">
                      <Loader2 size={16} className="animate-spin" />
                      AI detecting structural lines…
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
                      <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-700 shrink-0">
                        {slot.previewUrl ? (
                          <img src={slot.previewUrl} alt={slot.label} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-500">
                            <Camera size={16} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-white">{slot.label}</span>
                          {slot.status === 'analyzing' && <Loader2 size={11} className="animate-spin text-blue-400" />}
                          {slot.status === 'done' && <CheckCircle2 size={11} className="text-green-400" />}
                          {slot.status === 'error' && <AlertCircle size={11} className="text-red-400" />}
                        </div>
                        <div className="text-xs text-slate-500 truncate">{slot.description}</div>
                        {slot.analysis && (
                          <div className="text-xs text-slate-400 mt-0.5">
                            Quality: <QualityBadge score={slot.analysis.qualityScore} /> · {slot.analysis.cues.length} cues
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
                <h3 className="text-white font-semibold text-sm mb-1">Final Combined Report</h3>
                <p className="text-slate-400 text-xs leading-relaxed">
                  Step 1 + Step 2 data are fused into one final AI decision. Analysis starts automatically in this step.
                </p>
                {finalSource && (
                  <p className={`mt-1 text-[11px] ${finalSource === 'ai' ? 'text-emerald-300' : 'text-amber-300'}`}>
                    Source: {finalSource === 'ai' ? 'AI fusion result' : 'Fallback fused result'}
                  </p>
                )}
                {finalError && (
                  <p className="mt-1 text-[11px] text-amber-300">{finalError}</p>
                )}
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
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Brain size={12} className={finalAnalyzing ? 'animate-pulse text-purple-300' : 'text-purple-300'} />
                  Step 3 · Fusion Pipeline
                </div>
                <div className="mt-2 space-y-2">
                  {[
                    `Ingest structural map (${segments.length} segments)`,
                    `Ingest photo cues (${totalCues} cues from ${photosAnalyzed} photo${photosAnalyzed !== 1 ? 's' : ''})`,
                    'Run deep AI synthesis and consistency checks',
                    'Generate final report + recommendations',
                  ].map((item, idx) => (
                    <div key={item} className="flex items-center gap-2 text-[11px] text-slate-300">
                      <span className={`inline-block w-2 h-2 rounded-full ${finalAnalyzing ? 'bg-blue-400 animate-pulse' : 'bg-emerald-400'}`} />
                      <span>{item}</span>
                      {finalAnalyzing && <span className="ml-auto text-slate-500">running…</span>}
                      {!finalAnalyzing && finalAnalysis && <CheckCircle2 size={11} className="ml-auto text-emerald-400" />}
                    </div>
                  ))}
                </div>
              </div>

              {finalAnalyzing && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Loader2 size={28} className="animate-spin text-purple-400" />
                  <div className="text-sm text-purple-300">AI synthesizing all data…</div>
                  <div className="text-xs text-slate-500">Combining structural map, photos, and satellite imagery</div>
                </div>
              )}

              {finalAnalysis && (
                <div className="flex flex-col gap-3">
                  {/* Condition badge */}
                  <div className={`rounded-xl p-4 border ${
                    finalAnalysis.condition === 'Excellent' || finalAnalysis.condition === 'Good'
                      ? 'bg-green-900/40 border-green-700/50'
                      : finalAnalysis.condition === 'Fair'
                      ? 'bg-amber-900/40 border-amber-700/50'
                      : 'bg-red-900/40 border-red-700/50'
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-400 font-medium">Roof Condition</span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        finalAnalysis.condition === 'Excellent' || finalAnalysis.condition === 'Good'
                          ? 'bg-green-500/20 text-green-300'
                          : finalAnalysis.condition === 'Fair'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}>{finalAnalysis.urgency} urgency</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold text-white">{finalAnalysis.condition}</span>
                      <span className="text-slate-400 text-sm">{finalAnalysis.condition_score}/100</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1">{finalAnalysis.estimated_remaining_life} remaining life</div>
                  </div>

                  {/* Issues */}
                  {finalAnalysis.issues.length > 0 && (
                    <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
                      <div className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
                        <AlertCircle size={12} className="text-amber-400" /> Issues Found
                      </div>
                      <ul className="flex flex-col gap-1">
                        {finalAnalysis.issues.map((issue, i) => (
                          <li key={i} className="text-xs text-slate-300 flex items-start gap-1.5">
                            <span className="text-amber-400 mt-0.5 shrink-0">•</span>
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Structural + Photo summaries */}
                  <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 space-y-2">
                    <div>
                      <div className="text-xs font-semibold text-purple-300 mb-1 flex items-center gap-1.5">
                        <Layers size={11} /> Structural
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{finalAnalysis.structuralSummary}</p>
                    </div>
                    <div className="border-t border-slate-700 pt-2">
                      <div className="text-xs font-semibold text-blue-300 mb-1 flex items-center gap-1.5">
                        <Camera size={11} /> Photo Analysis
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{finalAnalysis.photoSummary}</p>
                    </div>
                  </div>

                  {/* Recommendation */}
                  <div className="bg-blue-900/30 border border-blue-700/40 rounded-xl p-3">
                    <div className="text-xs font-semibold text-blue-300 mb-1.5">Recommendation</div>
                    <p className="text-xs text-slate-200 leading-relaxed">{finalAnalysis.recommendation}</p>
                  </div>

                  {/* Marketing message */}
                  <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-3">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Star size={11} className="text-amber-400" />
                      <span className="text-xs font-semibold text-amber-300">Client Message</span>
                    </div>
                    <p className="text-xs text-slate-300 italic leading-relaxed">"{finalAnalysis.marketing_message}"</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={downloadFinalReport}
                      className="text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-600 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
                    >
                      <Download size={12} /> Download
                    </button>
                    <button
                      onClick={() => void shareFinalReport()}
                      className="text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-600 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
                    >
                      <Share2 size={12} /> Share
                    </button>
                    <button
                      onClick={downloadQuoteDraft}
                      className="col-span-2 text-xs text-white bg-blue-600 hover:bg-blue-500 px-2.5 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
                    >
                      <FileSpreadsheet size={12} /> Generate Quote Draft
                    </button>
                  </div>
                  <button
                    onClick={runFinalAnalysis}
                    className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
                  >
                    <RotateCcw size={12} /> Re-run analysis
                  </button>
                </div>
              )}

              {!hasGeminiKey && (
                <div className="rounded-lg border border-amber-600/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
                  Gemini key is required to complete final AI fusion.
                </div>
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
                  onClick={downloadQuoteDraft}
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 rounded-md inline-flex items-center gap-1.5"
                >
                  <FileSpreadsheet size={12} /> Quote
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
