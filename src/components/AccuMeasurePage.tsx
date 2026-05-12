/**
 * AccuMeasure — Multi-source roof intelligence
 *
 * Flow:
 *   1. Address step  — user enters or confirms the property address
 *   2. Scan step     — three sources run in parallel with live progress
 *   3. Results step  — unified section table + one-click Generate Quote
 *
 * Data sources (run in parallel during scan):
 *   • Google Solar API  → actual sloped area (sq m), pitch, azimuth per segment
 *   • DSM Elevation     → DBSCAN-clustered planes from 0.1 m/pixel raster
 *   • Gemini + satellite → semantic labels & visual checks on those DSM planes (not separate geometry)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import {
  ArrowLeft, CheckCircle2, AlertCircle, Loader2,
  Layers, Zap, Shield, TrendingUp, ArrowRight, RefreshCw,
  Satellite, BarChart3, Eye, Search, MapPin,
} from 'lucide-react';
import type { Coordinates, RoofSection } from '../types';
import { PITCH_OPTIONS, SECTION_COLORS } from '../utils/roofCalculations';
import { fetchBuildingInsights, fetchDataLayers } from '../utils/solar';
import { autoSegmentRoofPlanes } from '../utils/roofDsm';
import { enrichDsmSegmentsWithSatelliteVision, type DsmVisionEnrichment } from '../utils/roofDsmVisionEnrich';
import type { SolarRoofSegment } from '../utils/solar';
import type { AutoDetectedSegment } from '../utils/roofDsm';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'address' | 'scanning' | 'done' | 'error';
type Confidence = 'high' | 'medium' | 'low';

interface ScanStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'warn' | 'error';
  detail?: string;
}

interface AccuMeasurePageProps {
  address: string;
  coordinates: Coordinates;
  apiKey: string;
  onBack: () => void;
  onAddressChange: (address: string, coords: Coordinates) => void;
  onComplete: (sections: Omit<RoofSection, 'polygon'>[]) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function azimuthToCompass(az: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(az / 45) % 8];
}

function pitchDegreesToString(deg: number): string {
  if (deg < 2) return 'flat';
  const ratio = Math.tan((deg * Math.PI) / 180);
  const rise = Math.round(ratio * 12);
  const clamped = Math.max(2, Math.min(12, rise));
  const nearest = PITCH_OPTIONS.reduce((best, opt) => {
    const optRise = parseInt(opt.value);
    return Math.abs(optRise - clamped) < Math.abs(parseInt(best.value) - clamped) ? opt : best;
  });
  return nearest.value;
}

function pitchStringToMultiplier(pitch: string): number {
  if (pitch === 'flat') return 1.0;
  const opt = PITCH_OPTIONS.find(p => p.value === pitch);
  return opt ? opt.multiplier : 1.118;
}

function latLngPolygonAreaSqFt(path: { lat: number; lng: number }[]): number {
  if (path.length < 3) return 0;
  const R = 6_371_000;
  let area = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = (path[i].lng * Math.PI / 180) * R * Math.cos(path[i].lat * Math.PI / 180);
    const yi = (path[i].lat * Math.PI / 180) * R;
    const xj = (path[j].lng * Math.PI / 180) * R * Math.cos(path[j].lat * Math.PI / 180);
    const yj = (path[j].lat * Math.PI / 180) * R;
    area += xi * yj - xj * yi;
  }
  return (Math.abs(area) / 2) * 10.764;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function solarSegmentToSection(seg: SolarRoofSegment, idx: number): Omit<RoofSection, 'polygon'> {
  const actualAreaSqFt = Math.round(seg.stats.areaMeters2 * 10.764);
  const pitch = pitchDegreesToString(seg.pitchDegrees);
  const pitchMultiplier = pitchStringToMultiplier(pitch);
  const flatArea = Math.round(actualAreaSqFt / pitchMultiplier);
  const facing = azimuthToCompass(seg.azimuthDegrees);
  return {
    id: `accu-solar-${idx}`,
    name: `${facing} Slope`,
    flatArea,
    pitch,
    pitchMultiplier,
    actualArea: actualAreaSqFt,
    color: SECTION_COLORS[idx % SECTION_COLORS.length],
  };
}

function dsmSegmentToSection(
  seg: AutoDetectedSegment,
  idx: number,
  enrich?: DsmVisionEnrichment | null,
): Omit<RoofSection, 'polygon'> {
  const flatAreaSqFt = Math.round(latLngPolygonAreaSqFt(seg.path));
  const pitch = seg.pitchRatio === 'flat' ? 'flat' : seg.pitchRatio;
  const pitchMultiplier = pitchStringToMultiplier(pitch);
  const name = enrich?.label?.trim()
    ? enrich.label.trim()
    : `${seg.facingDirection} Slope`;
  return {
    id: `accu-dsm-${idx}`,
    name,
    flatArea: flatAreaSqFt,
    pitch,
    pitchMultiplier,
    actualArea: Math.round(flatAreaSqFt * pitchMultiplier),
    color: SECTION_COLORS[idx % SECTION_COLORS.length],
    polygonPath: seg.path,
  };
}

const CONFIDENCE_CONFIG: Record<Confidence, {
  label: string; color: string; bg: string; icon: React.ReactNode; desc: string;
}> = {
  high: {
    label: 'High Confidence',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50 border-emerald-200',
    icon: <Shield size={16} />,
    desc: 'Multiple sources agree — reliable for quoting.',
  },
  medium: {
    label: 'Medium Confidence',
    color: 'text-amber-700',
    bg: 'bg-amber-50 border-amber-200',
    icon: <TrendingUp size={16} />,
    desc: 'Good estimate — verify complex sections on-site.',
  },
  low: {
    label: 'Low Confidence',
    color: 'text-orange-700',
    bg: 'bg-orange-50 border-orange-200',
    icon: <AlertCircle size={16} />,
    desc: 'Limited data — on-site verification recommended.',
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function AccuMeasurePage({
  address: initialAddress,
  coordinates: initialCoords,
  apiKey,
  onBack,
  onAddressChange,
  onComplete,
}: AccuMeasurePageProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    initialCoords?.lat ? 'address' : 'address'
  );

  // Address step state
  const [localAddress, setLocalAddress] = useState(initialAddress || '');
  const [localCoords, setLocalCoords] = useState<Coordinates | null>(
    initialCoords?.lat ? initialCoords : null
  );
  const [addrError, setAddrError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Scan state
  const INITIAL_STEPS: ScanStep[] = [
    { label: 'Fetching building data from Google Solar API', status: 'pending' },
    { label: 'Running DSM elevation analysis', status: 'pending' },
    { label: 'Capturing satellite imagery', status: 'pending' },
    { label: 'Labelling DSM planes with satellite (Gemini)', status: 'pending' },
    { label: 'Cross-validating all sources', status: 'pending' },
  ];
  const [steps, setSteps] = useState<ScanStep[]>(INITIAL_STEPS);
  const [sections, setSections] = useState<Omit<RoofSection, 'polygon'>[]>([]);
  const [confidence, setConfidence] = useState<Confidence>('medium');
  const [sources, setSources] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [imageryQuality, setImageryQuality] = useState('');

  // ── Step 1: Wire up Google Places Autocomplete ──────────────────────────────
  useEffect(() => {
    if (!apiKey) return;
    const loader = new Loader({ apiKey, version: 'weekly', libraries: ['places', 'drawing', 'geometry'] });
    loader.load().then(() => {
      if (!inputRef.current) return;
      const ac = new google.maps.places.Autocomplete(inputRef.current, {
        types: ['address'],
        fields: ['formatted_address', 'geometry'],
      });
      ac.addListener('place_changed', () => {
        const place = ac.getPlace();
        if (!place?.geometry?.location) {
          setAddrError('Could not find that address. Pick one from the suggestions.');
          return;
        }
        const coords: Coordinates = {
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng(),
        };
        const addr = place.formatted_address || inputRef.current?.value || '';
        setLocalAddress(addr);
        setLocalCoords(coords);
        setAddrError('');
      });
    }).catch(() => setAddrError('Address search failed to load.'));
  }, [apiKey]);

  // ── Step 2: Scan logic ──────────────────────────────────────────────────────
  const updateStep = useCallback((idx: number, patch: Partial<ScanStep>) => {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }, []);

  const runScan = useCallback(async (addr: string, coords: Coordinates) => {
    const { lat, lng } = coords;
    setPhase('scanning');
    setSteps(INITIAL_STEPS);
    setSections([]);
    setErrorMsg('');
    setImageryQuality('');

    try {
      // ── Solar building insights ─────────────────────────────────────────────
      updateStep(0, { status: 'running' });
      let solarSections: Omit<RoofSection, 'polygon'>[] = [];
      let buildingBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
      let quality = '';

      try {
        const insights = await fetchBuildingInsights(lat, lng, apiKey);
        if (insights) {
          quality = insights.imageryQuality;
          setImageryQuality(quality);
          buildingBounds = {
            minLat: insights.boundingBox.sw.latitude,
            maxLat: insights.boundingBox.ne.latitude,
            minLng: insights.boundingBox.sw.longitude,
            maxLng: insights.boundingBox.ne.longitude,
          };
          const validSegs = (insights.roofSegmentStats ?? []).filter(s => s.stats.areaMeters2 > 5);
          solarSections = validSegs.map((s, i) => solarSegmentToSection(s, i));
          updateStep(0, {
            status: 'done',
            detail: solarSections.length > 0
              ? `${solarSections.length} roof segments found · imagery quality: ${quality}`
              : `Building found but no segment data · quality: ${quality}`,
          });
        } else {
          updateStep(0, { status: 'warn', detail: 'No Solar data available for this address' });
        }
      } catch {
        updateStep(0, { status: 'warn', detail: 'Solar API unavailable — using fallback sources' });
      }

      // ── DSM elevation segmentation ──────────────────────────────────────────
      updateStep(1, { status: 'running' });
      let dsmSections: Omit<RoofSection, 'polygon'>[] = [];
      let dsmSegs: AutoDetectedSegment[] = [];

      if (buildingBounds) {
        try {
          const layers = await fetchDataLayers(lat, lng, 60, apiKey);
          if (layers?.dsmUrl) {
            dsmSegs = await autoSegmentRoofPlanes(
              layers.dsmUrl, buildingBounds, apiKey
            );
            dsmSections = dsmSegs.map((s, i) => dsmSegmentToSection(s, i));
            updateStep(1, {
              status: 'done',
              detail: `${dsmSegs.length} planes detected · 0.1 m/pixel elevation raster`,
            });
          } else {
            updateStep(1, { status: 'warn', detail: 'No DSM layer available for this location' });
          }
        } catch {
          updateStep(1, { status: 'warn', detail: 'DSM analysis failed — continuing with other sources' });
        }
      } else {
        updateStep(1, { status: 'warn', detail: 'Skipped — no building bounds from Solar API' });
      }

      // ── Satellite image capture ─────────────────────────────────────────────
      updateStep(2, { status: 'running' });
      let satBase64 = '';
      let satMime = 'image/png';

      try {
        const staticUrl =
          `https://maps.googleapis.com/maps/api/staticmap` +
          `?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;
        const res = await fetch(`/api/proxy-static-map?u=${encodeURIComponent(staticUrl)}`);
        if (res.ok) {
          const blob = await res.blob();
          satMime = blob.type || 'image/png';
          satBase64 = await blobToBase64(blob);
          updateStep(2, { status: 'done', detail: 'Satellite image captured at zoom 20 (640×640)' });
        } else {
          updateStep(2, { status: 'warn', detail: 'Could not fetch satellite image' });
        }
      } catch {
        updateStep(2, { status: 'warn', detail: 'Satellite capture failed' });
      }

      // ── Gemini: semantic labels on DSM planes (same satellite image) ─────────
      updateStep(3, { status: 'running' });
      let geminiDsmLabels = false;

      if (dsmSegs.length > 0 && satBase64) {
        try {
          const enriched = await enrichDsmSegmentsWithSatelliteVision(
            satBase64,
            satMime,
            lat,
            lng,
            20,
            640,
            dsmSegs.map((s, i) => ({
              index: i,
              path: s.path,
              dsmPitchDeg: s.pitchDeg,
              dsmPitchRatio: s.pitchRatio,
              dsmFacing: s.facingDirection,
            })),
          );
          const enrichByIdx = new Map<number, DsmVisionEnrichment>();
          enriched.forEach(e => enrichByIdx.set(e.index, e));
          dsmSections = dsmSegs.map((s, i) => dsmSegmentToSection(s, i, enrichByIdx.get(i) ?? null));
          geminiDsmLabels = enriched.length > 0;
          updateStep(3, {
            status: 'done',
            detail: geminiDsmLabels
              ? `Gemini labelled ${enriched.length} DSM plane(s) from satellite`
              : 'Vision returned no labels — using DSM geometry only',
          });
        } catch {
          dsmSections = dsmSegs.map((s, i) => dsmSegmentToSection(s, i));
          updateStep(3, { status: 'warn', detail: 'Gemini DSM labels skipped (key, quota, or API)' });
        }
      } else {
        if (dsmSegs.length > 0) {
          dsmSections = dsmSegs.map((s, i) => dsmSegmentToSection(s, i));
        }
        updateStep(3, {
          status: 'warn',
          detail:
            dsmSegs.length === 0
              ? 'No DSM planes to label'
              : !satBase64
                ? 'No satellite image — DSM planes without Gemini labels'
                : 'Skipped Gemini step',
        });
      }

      // ── Cross-validate & choose best source ────────────────────────────────
      updateStep(4, { status: 'running' });

      let finalSections: Omit<RoofSection, 'polygon'>[];
      let finalConfidence: Confidence;
      const usedSources: string[] = [];

      if (solarSections.length > 0) {
        finalSections = solarSections;
        usedSources.push('Google Solar');
        const agree =
          dsmSections.length === 0 || Math.abs(solarSections.length - dsmSections.length) <= 2;
        if (dsmSections.length > 0) usedSources.push('DSM Elevation');
        if (geminiDsmLabels) usedSources.push('Gemini DSM labels');
        finalConfidence =
          quality === 'HIGH' && agree && usedSources.length >= 2 ? 'high' : 'medium';
        updateStep(4, {
          status: 'done',
          detail: `Primary: Solar · verified by ${usedSources.slice(1).join(' + ') || 'imagery quality'}`,
        });
      } else if (dsmSections.length > 0) {
        finalSections = dsmSections;
        usedSources.push('DSM Elevation');
        if (geminiDsmLabels) usedSources.push('Gemini DSM labels');
        finalConfidence = 'medium';
        updateStep(4, { status: 'done', detail: 'Primary: DSM elevation data' });
      } else {
        updateStep(4, { status: 'error', detail: 'No measurement data found' });
        throw new Error(
          'No roof data found for this address. The address may be outside Google Solar coverage, ' +
          'or Solar API may not be enabled on your API key. Try enabling the Solar API in Google Cloud Console.'
        );
      }

      setSections(finalSections);
      setConfidence(finalConfidence);
      setSources(usedSources);
      setPhase('done');

    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [apiKey, updateStep]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleStartScan = () => {
    if (!localCoords) {
      setAddrError('Please select an address from the suggestions dropdown.');
      return;
    }
    if (!localAddress.trim()) {
      setAddrError('Please enter a property address.');
      return;
    }
    onAddressChange(localAddress, localCoords);
    runScan(localAddress, localCoords);
  };

  const handleRescan = () => {
    setPhase('address');
    setSections([]);
  };

  // ── Derived stats ────────────────────────────────────────────────────────────
  const totalActualSqFt = sections.reduce((s, r) => s + r.actualArea, 0);
  const totalSquares = Math.ceil(totalActualSqFt / 100);
  const totalWithWaste = Math.ceil(totalActualSqFt * 1.12 / 100);
  const predominantPitch = sections.length > 0
    ? sections.reduce((a, b) => a.actualArea > b.actualArea ? a : b).pitch
    : '—';
  const conf = CONFIDENCE_CONFIG[confidence];

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Layers size={14} className="text-white" />
          </div>
          <div>
            <h1 className="font-semibold text-slate-900 leading-none">AccuMeasure</h1>
            <p className="text-xs text-slate-500 mt-0.5">Multi-source roof intelligence</p>
          </div>
        </div>
        <span className="ml-auto text-xs bg-indigo-100 text-indigo-700 font-medium px-2 py-0.5 rounded-full">
          Solar + DSM + Gemini
        </span>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">

        {/* ── ADDRESS STEP ──────────────────────────────────────────────────── */}
        {phase === 'address' && (
          <>
            {/* What this tool does */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
                <Layers size={18} className="text-indigo-500" /> How AccuMeasure works
              </h2>
              <p className="text-sm text-slate-500 mb-4">
                Enter any property address. AccuMeasure pulls data from three independent sources
                simultaneously, cross-checks them, and gives you real roof measurements ready for quoting.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  {
                    icon: <Satellite size={18} className="text-blue-500" />,
                    title: 'Google Solar API',
                    desc: 'Actual sloped area in sq ft, pitch angle, and facing direction per roof section.',
                    badge: 'Most accurate',
                    badgeColor: 'bg-blue-100 text-blue-700',
                  },
                  {
                    icon: <BarChart3 size={18} className="text-emerald-500" />,
                    title: 'DSM Elevation',
                    desc: '0.1 m/pixel Digital Surface Model — DBSCAN clustering on real elevation data.',
                    badge: 'Cross-check',
                    badgeColor: 'bg-emerald-100 text-emerald-700',
                  },
                  {
                    icon: <Eye size={18} className="text-violet-500" />,
                    title: 'DSM + Gemini (satellite)',
                    desc: 'The same DSM roof planes get semantic labels and a visual cross-check from Gemini on the satellite frame — geometry stays elevation-based.',
                    badge: 'Labels',
                    badgeColor: 'bg-violet-100 text-violet-700',
                  },
                ].map(({ icon, title, desc, badge, badgeColor }) => (
                  <div key={title} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <div className="flex items-center gap-2 mb-1">
                      {icon}
                      <span className="font-medium text-sm text-slate-700">{title}</span>
                    </div>
                    <p className="text-xs text-slate-500 mb-2">{desc}</p>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>{badge}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Address input */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                <MapPin size={18} className="text-indigo-500" /> Enter property address
              </h2>

              {localAddress && localCoords && (
                <div className="mb-3 flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 text-sm text-indigo-800">
                  <MapPin size={14} className="shrink-0" />
                  <span className="flex-1 truncate font-medium">{localAddress}</span>
                  <button
                    onClick={() => { setLocalAddress(''); setLocalCoords(null); }}
                    className="text-xs text-indigo-500 hover:text-indigo-700 shrink-0"
                  >
                    Change
                  </button>
                </div>
              )}

              {(!localAddress || !localCoords) && (
                <div className="relative mb-3">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={inputRef}
                    type="text"
                    placeholder="123 Main St, City, State"
                    defaultValue={localAddress}
                    onChange={e => { setLocalAddress(e.target.value); setLocalCoords(null); }}
                    className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </div>
              )}

              {addrError && (
                <p className="text-xs text-red-600 mb-3 flex items-center gap-1">
                  <AlertCircle size={13} /> {addrError}
                </p>
              )}

              <button
                onClick={handleStartScan}
                disabled={!localAddress}
                className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-colors"
              >
                <Zap size={16} /> Start AccuMeasure Scan
              </button>

              <p className="text-xs text-slate-400 text-center mt-2">
                Takes 30–90 seconds · uses Google Solar, DSM, and Gemini AI
              </p>
            </div>
          </>
        )}

        {/* ── SCANNING STEP ─────────────────────────────────────────────────── */}
        {(phase === 'scanning' || phase === 'error') && (
          <>
            {/* Address bar */}
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-3 text-sm">
              <MapPin size={16} className="text-indigo-500 shrink-0" />
              <span className="text-slate-700 font-medium truncate">{localAddress}</span>
              {imageryQuality && (
                <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
                  imageryQuality === 'HIGH' ? 'bg-emerald-100 text-emerald-700' :
                  imageryQuality === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  {imageryQuality} imagery
                </span>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
                <BarChart3 size={15} className="text-indigo-500" /> Scanning Progress
              </h2>
              <div className="space-y-4">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      {step.status === 'pending'  && <div className="w-5 h-5 rounded-full border-2 border-slate-200" />}
                      {step.status === 'running'  && <Loader2 size={20} className="text-indigo-500 animate-spin" />}
                      {step.status === 'done'     && <CheckCircle2 size={20} className="text-emerald-500" />}
                      {step.status === 'warn'     && <AlertCircle  size={20} className="text-amber-500" />}
                      {step.status === 'error'    && <AlertCircle  size={20} className="text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${
                        step.status === 'pending' ? 'text-slate-400' :
                        step.status === 'running' ? 'text-indigo-700' :
                        step.status === 'done'    ? 'text-slate-700' :
                        step.status === 'warn'    ? 'text-amber-700' : 'text-red-700'
                      }`}>{step.label}</p>
                      {step.detail && <p className="text-xs text-slate-400 mt-0.5">{step.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {phase === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                <div className="flex items-start gap-3">
                  <AlertCircle size={20} className="text-red-500 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-red-800">Scan failed</p>
                    <p className="text-sm text-red-700 mt-1">{errorMsg}</p>
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button onClick={handleRescan} className="flex items-center gap-2 px-4 py-2 border border-slate-200 bg-white text-slate-700 rounded-lg text-sm font-medium">
                    <ArrowLeft size={14} /> Change Address
                  </button>
                  <button onClick={() => runScan(localAddress, localCoords!)} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium">
                    <RefreshCw size={14} /> Retry
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── RESULTS STEP ──────────────────────────────────────────────────── */}
        {phase === 'done' && sections.length > 0 && (
          <>
            {/* Address + quality bar */}
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-3 text-sm">
              <MapPin size={16} className="text-indigo-500 shrink-0" />
              <span className="text-slate-700 font-medium truncate">{localAddress}</span>
              {imageryQuality && (
                <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
                  imageryQuality === 'HIGH' ? 'bg-emerald-100 text-emerald-700' :
                  imageryQuality === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  {imageryQuality} imagery
                </span>
              )}
            </div>

            {/* Confidence + sources */}
            <div className={`rounded-2xl border p-4 flex items-start gap-3 ${conf.bg}`}>
              <span className={conf.color}>{conf.icon}</span>
              <div className="flex-1">
                <p className={`font-semibold text-sm ${conf.color}`}>{conf.label}</p>
                <p className="text-xs text-slate-600 mt-0.5">{conf.desc}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {sources.map(s => (
                    <span key={s} className="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <Eye size={10} /> {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total Roof Area', value: `${totalActualSqFt.toLocaleString()} ft²` },
                { label: 'Squares',         value: `${totalSquares} sq` },
                { label: '+12% Waste',       value: `${totalWithWaste} sq` },
                { label: 'Dominant Pitch',   value: predominantPitch },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white border border-slate-200 rounded-xl p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">{label}</p>
                  <p className="font-bold text-slate-800 text-lg leading-none">{value}</p>
                </div>
              ))}
            </div>

            {/* Section table */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Zap size={15} className="text-indigo-500" />
                <h3 className="text-sm font-semibold text-slate-700">Detected Roof Sections</h3>
                <span className="ml-auto text-xs text-slate-400">{sections.length} sections</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Section</th>
                      <th className="px-4 py-2 text-right">Flat Area</th>
                      <th className="px-4 py-2 text-right">Actual Area</th>
                      <th className="px-4 py-2 text-center">Pitch</th>
                      <th className="px-4 py-2 text-right">Squares</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sections.map((s, i) => (
                      <tr key={s.id} className={i % 2 === 0 ? '' : 'bg-slate-50/50'}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
                            <span className="font-medium text-slate-700">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{s.flatArea.toLocaleString()} ft²</td>
                        <td className="px-4 py-2.5 text-right font-medium text-slate-800">{s.actualArea.toLocaleString()} ft²</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium">{s.pitch}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{(s.actualArea / 100).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 bg-slate-50">
                      <td className="px-4 py-2.5 font-semibold text-slate-700">Total</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                        {sections.reduce((s, r) => s + r.flatArea, 0).toLocaleString()} ft²
                      </td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                        {totalActualSqFt.toLocaleString()} ft²
                      </td>
                      <td />
                      <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{totalSquares} sq</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 justify-end pb-4">
              <button
                onClick={handleRescan}
                className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium"
              >
                <RefreshCw size={15} /> New Address
              </button>
              <button
                onClick={() => onComplete(sections)}
                className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold"
              >
                Generate Quote <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
