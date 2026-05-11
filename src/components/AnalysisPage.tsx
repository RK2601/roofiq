import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import { Coordinates, RoofSection } from '../types';
import {
  PITCH_OPTIONS,
  SECTION_COLORS,
  formatArea,
  computeActualArea,
} from '../utils/roofCalculations';
import {
  Pencil,
  Trash2,
  ChevronDown,
  AlertCircle,
  Layers,
  Ruler,
  ArrowRight,
  Satellite,
  RotateCcw,
  Info,
  Maximize2,
  Eye,
  EyeOff,
  Save,
  CheckCircle2,
  Brain,
  Loader2,
  ChevronUp,
  Search,
  MapPin,
  Sun,
  Map,
  Navigation,
  Camera,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import { saveProject, isDbConfigured } from '../utils/db';
import {
  analyzeRoofImage,
  analyzeRoofImageFromFile,
  analyzeRoofGeometryFromCapture,
  type RoofAnalysis,
  type RoofGeometryDetail,
  CONDITION_BG,
  URGENCY_BG,
  CONDITION_COLORS,
} from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';
import {
  fetchBuildingInsights,
  fetchDataLayers,
  filterUsableRoofSegments,
  validateSolarBuildingInsights,
  type FetchBuildingInsightsOptions,
  type SolarBuildingInsights,
  type SolarDataLayersResponse,
} from '../utils/solar';
import { computeRoofMeasurements, formatFt } from '../utils/measurements';
import {
  analyzeDrawnRoofSections,
  type DrawnRoofSectionInput,
  type RoofStructureAnalysis,
} from '../utils/roofStructure';
import { buildHeightModel, type HeightModel } from '../utils/heightModel';
import {
  computeStaticMapImageBoundsFromCenterZoom,
  deriveHeuristicRoofCues,
  deriveVisionRoofCuesFromStaticMap,
  DRAWN_OVERLAY_VISION_HINT,
  type RoofCaptureRing,
} from '../utils/roofVision';
import RoofStructurePanel from './RoofStructurePanel';
import RoofMappingWizard from './RoofMappingWizard';
import SaveProjectChoiceModal from './SaveProjectChoiceModal';
import { ErrorBoundary } from './ErrorBoundary';

function buildDrawnRoofSectionInputs(sections: RoofSection[]): DrawnRoofSectionInput[] {
  const out: DrawnRoofSectionInput[] = [];
  for (const s of sections) {
    const pts: { lat: number; lng: number }[] = [];
    if (s.polygon) {
      s.polygon.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
    } else if (s.polygonPath?.length) {
      pts.push(...s.polygonPath);
    }
    if (pts.length < 3) continue;
    out.push({
      id: s.id,
      path: pts,
      flatAreaSqFt: s.flatArea,
      actualAreaSqFt: s.actualArea,
      pitch: s.pitch,
    });
  }
  return out;
}

/** Static Maps URL with optional roof-section path overlays (same as save snapshots). */
function buildSectionStaticMapUrl(
  coordinates: Coordinates,
  apiKey: string,
  sects: RoofSection[],
  zoom: number,
  size: string
): string {
  const params = new URLSearchParams({
    center: `${coordinates.lat},${coordinates.lng}`,
    zoom: String(zoom),
    size,
    maptype: 'satellite',
    scale: '2',
    key: apiKey,
  });
  const paths = sects
    .filter(s => s.polygon)
    .map(s => {
      const pts: string[] = [];
      s.polygon!.getPath().forEach(p => pts.push(`${p.lat()},${p.lng()}`));
      if (pts.length) pts.push(pts[0]);
      const fill = `0x${s.color.replace('#', '')}40`;
      const stroke = `0x${s.color.replace('#', '')}FF`;
      return `fillcolor:${fill}|color:${stroke}|weight:2|${pts.join('|')}`;
    });
  const base = `https://maps.googleapis.com/maps/api/staticmap?${params}`;
  return base + paths.map(p => `&path=${encodeURIComponent(p)}`).join('');
}

interface AnalysisPageProps {
  apiKey: string;
  address: string;
  coordinates: Coordinates;
  projectId?: string | null;
  /** Increments when the user should land with the Smart Roof Mapping wizard open (e.g. from New analysis hub). */
  wizardAutoOpenSignal?: number;
  /** User chose “Quick analysis” on the New analysis hub — omit polygon hint and wizard CTA in the sidebar. */
  fromQuickAnalysisChoice?: boolean;
  /** User chose Smart Roof Mapping Wizard on the New analysis hub — hide draw/quote onboarding until a property is selected. */
  fromWizardAnalysis2Choice?: boolean;
  /** Called when the user picks a new address from the in-tab search (updates map + clears work in progress). */
  onPropertySelect: (address: string, coordinates: Coordinates) => void;
  onComplete: (sections: Omit<RoofSection, 'polygon'>[], projectId: string | null) => void;
  /** After Smart Roof Mapping wizard finishes; parent typically navigates to the dashboard report. */
  onWizardReportReady?: (ctx: { projectId: string; address: string }) => void;
}

export default function AnalysisPage({
  apiKey,
  address,
  coordinates,
  projectId: linkedProjectId = null,
  wizardAutoOpenSignal = 0,
  fromQuickAnalysisChoice = false,
  fromWizardAnalysis2Choice = false,
  onPropertySelect,
  onComplete,
  onWizardReportReady,
}: AnalysisPageProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
  /** Click-to-draw draft path (map LatLng instances) while user traces a new section. */
  const draftPathRef = useRef<google.maps.LatLng[]>([]);
  const draftPolylineRef = useRef<google.maps.Polyline | null>(null);
  /** Green dot at first click; blue dot follows cursor while drawing. */
  const draftStartMarkerRef = useRef<google.maps.Marker | null>(null);
  const draftCursorMarkerRef = useRef<google.maps.Marker | null>(null);
  const sectionsRef = useRef<RoofSection[]>([]);

  const [sections, setSections] = useState<RoofSection[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState('');
  const [tilt, setTilt] = useState(false);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [aiStatus, setAiStatus] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
  const [aiResult, setAiResult] = useState<RoofAnalysis | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [geometryDetail, setGeometryDetail] = useState<RoofGeometryDetail | null>(null);
  const hasGeminiKey = !!readGeminiApiKey();
  const labelsRef = useRef<google.maps.InfoWindow[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const solarFetchOptions: FetchBuildingInsightsOptions = useMemo(() => {
    const raw = import.meta.env.VITE_SOLAR_REQUIRED_QUALITY;
    if (raw === 'MEDIUM' || raw === 'HIGH' || raw === 'LOW') return { requiredQuality: raw };
    return {};
  }, []);

  const experimentalSolarOutlineEnabled = import.meta.env.VITE_EXPERIMENTAL_SOLAR_OUTLINE === 'true';

  const [solarStatus, setSolarStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [solarData, setSolarData] = useState<SolarBuildingInsights | null>(null);
  const [solarDataLayers, setSolarDataLayers] = useState<SolarDataLayersResponse | null>(null);
  const [heightModel, setHeightModel] = useState<HeightModel | null>(null);
  const [roofAiCues, setRoofAiCues] = useState<ReturnType<typeof deriveHeuristicRoofCues> | null>(null);
  const [roofAiCueStatus, setRoofAiCueStatus] = useState<'idle' | 'loading' | 'ready' | 'fallback'>('idle');
  const [solarError, setSolarError] = useState<string | null>(null);
  const [roofStructure, setRoofStructure] = useState<RoofStructureAnalysis | null>(null);
  const [showRoofStructure, setShowRoofStructure] = useState(false);
  const filteredSolar = useMemo(
    () => filterUsableRoofSegments(solarData?.roofSegmentStats ?? []),
    [solarData?.roofSegmentStats]
  );
  const usableSolarSegments = filteredSolar.segments;
  const [showWizard, setShowWizard] = useState(false);
  /** After wizard folder choice with no address yet (e.g. from New analysis hub) — open wizard once the user picks a property from search. */
  const [openWizardAfterPropertySearch, setOpenWizardAfterPropertySearch] = useState(false);
  const lastWizardAutoOpenSignal = useRef(0);
  /** Saved with the project as `project_name`; list title becomes name + address. */
  const [projectFolderName, setProjectFolderName] = useState('');
  /** When not inherit: user chose new vs existing folder before opening the wizard (no linked project yet). */
  type WizardAttachState =
    | { mode: 'inherit' }
    | { mode: 'new' }
    | { mode: 'existing'; id: string };
  const [wizardAttach, setWizardAttach] = useState<WizardAttachState>({ mode: 'inherit' });
  const [saveChoicePurpose, setSaveChoicePurpose] = useState<'quick' | 'wizard' | null>(null);

  const wizardExistingProjectId =
    wizardAttach.mode === 'existing'
      ? wizardAttach.id
      : wizardAttach.mode === 'new'
        ? null
        : linkedProjectId;

  /** New analysis hub → wizard (or post–folder-choice before address): hide quick-map draw / empty-state chrome. */
  const hideWizardEntryRoofChrome = useMemo(
    () =>
      openWizardAfterPropertySearch || (fromWizardAnalysis2Choice && !address.trim()),
    [openWizardAfterPropertySearch, fromWizardAnalysis2Choice, address]
  );

  const roofStructurePreview = useMemo(() => {
    if (solarStatus !== 'ready' || !solarData) return null;
    const drawnInputs = buildDrawnRoofSectionInputs(sections);
    if (drawnInputs.length === 0) return null;

    const segments = usableSolarSegments;
    const model = heightModel ?? buildHeightModel(segments, solarDataLayers);
    const aiCues =
      roofAiCues ??
      (segments.length > 0 ? deriveHeuristicRoofCues(segments, solarData.center) : null);
    const ctx = {
      imageryQuality: solarData.imageryQuality,
      hasDsm: !!solarDataLayers?.dsmUrl,
      heightModel: model,
      aiCues: aiCues ?? undefined,
    };

    return analyzeDrawnRoofSections(drawnInputs, solarData.center, segments, ctx);
  }, [
    solarData,
    solarStatus,
    solarDataLayers,
    heightModel,
    roofAiCues,
    usableSolarSegments,
    sections,
  ]);

  /** Rings for roof-targeted static captures in Roof structure panel (drawn polygons on the map). */
  const roofCaptureRings = useMemo((): RoofCaptureRing[] | null => {
    const rings: RoofCaptureRing[] = [];
    for (const s of sections) {
      const pts: { lat: number; lng: number }[] = [];
      if (s.polygon) {
        s.polygon.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
      } else if (s.polygonPath?.length) {
        pts.push(...s.polygonPath);
      }
      if (pts.length >= 3) rings.push({ points: pts, color: s.color });
    }
    return rings.length ? rings : null;
  }, [sections]);

  const executeQuickSave = useCallback(
    async (target: 'use-linked' | 'new' | string) => {
      const existingProjectId =
        target === 'use-linked' ? linkedProjectId : target === 'new' ? null : target;

      const exportSections = sections.map(({ polygon, ...rest }) => ({
        ...rest,
        polygonPath: (() => {
          const pts: { lat: number; lng: number }[] = [];
          polygon?.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
          return pts;
        })(),
      }));
      setSaving(true);
      let savedProjectId: string | null = null;
      try {
        const snapshots = [
          { label: 'Standard View', url: buildSnapshotUrl(sections, 19) },
          { label: 'Close-up', url: buildSnapshotUrl(sections, 21) },
          { label: 'Overview', url: buildSnapshotUrl(sections, 17) },
        ];
        const sectionsToSave = sections.map(s => ({
          id: s.id,
          name: s.name,
          flatArea: s.flatArea,
          pitch: s.pitch,
          pitchMultiplier: s.pitchMultiplier,
          actualArea: s.actualArea,
          color: s.color,
          polygonPath: (() => {
            const pts: { lat: number; lng: number }[] = [];
            s.polygon?.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
            return pts;
          })(),
        }));
        savedProjectId = await saveProject(
          address,
          coordinates,
          snapshots,
          sectionsToSave,
          roofStructure ?? roofStructurePreview,
          {
            projectName: projectFolderName.trim() || null,
            analysisEntry: 'quick',
            existingProjectId: existingProjectId ?? undefined,
          }
        );
        setSaveStatus('saved');
      } catch (err) {
        console.error('Failed to save project:', err);
        setSaveStatus('error');
      } finally {
        setSaving(false);
      }
      onComplete(exportSections, savedProjectId);
    },
    [
      sections,
      address,
      coordinates,
      projectFolderName,
      roofStructure,
      roofStructurePreview,
      linkedProjectId,
      onComplete,
    ]
  );

  const requestOpenWizard = useCallback(() => {
    if (linkedProjectId) {
      setShowWizard(true);
      return;
    }
    if (wizardAttach.mode !== 'inherit') {
      if (address.trim()) {
        setShowWizard(true);
      } else {
        setOpenWizardAfterPropertySearch(true);
        queueMicrotask(() => searchInputRef.current?.focus());
      }
      return;
    }
    if (!isDbConfigured()) {
      setShowWizard(true);
      return;
    }
    setSaveChoicePurpose('wizard');
  }, [linkedProjectId, wizardAttach.mode, address]);

  useEffect(() => {
    if (wizardAutoOpenSignal > lastWizardAutoOpenSignal.current) {
      lastWizardAutoOpenSignal.current = wizardAutoOpenSignal;
      requestOpenWizard();
    }
  }, [wizardAutoOpenSignal, requestOpenWizard]);

  useEffect(() => {
    if (!openWizardAfterPropertySearch || !address.trim()) return;
    setOpenWizardAfterPropertySearch(false);
    setShowWizard(true);
  }, [address, openWizardAfterPropertySearch]);

  // Map view controls
  const [mapType, setMapType] = useState<'satellite' | 'hybrid'>('satellite');
  const [showStreetView, setShowStreetView] = useState(false);
  const [streetViewAvailable, setStreetViewAvailable] = useState(false);
  const streetViewRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);

  // Photo upload for AI analysis
  const [uploadedPhoto, setUploadedPhoto] = useState<{ file: File; previewUrl: string } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Keep ref in sync
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  const updateLabel = useCallback((section: RoofSection) => {
    if (!mapInstanceRef.current) return;
    // Remove old label
    const idx = sectionsRef.current.findIndex(s => s.id === section.id);
    if (labelsRef.current[idx]) {
      labelsRef.current[idx].close();
    }
    if (!showLabels || !section.polygon) return;

    const bounds = new google.maps.LatLngBounds();
    section.polygon.getPath().forEach(p => bounds.extend(p));
    const center = bounds.getCenter();

    const iw = new google.maps.InfoWindow({
      position: center,
      content: `<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;color:#0f172a;white-space:nowrap;padding:2px 6px;background:${section.color};border-radius:6px;color:white;">${section.name}<br/>${formatArea(section.flatArea)}</div>`,
      disableAutoPan: true,
    });
    iw.open(mapInstanceRef.current);
    labelsRef.current[idx] = iw;
  }, [showLabels]);

  const addSection = useCallback((polygon: google.maps.Polygon, flatArea: number) => {
    const id = Date.now().toString();
    const idx = sectionsRef.current.length;
    const color = SECTION_COLORS[idx % SECTION_COLORS.length];
    const defaultPitch = PITCH_OPTIONS[2]; // 4/12

    polygon.setOptions({
      fillColor: color,
      strokeColor: color,
      fillOpacity: 0.3,
      strokeWeight: 2.5,
    });

    const newSection: RoofSection = {
      id,
      name: `Section ${idx + 1}`,
      polygon,
      flatArea,
      pitch: defaultPitch.value,
      pitchMultiplier: defaultPitch.multiplier,
      actualArea: computeActualArea(flatArea, defaultPitch.multiplier),
      color,
    };

    // Path change listener to recompute area
    google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
      const newArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
      setSections(prev =>
        prev.map(s =>
          s.id === id
            ? { ...s, flatArea: newArea, actualArea: computeActualArea(newArea, s.pitchMultiplier) }
            : s
        )
      );
    });
    google.maps.event.addListener(polygon.getPath(), 'insert_at', () => {
      const newArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
      setSections(prev =>
        prev.map(s =>
          s.id === id
            ? { ...s, flatArea: newArea, actualArea: computeActualArea(newArea, s.pitchMultiplier) }
            : s
        )
      );
    });

    // Click to select
    polygon.addListener('click', () => setSelectedSection(id));

    setSections(prev => [...prev, newSection]);
    setIsDrawing(false);
    setTimeout(() => updateLabel(newSection), 50);
  }, [updateLabel]);

  /** Single Solar `boundingBox` footprint — only when `VITE_EXPERIMENTAL_SOLAR_OUTLINE=true`. User edits one polygon. */
  const applyExperimentalSolarOutline = useCallback(() => {
    if (!solarData || !mapInstanceRef.current || !experimentalSolarOutlineEnabled) return;
    const map = mapInstanceRef.current;
    sectionsRef.current.forEach(s => {
      if (s.polygon) {
        google.maps.event.clearInstanceListeners(s.polygon);
        s.polygon.setMap(null);
      }
    });
    labelsRef.current.forEach(l => l.close());
    labelsRef.current = [];
    sectionsRef.current = [];

    const { sw, ne } = solarData.boundingBox;
    const pathCoords = [
      { lat: sw.latitude, lng: sw.longitude },
      { lat: ne.latitude, lng: sw.longitude },
      { lat: ne.latitude, lng: ne.longitude },
      { lat: sw.latitude, lng: ne.longitude },
    ];
    const polygon = new google.maps.Polygon({
      paths: pathCoords,
      map,
      editable: true,
      draggable: false,
      fillOpacity: 0.28,
      strokeWeight: 2.5,
      fillColor: SECTION_COLORS[0],
      strokeColor: SECTION_COLORS[0],
      zIndex: 1,
    });

    const id = `solar-bbox-${Date.now()}`;
    const flatArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
    const defaultPitch = PITCH_OPTIONS[2];
    const newSection: RoofSection = {
      id,
      name: 'Building outline (experimental)',
      polygon,
      flatArea,
      pitch: defaultPitch.value,
      pitchMultiplier: defaultPitch.multiplier,
      actualArea: computeActualArea(flatArea, defaultPitch.multiplier),
      color: SECTION_COLORS[0],
    };

    google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
      const newArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
      setSections(prev =>
        prev.map(s =>
          s.id === id
            ? { ...s, flatArea: newArea, actualArea: computeActualArea(newArea, s.pitchMultiplier) }
            : s
        )
      );
    });
    google.maps.event.addListener(polygon.getPath(), 'insert_at', () => {
      const newArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
      setSections(prev =>
        prev.map(s =>
          s.id === id
            ? { ...s, flatArea: newArea, actualArea: computeActualArea(newArea, s.pitchMultiplier) }
            : s
        )
      );
    });
    polygon.addListener('click', () => setSelectedSection(id));

    sectionsRef.current = [newSection];
    setSections([newSection]);
    setSelectedSection(id);
    setTimeout(() => updateLabel(newSection), 50);
  }, [solarData, experimentalSolarOutlineEnabled, updateLabel]);

  useEffect(() => {
    if (!apiKey || !mapRef.current) return;

    let cancelled = false;

    const loader = new Loader({
      apiKey,
      version: 'weekly',
      libraries: ['places', 'drawing', 'geometry'],
    });

    loader.load().then(() => {
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
        zoomControlOptions: {
          position: google.maps.ControlPosition.RIGHT_CENTER,
        },
        gestureHandling: 'greedy',
      });

      mapInstanceRef.current = map;

      // Marker at address
      new google.maps.Marker({
        position: coordinates,
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#f97316',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
        title: address,
      });

      const drawingManager = new google.maps.drawing.DrawingManager({
        drawingMode: null,
        drawingControl: false,
        polygonOptions: {
          fillColor: '#3b82f6',
          fillOpacity: 0.3,
          strokeColor: '#2563eb',
          strokeWeight: 2.5,
          editable: true,
          draggable: false,
          zIndex: 1,
        },
      });

      drawingManager.setMap(map);
      drawingManagerRef.current = drawingManager;

      setMapLoaded(true);
      } catch (err) {
        if (!cancelled) setMapError('Failed to initialize map. Please verify your API key and enabled APIs.');
      }
    }).catch(() => {
      if (!cancelled) setMapError('Failed to load Google Maps. Please verify your API key.');
    });

    return () => {
      cancelled = true;
      labelsRef.current.forEach(l => l.close());
      labelsRef.current = [];
      sectionsRef.current.forEach(s => {
        if (s.polygon) {
          if (typeof google !== 'undefined' && google.maps?.event) {
            google.maps.event.clearInstanceListeners(s.polygon);
          }
          s.polygon.setMap(null);
        }
      });
      setSections([]);
      if (drawingManagerRef.current) {
        if (typeof google !== 'undefined' && google.maps?.event) {
          google.maps.event.clearInstanceListeners(drawingManagerRef.current);
        }
        drawingManagerRef.current.setMap(null);
        drawingManagerRef.current = null;
      }
      mapInstanceRef.current = null;
      if (mapRef.current) mapRef.current.innerHTML = '';
      setMapLoaded(false);
      setIsDrawing(false);
      setSelectedSection(null);
      setAiResult(null);
      setAiStatus('idle');
      setAiError(null);
      setGeometryDetail(null);
      setSaveStatus('idle');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, coordinates.lat, coordinates.lng]);

  // Auto-fetch Solar building insights whenever coordinates change
  useEffect(() => {
    if (!apiKey) return;
    setSolarStatus('loading');
    setSolarData(null);
    setSolarDataLayers(null);
    setHeightModel(null);
    setRoofAiCues(null);
    setRoofAiCueStatus('idle');
    setSolarError(null);
    setRoofStructure(null);
    setShowRoofStructure(false);
    setGeometryDetail(null);

    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBuildingInsights(
          coordinates.lat,
          coordinates.lng,
          apiKey,
          solarFetchOptions
        );
        if (cancelled) return;
        if (!data) {
          setSolarError('Empty Solar response');
          setSolarStatus('error');
          return;
        }
        const validation = validateSolarBuildingInsights(data, coordinates.lat, coordinates.lng);
        if (!validation.ok) {
          setSolarError(validation.rejectReason ?? 'Solar validation failed');
          setSolarStatus('error');
          return;
        }
        setSolarData(data);

        const segments = filterUsableRoofSegments(data?.roofSegmentStats ?? []).segments;
        const layers = await fetchDataLayers(
          coordinates.lat,
          coordinates.lng,
          120,
          apiKey,
          solarFetchOptions
        ).catch(() => null);
        if (cancelled) return;
        setSolarDataLayers(layers);
        setHeightModel(buildHeightModel(segments, layers));
        setSolarStatus('ready');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setSolarError(msg.includes('404') ? 'No Solar data for this address' : msg.slice(0, 100));
        setSolarStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [coordinates.lat, coordinates.lng, apiKey, solarFetchOptions]);

  useEffect(() => {
    if (!solarData || solarStatus !== 'ready') return;
    const segments = usableSolarSegments;
    const drawnInputs = buildDrawnRoofSectionInputs(sections);
    if (drawnInputs.length === 0) {
      setRoofAiCues(null);
      setRoofAiCueStatus('idle');
      return;
    }

    let cancelled = false;
    setRoofAiCueStatus('loading');
    (async () => {
      const staticMapUrl = buildSectionStaticMapUrl(coordinates, apiKey, sections, 21, '640x640');
      const staticImageBounds = computeStaticMapImageBoundsFromCenterZoom(coordinates, 21, 640);

      const visionCues = await deriveVisionRoofCuesFromStaticMap(
        staticMapUrl,
        solarData,
        DRAWN_OVERLAY_VISION_HINT,
        staticImageBounds,
        roofCaptureRings
      ).catch(() => null);
      if (cancelled) return;
      if (visionCues && visionCues.length > 0) {
        setRoofAiCues(visionCues);
        setRoofAiCueStatus('ready');
        return;
      }
      if (segments.length > 0) {
        const fallback = deriveHeuristicRoofCues(segments, solarData.center);
        setRoofAiCues(fallback);
        setRoofAiCueStatus('fallback');
      } else {
        setRoofAiCues(null);
        setRoofAiCueStatus('idle');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [solarData, solarStatus, coordinates, apiKey, usableSolarSegments, sections]);

  useEffect(() => {
    if (sections.length === 0) {
      setRoofStructure(null);
      setShowRoofStructure(false);
    }
  }, [sections.length]);

  // Sync map type (satellite ↔ hybrid)
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setMapTypeId(mapType);
  }, [mapType]);

  // Init Street View panorama once map is loaded
  useEffect(() => {
    if (!mapLoaded || !streetViewRef.current) return;
    if (panoramaRef.current) return; // already initialized

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
    mapInstanceRef.current?.setStreetView(pano);

    // Check if street view is available at this location
    const svc = new google.maps.StreetViewService();
    svc.getPanorama({ location: coordinates, radius: 100 }, (_data, status) => {
      setStreetViewAvailable(status === google.maps.StreetViewStatus.OK);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  // Show / hide Street View pane and update panorama position on coord change
  useEffect(() => {
    if (!panoramaRef.current) return;
    panoramaRef.current.setVisible(showStreetView);
    if (showStreetView) {
      panoramaRef.current.setPosition(coordinates);
    }
  }, [showStreetView, coordinates]);

  useEffect(() => {
    if (!mapLoaded || !searchInputRef.current) return;
    if (!google.maps?.places) return;

    const input = searchInputRef.current;
    const ac = new google.maps.places.Autocomplete(input, {
      types: ['address'],
      fields: ['formatted_address', 'geometry'],
    });
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (!place.geometry?.location) return;
      const loc = place.geometry.location;
      onPropertySelect(place.formatted_address || input.value.trim(), {
        lat: loc.lat(),
        lng: loc.lng(),
      });
      input.value = '';
    });

    return () => {
      google.maps.event.removeListener(listener);
    };
  }, [mapLoaded, onPropertySelect]);

  // Toggle tilt
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setTilt(tilt ? 45 : 0);
  }, [tilt]);

  // Re-render labels when showLabels changes
  useEffect(() => {
    labelsRef.current.forEach(l => l.close());
    labelsRef.current = [];
    if (showLabels && mapInstanceRef.current) {
      sections.forEach(s => {
        if (!s.polygon) return;
        const bounds = new google.maps.LatLngBounds();
        s.polygon.getPath().forEach(p => bounds.extend(p));
        const center = bounds.getCenter();
        const iw = new google.maps.InfoWindow({
          position: center,
          content: `<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;padding:2px 6px;background:${s.color};border-radius:6px;color:white;">${s.name}<br/>${formatArea(s.flatArea)}</div>`,
          disableAutoPan: true,
        });
        iw.open(mapInstanceRef.current!);
        labelsRef.current.push(iw);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLabels, sections.length]);

  const startDrawing = () => {
    if (!mapInstanceRef.current || !mapLoaded) return;
    draftPathRef.current = [];
    draftPolylineRef.current?.setMap(null);
    draftPolylineRef.current = null;
    draftStartMarkerRef.current?.setMap(null);
    draftStartMarkerRef.current = null;
    draftCursorMarkerRef.current?.setMap(null);
    draftCursorMarkerRef.current = null;
    setIsDrawing(true);
    setSelectedSection(null);
  };

  const cancelDrawing = () => {
    draftPathRef.current = [];
    draftPolylineRef.current?.setMap(null);
    draftPolylineRef.current = null;
    draftStartMarkerRef.current?.setMap(null);
    draftStartMarkerRef.current = null;
    draftCursorMarkerRef.current?.setMap(null);
    draftCursorMarkerRef.current = null;
    mapInstanceRef.current?.setOptions({ disableDoubleClickZoom: false });
    setIsDrawing(false);
  };

  /** Click-to-draw: plain corner placement — double-click finishes (≥3 points). No angle / shape heuristics. */
  useEffect(() => {
    if (!isDrawing || !mapLoaded || !mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    /** Ignore only true duplicate taps on the same corner (screen jitter). */
    const MIN_VERTEX_SEP_M = 0.35;

    map.setOptions({ disableDoubleClickZoom: true });

    const draftLine = new google.maps.Polyline({
      map,
      path: [],
      strokeColor: '#2563eb',
      strokeOpacity: 0.95,
      strokeWeight: 2.5,
      clickable: false,
      zIndex: 3,
    });
    draftPolylineRef.current = draftLine;
    draftPathRef.current = [];

    const vertexIcon = (fill: string, scale: number): google.maps.Symbol => ({
      path: google.maps.SymbolPath.CIRCLE,
      scale,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 2,
      anchor: new google.maps.Point(0, 0),
    });

    const startMarker = new google.maps.Marker({
      map,
      visible: false,
      zIndex: 5,
      clickable: false,
      optimized: true,
      icon: vertexIcon('#22c55e', 9),
    });
    const cursorMarker = new google.maps.Marker({
      map,
      visible: false,
      zIndex: 6,
      clickable: false,
      optimized: true,
      icon: vertexIcon('#3b82f6', 8),
    });
    draftStartMarkerRef.current = startMarker;
    draftCursorMarkerRef.current = cursorMarker;
    /** One marker per corner after the first (start marker covers the first). */
    const cornerMarkers: google.maps.Marker[] = [];

    let detached = false;
    let clickL: google.maps.MapsEventListener | undefined;
    let dblL: google.maps.MapsEventListener | undefined;
    let moveL: google.maps.MapsEventListener | undefined;
    let outL: google.maps.MapsEventListener | undefined;

    const undoLastDraftPoint = () => {
      const path = draftPathRef.current;
      if (path.length === 0) return;
      path.pop();
      draftLine.setPath(path);
      while (cornerMarkers.length > Math.max(0, path.length - 1)) {
        const m = cornerMarkers.pop();
        m?.setMap(null);
      }
      if (path.length === 0) {
        startMarker.setVisible(false);
      } else if (path.length === 1) {
        startMarker.setPosition(path[0]);
        startMarker.setVisible(true);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (draftPathRef.current.length === 0) return;
      e.preventDefault();
      undoLastDraftPoint();
    };

    const detachDrawingUi = () => {
      if (detached) return;
      detached = true;
      window.removeEventListener('keydown', onKeyDown, true);
      if (clickL) google.maps.event.removeListener(clickL);
      if (dblL) google.maps.event.removeListener(dblL);
      if (moveL) google.maps.event.removeListener(moveL);
      if (outL) google.maps.event.removeListener(outL);
      cornerMarkers.forEach(m => m.setMap(null));
      cornerMarkers.length = 0;
      draftPolylineRef.current?.setMap(null);
      draftPolylineRef.current = null;
      startMarker.setMap(null);
      cursorMarker.setMap(null);
      draftStartMarkerRef.current = null;
      draftCursorMarkerRef.current = null;
      draftPathRef.current = [];
      map.setOptions({ disableDoubleClickZoom: false });
    };

    const completeDraftPolygon = () => {
      const path = draftPathRef.current;
      if (path.length < 3) return;
      const pathCopy = path.map(p => ({ lat: p.lat(), lng: p.lng() }));
      detachDrawingUi();
      const polygon = new google.maps.Polygon({
        paths: pathCopy,
        map,
        editable: true,
        draggable: false,
        fillColor: '#3b82f6',
        fillOpacity: 0.28,
        strokeColor: '#2563eb',
        strokeWeight: 2.5,
        zIndex: 2,
      });
      const areaSqM = google.maps.geometry.spherical.computeArea(polygon.getPath());
      const areaSqFt = areaSqM * 10.7639;
      if (areaSqFt < 10) {
        polygon.setMap(null);
        setIsDrawing(false);
        return;
      }
      addSection(polygon, areaSqFt);
    };

    const tryAddOrClose = (latLng: google.maps.LatLng, fromDoubleClick: boolean) => {
      const path = draftPathRef.current;
      if (fromDoubleClick && path.length >= 3) {
        completeDraftPolygon();
        return;
      }
      if (path.length > 0) {
        const dLast = google.maps.geometry.spherical.computeDistanceBetween(latLng, path[path.length - 1]);
        if (dLast < MIN_VERTEX_SEP_M) return;
      }
      path.push(latLng);
      draftLine.setPath(path);
      if (path.length === 1) {
        startMarker.setPosition(path[0]);
        startMarker.setVisible(true);
      } else {
        cornerMarkers.push(
          new google.maps.Marker({
            map,
            position: latLng,
            zIndex: 4,
            clickable: false,
            optimized: true,
            icon: vertexIcon('#94a3b8', 6),
          })
        );
      }
    };

    const onClick = (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      tryAddOrClose(e.latLng, false);
    };
    const onDbl = (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      tryAddOrClose(e.latLng, true);
    };

    clickL = map.addListener('click', onClick);
    dblL = map.addListener('dblclick', onDbl);
    moveL = map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      cursorMarker.setPosition(e.latLng);
      cursorMarker.setVisible(true);
    });
    outL = map.addListener('mouseout', () => {
      cursorMarker.setVisible(false);
    });

    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      detachDrawingUi();
    };
  }, [isDrawing, mapLoaded, addSection]);

  const deleteSection = (id: string) => {
    setSections(prev => {
      const section = prev.find(s => s.id === id);
      if (section?.polygon) section.polygon.setMap(null);
      // Clean up label
      const idx = prev.findIndex(s => s.id === id);
      if (labelsRef.current[idx]) {
        labelsRef.current[idx].close();
        labelsRef.current.splice(idx, 1);
      }
      return prev.filter(s => s.id !== id);
    });
    if (selectedSection === id) setSelectedSection(null);
  };

  const updatePitch = (id: string, pitchValue: string) => {
    const pitchOption = PITCH_OPTIONS.find(p => p.value === pitchValue)!;
    setSections(prev =>
      prev.map(s =>
        s.id === id
          ? {
              ...s,
              pitch: pitchValue,
              pitchMultiplier: pitchOption.multiplier,
              actualArea: computeActualArea(s.flatArea, pitchOption.multiplier),
            }
          : s
      )
    );
  };

  const centerOnProperty = () => {
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.setCenter(coordinates);
    mapInstanceRef.current.setZoom(20);
  };

  const totalFlat = sections.reduce((s, r) => s + r.flatArea, 0);
  const totalActual = sections.reduce((s, r) => s + r.actualArea, 0);
  const totalSquares = Math.ceil((totalActual * 1.12) / 100);

  const buildSnapshotUrl = (sects: RoofSection[], zoom: number, size = '800x500') =>
    buildSectionStaticMapUrl(coordinates, apiKey, sects, zoom, size);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    setUploadedPhoto(prev => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return { file, previewUrl };
    });
    setAiStatus('idle');
    setAiResult(null);
    setAiError(null);
    setGeometryDetail(null);
    setAiExpanded(true);
  };

  const analyzeWithAI = async (useUploadedPhoto = false) => {
    setAiStatus('analyzing');
    setAiResult(null);
    setAiError(null);
    setGeometryDetail(null);
    setAiExpanded(true);
    try {
      let result: RoofAnalysis;
      if (useUploadedPhoto && uploadedPhoto) {
        result = await analyzeRoofImageFromFile(uploadedPhoto.file, solarData);
      } else {
        const hasDrawnOverlay = sections.some(s => s.polygon);
        const zoomHd = hasDrawnOverlay ? 21 : 20;
        const url = hasDrawnOverlay
          ? buildSectionStaticMapUrl(coordinates, apiKey, sections, zoomHd, '640x640')
          : `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;
        if (hasDrawnOverlay && hasGeminiKey) {
          const [r, g] = await Promise.all([
            analyzeRoofImage(url, solarData),
            analyzeRoofGeometryFromCapture(url, solarData).catch(() => null),
          ]);
          result = r;
          setGeometryDetail(g);
        } else {
          result = await analyzeRoofImage(url, solarData);
        }
      }
      setAiResult(result);
      setAiStatus('done');
    } catch (err) {
      setAiStatus('error');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'GOOGLE_AI_KEY_MISSING') {
        setAiError('No Gemini key. Add it in Settings, or set VITE_GOOGLE_AI_KEY or GEMINI_API_KEY for this deployment, then rebuild.');
      } else if (msg === 'GEMINI_AUTH_FAILED') {
        setAiError('Gemini rejected the API key. Confirm the key in Google AI Studio, enable Generative Language API, and check billing.');
      } else if (msg.startsWith('IMAGE_HTTP_')) {
        setAiError('Could not download the satellite image. Check Maps Static API and that your Maps key allows this domain.');
      } else if (msg === 'IMAGE_TOO_SMALL' || msg === 'IMAGE_NOT_MAP') {
        setAiError('The map image from Google was empty or invalid (often a key or Static Maps API issue). Check your Maps key and enabled APIs.');
      } else if (msg.startsWith('GEMINI_BLOCKED')) {
        setAiError('The model blocked this request (safety). Try again or use a clearer satellite view.');
      } else if (msg.startsWith('GEMINI_FINISH')) {
        setAiError('The model stopped early (finish reason). Try Run AI Analysis again.');
      } else if (msg === 'GEMINI_BAD_JSON') {
        setAiError('The model response was not valid JSON. Try Run again.');
      } else if (msg === 'GEMINI_MODEL_UNAVAILABLE') {
        setAiError('No Gemini model responded. Check your network and that your AI Studio key can use Gemini 2.5 / Flash models.');
      } else {
        setAiError(msg.length > 180 ? `${msg.slice(0, 180)}…` : msg);
      }
    }
  };

  const handleComplete = () => {
    if (linkedProjectId) {
      void executeQuickSave('use-linked');
      return;
    }
    if (!isDbConfigured()) {
      void executeQuickSave('new');
      return;
    }
    setSaveChoicePurpose('quick');
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row overflow-hidden">
      {/* Map area — fixed share of height on phones; full flex on desktop */}
      <div className="relative w-full h-[38%] min-h-[170px] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
        {/* Map + Street View side by side */}
        <div className="flex h-full w-full">
          <div
            ref={mapRef}
            className={`h-full min-h-0 lg:min-h-[200px] transition-all duration-300 ${showStreetView ? 'w-1/2' : 'w-full'}`}
          />
          {/* Street View pane */}
          <div
            ref={streetViewRef}
            className={`h-full border-l-2 border-slate-700 transition-all duration-300 ${showStreetView ? 'w-1/2' : 'w-0 overflow-hidden'}`}
          >
            {/* "Not available" overlay shown inside the div when SV is toggled but unavailable */}
            {showStreetView && !streetViewAvailable && (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-slate-900 px-4 text-center">
                <Navigation size={32} className="text-slate-500" />
                <p className="text-sm font-medium text-slate-300">Street View not available</p>
                <p className="text-xs text-slate-500">No street-level imagery within 100 m of this address.</p>
              </div>
            )}
          </div>
        </div>

        {/* Loading overlay */}
        {!mapLoaded && !mapError && (
          <div className="absolute inset-0 bg-slate-900 flex flex-col items-center justify-center gap-3 z-10">
            <div className="w-10 h-10 border-3 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" style={{ borderWidth: 3 }} />
            <p className="text-white font-medium">Loading satellite imagery…</p>
            <p className="text-slate-400 text-sm">{address}</p>
          </div>
        )}

        {/* Error overlay */}
        {mapError && (
          <div className="absolute inset-0 bg-slate-900 flex flex-col items-center justify-center gap-4 z-10 p-6">
            <AlertCircle size={40} className="text-red-400" />
            <p className="text-white font-semibold text-lg text-center">{mapError}</p>
          </div>
        )}

        {/* Map toolbar */}
        {mapLoaded && (
          <div className="absolute top-[max(0.5rem,env(safe-area-inset-top,0px))] left-2 right-2 lg:top-3 lg:left-3 lg:right-auto flex flex-wrap gap-1.5 z-10 max-w-full">

            {/* ── Row 1: Zoom presets + Re-center ── */}
            <div className="flex gap-1 bg-white rounded-xl shadow-md border border-slate-200 p-1">
              <button
                type="button"
                onClick={centerOnProperty}
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

            {/* ── Row 1: Map type + overlays ── */}
            <div className="flex gap-1 bg-white rounded-xl shadow-md border border-slate-200 p-1">
              {/* Hybrid toggle */}
              <button
                type="button"
                onClick={() => setMapType(t => t === 'satellite' ? 'hybrid' : 'satellite')}
                title={mapType === 'satellite' ? 'Show street labels (Hybrid view)' : 'Hide street labels (Satellite view)'}
                className={`touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg transition-all ${
                  mapType === 'hybrid'
                    ? 'bg-green-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Map size={13} />
                <span className="hidden sm:inline">{mapType === 'hybrid' ? 'Labels On' : 'Labels'}</span>
              </button>
              <div className="w-px bg-slate-200 my-1" />
              {/* 3D tilt */}
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
              {/* Section labels */}
              <button
                type="button"
                onClick={() => setShowLabels(l => !l)}
                title="Toggle section labels"
                className={`touch-manipulation flex items-center gap-1 text-xs font-medium px-2 py-1.5 min-h-[36px] rounded-lg transition-all ${
                  showLabels ? 'text-slate-600 hover:bg-slate-100' : 'bg-slate-700 text-white'
                }`}
              >
                {showLabels ? <Eye size={13} /> : <EyeOff size={13} />}
                <span className="hidden sm:inline">Pins</span>
              </button>
            </div>

            {/* ── Street View toggle ── */}
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

            {/* Low-quality imagery warning */}
            {solarData?.imageryQuality === 'LOW' && (
              <div className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-3 py-2 min-h-[36px] rounded-xl shadow-md">
                <AlertCircle size={13} />
                <span className="hidden sm:inline">Low imagery quality — use Street View or upload a photo</span>
                <span className="sm:hidden">Low quality</span>
              </div>
            )}
          </div>
        )}

        {/* Drawing hint */}
        {isDrawing && (
          <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-2 right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-10 sm:max-w-[min(92vw,28rem)]">
            <div className="bg-slate-900/90 text-white text-[11px] sm:text-sm font-medium px-3 py-2 sm:px-4 sm:py-2.5 rounded-2xl shadow-xl flex flex-wrap items-center gap-2 backdrop-blur">
              <div className="w-2 h-2 shrink-0 rounded-full bg-orange-400 animate-pulse" />
              <span className="min-w-0 flex-1 leading-snug">
                Tap each corner — Ctrl+Z or Cmd+Z undoes the last point — double-click to finish (≥3 corners)
              </span>
              <button
                type="button"
                onClick={cancelDrawing}
                className="touch-manipulation shrink-0 text-slate-400 hover:text-white text-xs border border-slate-600 rounded-lg px-2.5 py-1.5 sm:border-0 sm:border-l sm:rounded-none sm:pl-3 sm:ml-0"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="flex w-full min-h-0 flex-1 flex-col overflow-hidden border-t border-slate-100 bg-white shadow-xl lg:w-80 lg:flex-none lg:border-l lg:border-t-0">
        {/* Sidebar header — fixed; scroll lives below so CTAs stay reachable on short phones */}
        <div className="shrink-0 border-b border-slate-100 bg-slate-50 p-3 sm:p-4">
          <div className="mb-0.5 flex items-center gap-2 sm:mb-1">
            <Layers size={15} className="text-blue-600" />
            <h2 className="text-sm font-semibold text-slate-900">Roof Sections</h2>
            {sections.length > 0 && (
              <span className="ml-auto rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {sections.length}
              </span>
            )}
          </div>
          {!fromQuickAnalysisChoice && (
            <>
              {!hideWizardEntryRoofChrome && (
                <p className="hidden text-xs text-slate-500 sm:block">
                  Draw polygons on the map to measure each roof section
                </p>
              )}

              {/* Smart Roof Mapping Wizard launch button */}
              <button
                type="button"
                onClick={() => requestOpenWizard()}
                className="mt-2 w-full flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-all shadow-sm"
              >
                <Brain size={13} />
                Smart Roof Mapping Wizard
                <ArrowRight size={13} />
              </button>
            </>
          )}

          <div className={`space-y-2 border-t border-slate-200 pt-2 sm:pt-3 ${fromQuickAnalysisChoice ? 'mt-0 sm:mt-1' : 'mt-2 sm:mt-3'}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <MapPin size={12} className="shrink-0 text-blue-600" aria-hidden />
              Current property
            </div>
            <p className="line-clamp-2 text-xs leading-snug text-slate-800 sm:line-clamp-3" title={address}>
              {address || '—'}
            </p>
            <label htmlFor="analysis-project-folder-name" className="text-[11px] font-medium text-slate-600 block mt-2">
              Project folder name
            </label>
            <input
              id="analysis-project-folder-name"
              type="text"
              value={projectFolderName}
              onChange={e => setProjectFolderName(e.target.value)}
              placeholder="e.g. Client or job name (optional)"
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            <p className="mt-1 text-[10px] text-slate-400 leading-snug">
              Saved as <span className="font-medium text-slate-600">name + address</span> in Projects. Address above stays the property location.
            </p>
            <label htmlFor="analysis-property-search" className="sr-only">
              Search for another property address
            </label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
              <input
                id="analysis-property-search"
                ref={searchInputRef}
                type="text"
                autoComplete="off"
                disabled={!mapLoaded}
                placeholder={
                  mapLoaded
                    ? openWizardAfterPropertySearch
                      ? 'Search address — wizard opens after you pick…'
                      : 'Search another address…'
                    : 'Loading map…'
                }
                className={`touch-manipulation w-full min-h-[44px] rounded-xl border bg-white py-2.5 pl-10 pr-3 text-base text-slate-800 shadow-sm outline-none placeholder:text-slate-400 focus:ring-2 disabled:bg-slate-100 disabled:text-slate-400 ${
                  openWizardAfterPropertySearch
                    ? 'border-blue-400 ring-blue-100'
                    : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100'
                }`}
              />
            </div>
            {openWizardAfterPropertySearch ? (
              <p className="rounded-lg bg-blue-50 px-2.5 py-2 text-[11px] font-medium leading-snug text-blue-900">
                Choose a property from the suggestions — the Smart Roof Mapping Wizard opens right after the map loads that address.
              </p>
            ) : (
              <p className="hidden text-[11px] leading-snug text-slate-400 sm:block">
                Choose a suggestion from the dropdown to load that roof.
              </p>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">

        {/* Solar API status banner */}
        <div className="mx-3 mt-3 mb-1">
          {solarStatus === 'loading' && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-700">
              <Loader2 size={12} className="animate-spin shrink-0" />
              <span>Fetching Solar imagery data…</span>
            </div>
          )}
          {solarStatus === 'ready' && solarData && mapLoaded && (
            <div className="space-y-1.5">
              {experimentalSolarOutlineEnabled && !hideWizardEntryRoofChrome && (
                <button
                  type="button"
                  onClick={applyExperimentalSolarOutline}
                  className="w-full rounded-lg border border-dashed border-amber-400 bg-amber-50/80 px-2 py-1.5 text-[10px] font-semibold text-amber-950 hover:bg-amber-100/70"
                >
                  Add one building outline from Solar bounding box (experimental — replaces sections)
                </button>
              )}
              {sections.length === 0 && !hideWizardEntryRoofChrome && (
                <p className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 leading-snug">
                  Trace roof sections on the map first. Roof structure and AI cues then use satellite captures cropped to
                  your outlines for better alignment.
                </p>
              )}
            </div>
          )}
          {solarStatus === 'error' && (
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-500">
              <Sun size={12} className="shrink-0 opacity-40" />
              <span>{solarError ?? 'Solar data unavailable — draw sections manually'}</span>
            </div>
          )}
        </div>

        {/* Sections list */}
        <div className="space-y-2 p-3 pb-1">
          {sections.length === 0 && !isDrawing && !hideWizardEntryRoofChrome && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center mb-3">
                <Pencil size={20} className="text-blue-500" />
              </div>
              <p className="text-slate-700 font-medium text-sm mb-1">No sections yet</p>
              <p className="text-slate-400 text-xs leading-relaxed">
                Use &quot;Draw section&quot; to place corners, then double-click to finish. Then open Roof
                structure and run satellite AI for HD geometry and condition.
              </p>
            </div>
          )}

          {sections.map(section => (
            <div
              key={section.id}
              onClick={() => setSelectedSection(section.id === selectedSection ? null : section.id)}
              className={`rounded-xl border transition-all cursor-pointer ${
                selectedSection === section.id
                  ? 'border-blue-200 bg-blue-50 shadow-sm'
                  : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50'
              }`}
            >
              <div className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: section.color }}
                  />
                  <span className="font-semibold text-slate-800 text-sm">{section.name}</span>
                  <button
                    onClick={e => { e.stopPropagation(); deleteSection(section.id); }}
                    className="ml-auto p-1 text-slate-300 hover:text-red-400 rounded-lg hover:bg-red-50 transition-all"
                    title="Delete section"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-1.5 text-xs mb-2.5">
                  <div className="bg-slate-50 rounded-lg px-2.5 py-1.5">
                    <div className="text-slate-400 mb-0.5">Flat Area</div>
                    <div className="font-semibold text-slate-800">{formatArea(section.flatArea)}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg px-2.5 py-1.5">
                    <div className="text-slate-400 mb-0.5">Actual Area</div>
                    <div className="font-semibold text-slate-800">{formatArea(section.actualArea)}</div>
                  </div>
                </div>

                {/* Pitch selector */}
                <div className="relative">
                  <label className="text-xs text-slate-400 block mb-1">Roof Pitch</label>
                  <div className="relative">
                    <select
                      value={section.pitch}
                      onChange={e => { e.stopPropagation(); updatePitch(section.id, e.target.value); }}
                      onClick={e => e.stopPropagation()}
                      className="w-full appearance-none bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 pr-7 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
                    >
                      {PITCH_OPTIONS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {sections.length > 0 && solarStatus === 'ready' && solarData && (
          <div className="mx-3 mb-2 rounded-xl border border-blue-100 bg-blue-50/90 p-3 shadow-sm">
            <div className="flex items-start gap-2">
              <Ruler size={15} className="text-blue-600 shrink-0 mt-0.5" aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs font-semibold text-blue-950">Roof structure and vision</p>
                <p className="text-[11px] text-blue-900/90 leading-snug">
                  Opens a schematic from your drawn sections, Solar facets, and Gemini line detection on a static map that
                  includes your colored outlines.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={!roofStructurePreview && !roofStructure}
              onClick={() => {
                if (!roofStructurePreview) return;
                if (!roofStructure) setRoofStructure(roofStructurePreview);
                setShowRoofStructure(true);
              }}
              className="touch-manipulation mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Ruler size={12} aria-hidden />
              View Roof Structure
            </button>
            {roofAiCueStatus === 'loading' && sections.length > 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-[10px] text-blue-800/80">
                <Loader2 size={11} className="animate-spin shrink-0" aria-hidden />
                Refining AI vision cues from your map selection…
              </p>
            )}
          </div>
        )}

        {/* Measurements Summary — scroll with sections */}
        {sections.length > 0 && (() => {
          const exportedSections = sections.map(({ polygon, ...rest }) => ({
            ...rest,
            polygonPath: (() => {
              const pts: { lat: number; lng: number }[] = [];
              polygon?.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
              return pts;
            })(),
          }));
          const m = computeRoofMeasurements(exportedSections);
          return (
            <div className="border-t border-slate-100 p-3 bg-slate-50 space-y-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Ruler size={13} className="text-slate-400" />
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Measurements</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label: 'Roof Area', value: formatArea(m.totalActualAreaSqFt) },
                  { label: 'Roof Facets', value: String(m.facets) },
                  { label: 'Predominant Pitch', value: m.predominantPitch },
                  { label: 'Squares (est.)', value: `${m.totalSquares} sq` },
                  { label: 'Plan Area', value: formatArea(m.totalFlatAreaSqFt) },
                  { label: 'Perimeter', value: formatFt(m.totalPerimeterFt) },
                ].map(item => (
                  <div key={item.label} className="bg-white rounded-lg p-2 border border-slate-100 text-center">
                    <div className="text-[10px] text-slate-400 leading-none mb-1">{item.label}</div>
                    <div className="text-xs font-bold text-slate-900">{item.value}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-1.5 bg-blue-50 rounded-lg p-2 text-xs text-blue-700">
                <Info size={11} className="mt-0.5 flex-shrink-0" />
                <span>Includes 12% waste factor · Perimeter from polygon boundaries</span>
              </div>
            </div>
          );
        })()}

        {/* AI Assessment */}
        {sections.length > 0 && (
          <div className="border-t border-slate-100">
            <button
              onClick={() => setAiExpanded(e => !e)}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-purple-50 hover:bg-purple-100 transition-colors text-xs font-semibold text-purple-700"
            >
              <Brain size={13} className="text-purple-500" />
              AI Roof Assessment
              {aiStatus === 'done' && aiResult && (
                <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full ${CONDITION_BG[aiResult.condition]}`}>
                  {aiResult.condition}
                </span>
              )}
              {aiStatus !== 'done' && (
                <span className="ml-auto text-purple-400">
                  {aiExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
              )}
            </button>

            {aiExpanded && (
              <div className="px-3 py-2.5 bg-purple-50/50 space-y-2">

                {/* Photo upload strip — always visible in expanded state */}
                <div className="rounded-lg border border-purple-100 bg-white overflow-hidden">
                  {uploadedPhoto ? (
                    <div className="flex items-center gap-2 p-2">
                      <img
                        src={uploadedPhoto.previewUrl}
                        alt="Uploaded roof photo"
                        className="w-14 h-10 object-cover rounded-md border border-slate-200 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold text-slate-700 truncate">{uploadedPhoto.file.name}</p>
                        <p className="text-[10px] text-slate-400">Uploaded photo ready for analysis</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          URL.revokeObjectURL(uploadedPhoto.previewUrl);
                          setUploadedPhoto(null);
                          if (photoInputRef.current) photoInputRef.current.value = '';
                        }}
                        className="shrink-0 text-slate-300 hover:text-red-400 transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <label className="flex items-center gap-2 p-2 cursor-pointer hover:bg-slate-50 transition-colors">
                      <div className="w-14 h-10 rounded-md border-2 border-dashed border-slate-200 flex items-center justify-center shrink-0">
                        <Camera size={16} className="text-slate-300" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold text-slate-600">Upload a photo</p>
                        <p className="text-[10px] text-slate-400">Drone, site, or street photo</p>
                      </div>
                      <Upload size={13} className="text-slate-400 shrink-0" />
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={handlePhotoUpload}
                      />
                    </label>
                  )}
                </div>

                {aiStatus === 'idle' && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => analyzeWithAI(false)}
                      disabled={!hasGeminiKey}
                      className="flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-semibold px-2 py-2 rounded-lg transition-colors"
                      title={!hasGeminiKey ? 'Add your Gemini key in Settings to enable AI' : 'Analyze the satellite map image'}
                    >
                      <Satellite size={12} />
                      Satellite
                    </button>
                    <button
                      onClick={() => analyzeWithAI(true)}
                      disabled={!hasGeminiKey || !uploadedPhoto}
                      className="flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-semibold px-2 py-2 rounded-lg transition-colors"
                      title={!uploadedPhoto ? 'Upload a photo first' : 'Analyze your uploaded photo'}
                    >
                      <Camera size={12} />
                      My Photo
                    </button>
                  </div>
                )}
                {aiStatus === 'analyzing' && (
                  <div className="flex items-center justify-center gap-2 text-xs text-purple-600 py-2">
                    <Loader2 size={13} className="animate-spin" />
                    Analyzing roof condition…
                  </div>
                )}
                {aiStatus === 'error' && (
                  <div className="text-xs text-red-600 text-center py-1 space-y-1">
                    <p className="leading-snug">{aiError || 'Analysis failed.'}</p>
                    <div className="flex gap-2 justify-center">
                      <button type="button" onClick={() => analyzeWithAI(false)} className="text-purple-700 underline font-medium">Satellite</button>
                      {uploadedPhoto && <button type="button" onClick={() => analyzeWithAI(true)} className="text-purple-700 underline font-medium">My Photo</button>}
                    </div>
                  </div>
                )}
                {aiStatus === 'done' && aiResult && (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`font-bold px-2 py-0.5 rounded-full ${CONDITION_BG[aiResult.condition]}`}>{aiResult.condition}</span>
                      <span className={`px-2 py-0.5 rounded-full ${URGENCY_BG[aiResult.urgency]}`}>{aiResult.urgency} urgency</span>
                      <span className="ml-auto text-slate-400">{aiResult.condition_score}/10</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${aiResult.condition_score * 10}%`, backgroundColor: CONDITION_COLORS[aiResult.condition] }} />
                    </div>
                    <p className="text-slate-500"><span className="font-medium text-slate-600">Life:</span> {aiResult.estimated_remaining_life}</p>
                    {aiResult.issues.length > 0 && (
                      <ul className="text-slate-500 space-y-0.5">
                        {aiResult.issues.map((issue, i) => (
                          <li key={i} className="flex gap-1"><span className="text-amber-400">•</span>{issue}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-slate-600 italic bg-white rounded-lg px-2 py-1.5 border border-purple-100">"{aiResult.recommendation}"</p>
                    {geometryDetail && (
                      <div className="rounded-lg border border-blue-100 bg-blue-50/80 p-2.5 space-y-1.5 text-[11px] text-slate-800">
                        <p className="font-semibold text-blue-950">Gemini HD geometry (slopes · valleys · ridges)</p>
                        <p className="text-slate-700 leading-snug">{geometryDetail.summary}</p>
                        {geometryDetail.steep_slopes.length > 0 && (
                          <div>
                            <span className="font-semibold text-slate-600">Steep / complex:</span>
                            <ul className="mt-0.5 list-disc pl-4 text-slate-600">
                              {geometryDetail.steep_slopes.map((t, i) => (
                                <li key={`s-${i}`}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {geometryDetail.valleys.length > 0 && (
                          <div>
                            <span className="font-semibold text-slate-600">Valleys:</span>
                            <ul className="mt-0.5 list-disc pl-4 text-slate-600">
                              {geometryDetail.valleys.map((t, i) => (
                                <li key={`v-${i}`}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {geometryDetail.ridges_hips.length > 0 && (
                          <div>
                            <span className="font-semibold text-slate-600">Ridges / hips:</span>
                            <ul className="mt-0.5 list-disc pl-4 text-slate-600">
                              {geometryDetail.ridges_hips.map((t, i) => (
                                <li key={`r-${i}`}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {geometryDetail.perimeters_eaves_rakes.length > 0 && (
                          <div>
                            <span className="font-semibold text-slate-600">Eaves / rakes / perimeter:</span>
                            <ul className="mt-0.5 list-disc pl-4 text-slate-600">
                              {geometryDetail.perimeters_eaves_rakes.map((t, i) => (
                                <li key={`e-${i}`}>{t}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {geometryDetail.caveats.length > 0 && (
                          <p className="text-[10px] text-amber-900/90 leading-snug">
                            <span className="font-semibold">Note:</span> {geometryDetail.caveats.join(' ')}
                          </p>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => analyzeWithAI(false)} className="text-purple-500 hover:text-purple-700 text-[10px] underline">Re-analyze satellite</button>
                      {uploadedPhoto && <button onClick={() => analyzeWithAI(true)} className="text-purple-500 hover:text-purple-700 text-[10px] underline">Use my photo</button>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        </div>

        {/* Primary actions — outside scroll region so Draw / Save stay visible without scrolling (mobile + desktop sidebar) */}
        <div className="shrink-0 border-t border-slate-200 bg-white p-2.5 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] shadow-[0_-6px_20px_-8px_rgba(15,23,42,0.12)] lg:p-3 lg:shadow-none">
          {!isDrawing ? (
            hideWizardEntryRoofChrome ? null : (
            <div className="grid grid-cols-2 gap-2 lg:flex lg:w-full lg:flex-col lg:gap-2">
              <button
                type="button"
                onClick={startDrawing}
                disabled={!mapLoaded}
                className="touch-manipulation flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-2 py-2.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-blue-700 active:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 lg:min-h-[48px] lg:gap-2 lg:px-4 lg:py-3 lg:text-sm"
              >
                <Pencil size={14} className="shrink-0" aria-hidden />
                <span className="min-w-0 text-center leading-tight">Draw section</span>
              </button>
              <button
                type="button"
                onClick={handleComplete}
                disabled={sections.length === 0 || saving}
                className="touch-manipulation flex min-h-[44px] w-full items-center justify-center gap-1 rounded-xl bg-slate-900 px-2 py-2.5 text-xs font-semibold text-white transition-all hover:bg-slate-800 active:bg-slate-950 disabled:bg-slate-100 disabled:text-slate-400 lg:min-h-[48px] lg:gap-2 lg:px-4 lg:py-3 lg:text-sm"
              >
                {saving ? (
                  <>
                    <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                    <span className="min-w-0 leading-tight">Saving…</span>
                  </>
                ) : saveStatus === 'saved' ? (
                  <>
                    <CheckCircle2 size={14} className="shrink-0" aria-hidden />
                    <span className="min-w-0 leading-tight lg:hidden">Saved ✓</span>
                    <span className="min-w-0 hidden leading-tight lg:inline">
                      Saved · Generate quote
                    </span>
                  </>
                ) : (
                  <>
                    <Save size={14} className="shrink-0" aria-hidden />
                    <span className="min-w-0 text-center leading-tight">Save &amp; Quote</span>
                    <ArrowRight size={14} className="hidden shrink-0 lg:inline" aria-hidden />
                  </>
                )}
              </button>
            </div>
            )
          ) : (
            <button
              type="button"
              onClick={cancelDrawing}
              className="touch-manipulation flex w-full min-h-[44px] lg:min-h-[48px] items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-orange-600 active:bg-orange-700"
            >
              <RotateCcw size={14} aria-hidden />
              Cancel drawing
            </button>
          )}
          {saveStatus === 'error' && (
            <p className="mt-1.5 text-center text-[11px] leading-snug text-red-500">Saved locally — DB save failed</p>
          )}
        </div>
      </aside>

      {showRoofStructure && roofStructure && (
        <RoofStructurePanel
          analysis={roofStructure}
          mapCenter={coordinates}
          mapsApiKey={apiKey}
          solarInsights={solarData}
          roofCaptureRings={roofCaptureRings}
          onApply={next => setRoofStructure(next)}
          onClose={() => setShowRoofStructure(false)}
        />
      )}

      {showWizard && (
        <ErrorBoundary>
          <RoofMappingWizard
            apiKey={apiKey}
            address={address}
            coordinates={coordinates}
            solarData={solarData}
            existingProjectId={wizardExistingProjectId}
            projectFolderName={projectFolderName.trim() || null}
            onReportReady={ctx => {
              onWizardReportReady?.(ctx);
              setShowWizard(false);
              setWizardAttach({ mode: 'inherit' });
              setOpenWizardAfterPropertySearch(false);
            }}
            onClose={() => {
              setShowWizard(false);
              setWizardAttach({ mode: 'inherit' });
              setOpenWizardAfterPropertySearch(false);
            }}
          />
        </ErrorBoundary>
      )}

      <SaveProjectChoiceModal
        open={saveChoicePurpose !== null}
        purpose={saveChoicePurpose}
        currentAddress={address}
        onCancel={() => setSaveChoicePurpose(null)}
        onChooseNew={() => {
          const p = saveChoicePurpose;
          setSaveChoicePurpose(null);
          if (p === 'quick') void executeQuickSave('new');
          else if (p === 'wizard') {
            setWizardAttach({ mode: 'new' });
            if (address.trim()) {
              setShowWizard(true);
            } else {
              setOpenWizardAfterPropertySearch(true);
              queueMicrotask(() => searchInputRef.current?.focus());
            }
          }
        }}
        onChooseExisting={id => {
          const p = saveChoicePurpose;
          setSaveChoicePurpose(null);
          if (p === 'quick') void executeQuickSave(id);
          else if (p === 'wizard') {
            setWizardAttach({ mode: 'existing', id });
            if (address.trim()) {
              setShowWizard(true);
            } else {
              setOpenWizardAfterPropertySearch(true);
              queueMicrotask(() => searchInputRef.current?.focus());
            }
          }
        }}
      />
    </div>
  );
}
