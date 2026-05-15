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
  ArrowLeft,
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
  Zap,
  Map,
  Navigation,
  Camera,
  Upload,
  X,
  ZoomIn,
  FolderOpen,
  Check,
} from 'lucide-react';
import { saveProject } from '../utils/db';
import { analyzeRoofImage, analyzeRoofImageFromFile, RoofAnalysis, CONDITION_BG, URGENCY_BG, CONDITION_COLORS } from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';
import {
  fetchBuildingInsights,
  fetchDataLayers,
  segmentToBoundingPolygon,
  pitchDegreesToOption,
  formatImageryDate,
  type SolarBuildingInsights,
  type SolarDataLayersResponse,
} from '../utils/solar';
import { computeRoofMeasurements, formatFt } from '../utils/measurements';
import { analyzeSolarSegments, type RoofStructureAnalysis } from '../utils/roofStructure';
import { buildHeightModel, type HeightModel } from '../utils/heightModel';
import {
  deriveHeuristicRoofCues,
  deriveVisionRoofCuesFromStaticMap,
  deriveVisionRoofCuesFromFile,
  mapPhotoCuesToAiCues,
  type RoofPhotoCueAnalysis,
} from '../utils/roofVision';
import RoofStructurePanel from './RoofStructurePanel';
import RoofMappingWizard from './RoofMappingWizard';
import SaveProjectChoiceModal from './SaveProjectChoiceModal';
import { ErrorBoundary } from './ErrorBoundary';
import type { WizardAttachSnapshot } from '../utils/authSession';

interface WizardAttach {
  mode: 'inherit' | 'new' | 'existing';
  projectId?: string;
  /** Set when mode is `new` — becomes wizard `project_name` / report `projectFolderName`. */
  newProjectName?: string;
  /** Display title when mode is `existing` (for sidebar folder label). */
  existingDisplayName?: string;
}

interface AnalysisPageProps {
  apiKey: string;
  address: string;
  coordinates: Coordinates;
  /** Called when the user picks a new address from the in-tab search (updates map + clears work in progress). */
  onPropertySelect: (address: string, coordinates: Coordinates) => void;
  onComplete: (sections: Omit<RoofSection, 'polygon'>[], projectId: string | null) => void;
  /** Return to New Analysis hub and cancel the in-progress flow. */
  onBack?: () => void;
  /** When true, the Smart Roof Mapping Wizard opens immediately on mount. */
  startInWizardMode?: boolean;
  /** After wizard workflow saves; parent keeps projectId in sync. */
  onWizardProjectPersisted?: (projectId: string) => void;
  /** Called when user clicks "Save Project" — parent should navigate to New Analysis. */
  onWizardSaveAndNew?: () => void;
  /** True when arriving from the New Analysis hub via the wizard card (hides draw-outline chrome). */
  fromAnalysisHub?: boolean;
  /** When true, wizard opens in DSM auto-segmentation mode. */
  startInAutoSegmentMode?: boolean;
  /** Restore full-screen wizard after refresh (session). */
  restoredWizardOpen?: boolean;
  restoredWizardAttach?: WizardAttachSnapshot | null;
  onWizardSessionPersist?: (payload: { open: boolean; attach: WizardAttachSnapshot }) => void;
}

function wizardAttachFromSnapshot(a: WizardAttachSnapshot | null | undefined): WizardAttach {
  if (a && a.mode !== 'inherit') {
    return {
      mode: a.mode,
      projectId: a.projectId,
      newProjectName: a.newProjectName,
      existingDisplayName: a.existingDisplayName,
    };
  }
  return { mode: 'inherit' };
}

function wizardAttachToSnapshot(w: WizardAttach): WizardAttachSnapshot {
  return {
    mode: w.mode,
    projectId: w.projectId,
    newProjectName: w.newProjectName,
    existingDisplayName: w.existingDisplayName,
  };
}

export default function AnalysisPage({
  apiKey,
  address,
  coordinates,
  onPropertySelect,
  onComplete,
  onBack,
  startInWizardMode = false,
  onWizardProjectPersisted,
  onWizardSaveAndNew,
  fromAnalysisHub = false,
  startInAutoSegmentMode = false,
  restoredWizardOpen = false,
  restoredWizardAttach = null,
  onWizardSessionPersist,
}: AnalysisPageProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const drawingManagerRef = useRef<google.maps.drawing.DrawingManager | null>(null);
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
  const hasGeminiKey = !!readGeminiApiKey();
  const labelsRef = useRef<google.maps.InfoWindow[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [solarStatus, setSolarStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [solarData, setSolarData] = useState<SolarBuildingInsights | null>(null);
  const [solarDataLayers, setSolarDataLayers] = useState<SolarDataLayersResponse | null>(null);
  const [heightModel, setHeightModel] = useState<HeightModel | null>(null);
  const [roofAiCues, setRoofAiCues] = useState<ReturnType<typeof deriveHeuristicRoofCues> | null>(null);
  const [roofAiCueStatus, setRoofAiCueStatus] = useState<'idle' | 'loading' | 'ready' | 'fallback'>('idle');
  const [solarError, setSolarError] = useState<string | null>(null);
  const [roofStructure, setRoofStructure] = useState<RoofStructureAnalysis | null>(null);
  const [showRoofStructure, setShowRoofStructure] = useState(false);
  const [showWizard, setShowWizard] = useState(() => restoredWizardOpen);
  const [showSaveProjectModal, setShowSaveProjectModal] = useState(false);
  const [wizardAttach, setWizardAttach] = useState<WizardAttach>(() => wizardAttachFromSnapshot(restoredWizardAttach));
  /** Smart Roof Wizard sidebar: live “folder” listing from RoofMappingWizard. */
  const [wizardFolderManifest, setWizardFolderManifest] = useState<{ id: string; label: string; done: boolean }[]>([]);
  const [wizardFolderExpanded, setWizardFolderExpanded] = useState(true);
  // When coming from hub with no address yet, defer wizard opening until address is searched
  const [openWizardAfterPropertySearch, setOpenWizardAfterPropertySearch] = useState(startInWizardMode && !address.trim());

  useEffect(() => {
    onWizardSessionPersist?.({
      open: showWizard,
      attach: wizardAttachToSnapshot(wizardAttach),
    });
  }, [showWizard, wizardAttach, onWizardSessionPersist]);

  /** Hub prep flow (Smart Roof Wizard or DSM Auto-Map): same first screen as manual wizard — hide Quick Analysis-only sidebar. Plain Quick Analysis keeps full sidebar. */
  const hideQuickAnalysisSidebar = startInWizardMode;

  const wizardSidebarFolderTitle = useMemo(() => {
    if (wizardAttach.mode === 'new' && wizardAttach.newProjectName?.trim()) return wizardAttach.newProjectName.trim();
    if (wizardAttach.mode === 'existing' && wizardAttach.existingDisplayName?.trim()) return wizardAttach.existingDisplayName.trim();
    if (address.trim()) return address.trim();
    return 'Project folder';
  }, [wizardAttach.mode, wizardAttach.newProjectName, wizardAttach.existingDisplayName, address]);

  const roofStructurePreview = useMemo(() => {
    const segments = solarData?.roofSegmentStats ?? [];
    if (solarStatus !== 'ready' || !solarData || segments.length === 0) return null;
    const model = heightModel ?? buildHeightModel(segments, solarDataLayers);
    const aiCues = roofAiCues ?? deriveHeuristicRoofCues(segments, solarData.center);
    return analyzeSolarSegments(segments, solarData.center, {
      imageryQuality: solarData.imageryQuality,
      hasDsm: !!solarDataLayers?.dsmUrl,
      heightModel: model,
      aiCues,
    });
  }, [solarData, solarStatus, solarDataLayers, heightModel, roofAiCues]);

  // Map view controls
  const [mapType, setMapType] = useState<'satellite' | 'hybrid'>('satellite');
  const [showStreetView, setShowStreetView] = useState(false);
  const [streetViewAvailable, setStreetViewAvailable] = useState(false);
  const streetViewRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);

  // Photo upload for AI analysis
  const [uploadedPhoto, setUploadedPhoto] = useState<{ file: File; previewUrl: string } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Multi-angle photo analysis (sidebar section)
  const MULTI_ANGLE_SLOTS = [
    { id: 'front_left' as const,   label: 'Front Left' },
    { id: 'front_center' as const, label: 'Front Center' },
    { id: 'front_right' as const,  label: 'Front Right' },
    { id: 'rear_left' as const,    label: 'Rear Left' },
    { id: 'rear_center' as const,  label: 'Rear Center' },
    { id: 'rear_right' as const,   label: 'Rear Right' },
  ] as const;
  type MultiSlotId = typeof MULTI_ANGLE_SLOTS[number]['id'];
  type MultiCapture = { file: File; previewUrl: string };
  type MultiResult  = { status: 'idle' | 'analyzing' | 'done' | 'error'; result?: RoofPhotoCueAnalysis; error?: string };

  const [showMultiAngle, setShowMultiAngle] = useState(false);
  const [multiCaptures, setMultiCaptures] = useState<Partial<Record<MultiSlotId, MultiCapture>>>({});
  const [multiResults,  setMultiResults]  = useState<Partial<Record<MultiSlotId, MultiResult>>>({});

  const multiCaptureCount = Object.keys(multiCaptures).length;
  const multiReadySlots   = Object.values(multiResults)
    .filter(r => r?.status === 'done' && (r.result?.qualityScore ?? 0) >= 0.4).length;
  const multiTotalCues    = Object.values(multiResults)
    .filter(r => r?.status === 'done' && r.result)
    .reduce((sum, r) => sum + (r!.result!.cues.length), 0);

  // Open wizard when address becomes available (deferred from hub flow)
  useEffect(() => {
    if (!openWizardAfterPropertySearch || !address.trim()) return;
    setOpenWizardAfterPropertySearch(false);
    setShowSaveProjectModal(true);
  }, [address, openWizardAfterPropertySearch]);

  // Request wizard flow: first chooses/creates project (modal), then opens overlay on a later click.
  const requestOpenWizard = useCallback(() => {
    if (!address.trim()) {
      setOpenWizardAfterPropertySearch(true);
      return;
    }
    if (wizardAttach.mode !== 'inherit') {
      setShowWizard(true);
      return;
    }
    setShowSaveProjectModal(true);
  }, [address, wizardAttach.mode]);

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
    if (drawingManagerRef.current) {
      drawingManagerRef.current.setDrawingMode(null);
    }
    setTimeout(() => updateLabel(newSection), 50);
  }, [updateLabel]);

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

      // If no address has been selected yet, coordinates are (0,0) — show a
      // roadmap world-view so the user sees a normal map, not broken satellite tiles.
      const hasAddress = !!(address.trim()) && (coordinates.lat !== 0 || coordinates.lng !== 0);
      const map = new google.maps.Map(mapRef.current, {
        center: hasAddress ? coordinates : { lat: 39.5, lng: -98.35 }, // US center
        zoom: hasAddress ? 20 : 4,
        mapTypeId: hasAddress ? 'satellite' : 'roadmap',
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

      // Only place the marker when we actually have a real address
      if (hasAddress) {
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
      }

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

      google.maps.event.addListener(drawingManager, 'polygoncomplete', (polygon: google.maps.Polygon) => {
        const areaSqM = google.maps.geometry.spherical.computeArea(polygon.getPath());
        const areaSqFt = areaSqM * 10.7639;
        if (areaSqFt < 10) {
          polygon.setMap(null);
          setIsDrawing(false);
          drawingManager.setDrawingMode(null);
          return;
        }
        addSection(polygon, areaSqFt);
      });

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
      setSaveStatus('idle');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, coordinates.lat, coordinates.lng]);

  // Auto-fetch Solar building insights whenever coordinates change
  useEffect(() => {
    if (!apiKey) return;
    if (coordinates.lat === 0 && coordinates.lng === 0) return; // no real address yet
    setSolarStatus('loading');
    setSolarData(null);
    setSolarDataLayers(null);
    setHeightModel(null);
    setRoofAiCues(null);
    setRoofAiCueStatus('idle');
    setSolarError(null);
    setRoofStructure(null);
    setShowRoofStructure(false);

    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBuildingInsights(coordinates.lat, coordinates.lng, apiKey);
        if (cancelled) return;
        setSolarData(data);

        const segments = data?.roofSegmentStats ?? [];
        const layers = await fetchDataLayers(coordinates.lat, coordinates.lng, 120, apiKey).catch(() => null);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinates.lat, coordinates.lng]);

  useEffect(() => {
    if (!solarData || solarStatus !== 'ready') return;
    const segments = solarData.roofSegmentStats ?? [];
    if (segments.length === 0) {
      setRoofAiCues(null);
      setRoofAiCueStatus('idle');
      return;
    }

    let cancelled = false;
    setRoofAiCueStatus('loading');
    (async () => {
      const staticMapUrl =
        `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}` +
        `&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;

      const visionCues = await deriveVisionRoofCuesFromStaticMap(staticMapUrl, solarData).catch(() => null);
      if (cancelled) return;
      if (visionCues && visionCues.length > 0) {
        setRoofAiCues(visionCues);
        setRoofAiCueStatus('ready');
        return;
      }
      const fallback = deriveHeuristicRoofCues(segments, solarData.center);
      setRoofAiCues(fallback);
      setRoofAiCueStatus('fallback');
    })();

    return () => {
      cancelled = true;
    };
  }, [solarData, solarStatus, coordinates.lat, coordinates.lng, apiKey]);

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
    if (!drawingManagerRef.current) return;
    setIsDrawing(true);
    setSelectedSection(null);
    drawingManagerRef.current.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  };

  const cancelDrawing = () => {
    if (!drawingManagerRef.current) return;
    setIsDrawing(false);
    drawingManagerRef.current.setDrawingMode(null);
  };

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

  const importSolarSegments = useCallback(() => {
    if (!solarData || !mapInstanceRef.current) return;
    const segments = solarData.roofSegmentStats ?? [];
    if (segments.length === 0) return;

    if (
      sectionsRef.current.length > 0 &&
      !window.confirm(`This will replace your ${sectionsRef.current.length} existing section(s) with Solar API data. Continue?`)
    ) return;

    // Clear existing sections
    sectionsRef.current.forEach(s => {
      if (s.polygon) {
        google.maps.event.clearInstanceListeners(s.polygon);
        s.polygon.setMap(null);
      }
    });
    labelsRef.current.forEach(l => l.close());
    labelsRef.current = [];
    sectionsRef.current = [];

    // Keep only meaningful facets: drop tiny segments (<80 sq ft), cap at 12, largest first
    // so smaller polygons render on top of larger ones (higher zIndex).
    const MIN_AREA_SQFT = 80;
    const filtered = [...segments]
      .filter(s => s.stats.areaMeters2 * 10.7639 >= MIN_AREA_SQFT)
      .sort((a, b) => b.stats.areaMeters2 - a.stats.areaMeters2)
      .slice(0, 12);

    // Build all sections first, then set state once
    const newSections: RoofSection[] = filtered.map((segment, idx) => {
      const path = segmentToBoundingPolygon(segment);
      const color = SECTION_COLORS[idx % SECTION_COLORS.length];
      const pitchOption = pitchDegreesToOption(segment.pitchDegrees);
      const flatAreaSqFt = segment.stats.areaMeters2 * 10.7639;
      const id = `solar-${Date.now()}-${idx}`;

      const polygon = new google.maps.Polygon({
        paths: path,
        fillColor: color,
        strokeColor: color,
        fillOpacity: 0.3,
        strokeWeight: 2.5,
        editable: true,
        draggable: false,
        zIndex: 1,
        map: mapInstanceRef.current,
      });

      const onAreaChange = () => {
        const newArea = google.maps.geometry.spherical.computeArea(polygon.getPath()) * 10.7639;
        setSections(prev =>
          prev.map(s =>
            s.id === id
              ? { ...s, flatArea: newArea, actualArea: computeActualArea(newArea, s.pitchMultiplier) }
              : s
          )
        );
      };
      google.maps.event.addListener(polygon.getPath(), 'set_at', onAreaChange);
      google.maps.event.addListener(polygon.getPath(), 'insert_at', onAreaChange);
      polygon.addListener('click', () => setSelectedSection(id));

      return {
        id,
        name: `Section ${idx + 1}`,
        polygon,
        flatArea: flatAreaSqFt,
        pitch: pitchOption.value,
        pitchMultiplier: pitchOption.multiplier,
        actualArea: computeActualArea(flatAreaSqFt, pitchOption.multiplier),
        color,
      };
    });

    sectionsRef.current = newSections;
    setSections(newSections);
    newSections.forEach(s => setTimeout(() => updateLabel(s), 50));
  }, [solarData, updateLabel]);

  const totalFlat = sections.reduce((s, r) => s + r.flatArea, 0);
  const totalActual = sections.reduce((s, r) => s + r.actualArea, 0);
  const totalSquares = Math.ceil((totalActual * 1.12) / 100);

  const buildSnapshotUrl = (sects: RoofSection[], zoom: number, size = '800x500'): string => {
    const params = new URLSearchParams({
      center: `${coordinates.lat},${coordinates.lng}`,
      zoom: String(zoom),
      size,
      maptype: 'satellite',
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
  };

  const handleMultiCapture = (slotId: MultiSlotId, file: File | null) => {
    if (!file) return;
    setMultiCaptures(prev => {
      const existing = prev[slotId];
      if (existing) URL.revokeObjectURL(existing.previewUrl);
      return { ...prev, [slotId]: { file, previewUrl: URL.createObjectURL(file) } };
    });
    setMultiResults(prev => ({ ...prev, [slotId]: { status: 'idle' } }));
  };

  const analyzeMultiSlot = async (slotId: MultiSlotId) => {
    const capture = multiCaptures[slotId];
    if (!capture) return;
    setMultiResults(prev => ({ ...prev, [slotId]: { status: 'analyzing' } }));
    const label = MULTI_ANGLE_SLOTS.find(s => s.id === slotId)?.label;
    try {
      const result = await deriveVisionRoofCuesFromFile(capture.file, label);
      if (!result) {
        setMultiResults(prev => ({ ...prev, [slotId]: { status: 'error', error: 'No cues detected.' } }));
        return;
      }
      setMultiResults(prev => ({ ...prev, [slotId]: { status: 'done', result } }));
    } catch (err) {
      setMultiResults(prev => ({
        ...prev,
        [slotId]: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const analyzeAllMultiSlots = async () => {
    for (const slot of MULTI_ANGLE_SLOTS) {
      if (!multiCaptures[slot.id] || multiResults[slot.id]?.status === 'analyzing') continue;
      // eslint-disable-next-line no-await-in-loop
      await analyzeMultiSlot(slot.id);
    }
  };

  const applyMultiCuesToStructure = () => {
    if (!solarData) return;
    const rawCues = Object.values(multiResults)
      .filter(r => r?.status === 'done' && r.result != null && (r.result.qualityScore ?? 0) >= 0.4)
      .flatMap(r => r!.result!.cues);
    if (rawCues.length === 0) return;
    const aiCues = mapPhotoCuesToAiCues(rawCues, solarData);
    if (aiCues.length > 0) {
      setRoofAiCues(aiCues);
      setRoofAiCueStatus('ready');
    }
  };

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
    setAiExpanded(true);
  };

  const analyzeWithAI = async (useUploadedPhoto = false) => {
    setAiStatus('analyzing');
    setAiResult(null);
    setAiError(null);
    setAiExpanded(true);
    try {
      let result: RoofAnalysis;
      if (useUploadedPhoto && uploadedPhoto) {
        result = await analyzeRoofImageFromFile(uploadedPhoto.file, solarData);
      } else {
        const url = `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;
        result = await analyzeRoofImage(url, solarData);
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

  const handleComplete = async () => {
    const exportSections = sections.map(({ polygon, ...rest }) => ({
      ...rest,
      polygonPath: (() => {
        const pts: { lat: number; lng: number }[] = [];
        polygon?.getPath().forEach(p => pts.push({ lat: p.lat(), lng: p.lng() }));
        return pts;
      })(),
    }));
    setSaving(true);
    let projectId: string | null = null;
    try {
      const snapshots = [
        { label: 'Standard View',  url: buildSnapshotUrl(sections, 19) },
        { label: 'Close-up',       url: buildSnapshotUrl(sections, 21) },
        { label: 'Overview',       url: buildSnapshotUrl(sections, 17) },
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
      projectId = await saveProject(address, coordinates, snapshots, sectionsToSave, roofStructure ?? roofStructurePreview);
      setSaveStatus('saved');
    } catch (err) {
      console.error('Failed to save project:', err);
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
    onComplete(exportSections, projectId);
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

        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="absolute top-[max(0.5rem,env(safe-area-inset-top,0px))] right-2 z-20 touch-manipulation flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 min-h-[36px] text-xs font-semibold text-slate-700 shadow-md transition-colors hover:bg-slate-50 active:bg-slate-100 lg:top-3 lg:right-3"
            aria-label="Go back to New Analysis"
          >
            <ArrowLeft size={14} aria-hidden />
            Go back
          </button>
        )}

        {/* Map toolbar */}
        {mapLoaded && (
          <div className="absolute top-[max(0.5rem,env(safe-area-inset-top,0px))] left-2 right-2 lg:top-3 lg:left-3 lg:right-auto flex flex-wrap gap-1.5 z-10 max-w-full pr-[5.5rem] sm:pr-28 lg:pr-0">

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
              <span className="min-w-0 flex-1 leading-snug">Tap to add points · Double-tap to close</span>
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
          {!hideQuickAnalysisSidebar && (
            <p className="hidden text-xs text-slate-500 sm:block">Draw polygons on the map to measure each roof section</p>
          )}

          {hideQuickAnalysisSidebar && (
            <div className="mt-2 rounded-xl border border-purple-100 bg-gradient-to-br from-purple-50/90 to-blue-50/80 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                <Brain size={14} className="text-purple-600 shrink-0" aria-hidden />
                Smart Roof Mapping Wizard
              </div>
              <p className="mt-1 text-[11px] text-slate-600 leading-snug">
                Guided analysis: structural map, multi-angle photos, and a combined report — saved in your project folder.
              </p>
            </div>
          )}
          {hideQuickAnalysisSidebar && (() => {
            const hasAddress = !!address.trim();
            const hasFolder = wizardAttach.mode !== 'inherit';
            const analysisStarted = showWizard;
            let activeIdx = 0;
            if (!hasAddress) activeIdx = 0;
            else if (!hasFolder) activeIdx = 1;
            else if (!analysisStarted) activeIdx = 2;
            else activeIdx = -1;
            const steps = [
              {
                id: 'search',
                title: 'Search the address you want to analyze',
                sub: 'Use the field below and pick a map suggestion.',
              },
              {
                id: 'folder',
                title: 'Create a project folder to save data',
                sub: 'New folder or add to an existing project.',
              },
              {
                id: 'start',
                title: 'Start analysis',
                sub: 'Open the smart roof mapping wizard when you\'re ready.',
              },
            ] as const;
            return (
              <ol className="mt-3 list-none space-y-0 p-0" aria-label="Smart roof wizard setup">
                {steps.map((step, i) => {
                  const done =
                    (i === 0 && hasAddress) ||
                    (i === 1 && hasFolder) ||
                    (i === 2 && analysisStarted);
                  const active = !done && activeIdx === i;
                  const pending = !done && !active;
                  const lineBelowDone =
                    (i === 0 && hasAddress) || (i === 1 && hasFolder);
                  return (
                    <li key={step.id} className="flex gap-3">
                      <div className="flex w-8 shrink-0 flex-col items-center">
                        <div
                          className={[
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-500 ease-out motion-reduce:transition-none',
                            done
                              ? 'bg-slate-700 text-white shadow-sm'
                              : active
                                ? 'border-2 border-slate-200 bg-fuchsia-500 text-white shadow-[0_0_0_4px_rgba(255,255,255,1),0_2px_8px_rgba(192,38,211,0.35)]'
                                : 'scale-95 bg-slate-200',
                          ].join(' ')}
                        >
                          {done ? (
                            <Check size={15} strokeWidth={2.5} aria-hidden />
                          ) : active ? (
                            <span className="h-2 w-2 rounded-full bg-white" aria-hidden />
                          ) : null}
                        </div>
                        {i < steps.length - 1 ? (
                          <div
                            className={[
                              'min-h-[2.25rem] w-0.5 flex-1 rounded-full transition-colors duration-700 ease-out motion-reduce:transition-none',
                              lineBelowDone ? 'bg-slate-700' : 'bg-slate-200',
                            ].join(' ')}
                            aria-hidden
                          />
                        ) : null}
                      </div>
                      <div
                        className={[
                          'min-w-0 flex-1 pb-5 pt-1 transition-opacity duration-500 ease-out last:pb-0',
                          pending ? 'opacity-65' : 'opacity-100',
                        ].join(' ')}
                      >
                        <p
                          className={[
                            'text-xs font-semibold leading-snug transition-colors duration-500',
                            pending ? 'text-slate-400' : 'text-slate-900',
                          ].join(' ')}
                        >
                          {step.title}
                        </p>
                        <p
                          className={[
                            'mt-0.5 text-[11px] leading-snug transition-colors duration-500',
                            active ? 'font-medium text-fuchsia-700' : 'text-slate-500',
                          ].join(' ')}
                        >
                          {step.sub}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            );
          })()}

          <div className="mt-2 space-y-2 border-t border-slate-200 pt-2 sm:mt-3 sm:pt-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <MapPin size={12} className="shrink-0 text-blue-600" aria-hidden />
              Current property
            </div>
            <p className="line-clamp-2 text-xs leading-snug text-slate-800 sm:line-clamp-3" title={address}>
              {address || '—'}
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
                placeholder={mapLoaded ? 'Search another address…' : 'Loading map…'}
                className="touch-manipulation w-full min-h-[44px] rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-base text-slate-800 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400"
              />
            </div>
            <p className="hidden text-[11px] leading-snug text-slate-400 sm:block">
              Choose a suggestion from the dropdown to load that roof.
            </p>

            {hideQuickAnalysisSidebar && (
              <>
                <button
                  type="button"
                  onClick={requestOpenWizard}
                  disabled={!mapLoaded || !address.trim()}
                  className="touch-manipulation w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  {wizardAttach.mode === 'inherit' ? (
                    <>
                      Choose or create project folder
                      <ArrowRight size={14} aria-hidden />
                    </>
                  ) : (
                    <>
                      Open smart roof mapping wizard
                      <ArrowRight size={14} aria-hidden />
                    </>
                  )}
                </button>

                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setWizardFolderExpanded(e => !e)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50"
                    aria-expanded={wizardFolderExpanded}
                  >
                    <FolderOpen size={16} className="shrink-0 text-amber-600" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800" title={wizardSidebarFolderTitle}>
                      {wizardSidebarFolderTitle}
                    </span>
                    {wizardFolderExpanded ? <ChevronUp size={14} className="shrink-0 text-slate-400" /> : <ChevronDown size={14} className="shrink-0 text-slate-400" />}
                  </button>
                  {wizardFolderExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/80 px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {wizardFolderManifest.length === 0 ? (
                        <p className="text-[11px] text-slate-500 leading-snug">
                          Folder is empty. Use the button above to pick a project, then open the wizard to run each analysis step.
                        </p>
                      ) : (
                        wizardFolderManifest.map(item => (
                          <div key={item.id} className="flex items-start gap-2 text-[11px] text-slate-700">
                            {item.done ? (
                              <Check size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                            ) : (
                              <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-blue-500" aria-hidden />
                            )}
                            <span className="leading-snug min-w-0">{item.label}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">

        {!hideQuickAnalysisSidebar && (
        <>
        {/* Solar API status banner */}
        <div className="mx-3 mt-3 mb-1">
          {solarStatus === 'loading' && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-700">
              <Loader2 size={12} className="animate-spin shrink-0" />
              <span>Fetching Solar imagery data…</span>
            </div>
          )}
          {solarStatus === 'ready' && solarData && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                <Sun size={13} className="text-amber-500 shrink-0" />
                Solar data loaded
                <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  solarData.imageryQuality === 'HIGH' ? 'bg-green-100 text-green-700' :
                  solarData.imageryQuality === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                  'bg-slate-100 text-slate-500'
                }`}>
                  {solarData.imageryQuality} quality
                </span>
              </div>
              <p className="text-amber-700">
                {(solarData.roofSegmentStats ?? []).length} roof segment{(solarData.roofSegmentStats ?? []).length !== 1 ? 's' : ''} detected
                · imagery {formatImageryDate(solarData.imageryDate)}
              </p>
              <p className="text-[10px] text-amber-800/80">
                Height source: {heightModel?.source === 'dsm' ? 'DSM (data layers)' : heightModel?.source === 'solar-plane' ? 'Solar plane heights' : 'none'}
              </p>
              <p className="text-[10px] text-amber-800/70">
                AI cues: {(roofAiCues?.length ?? 0)} inferred lines
                {' · '}
                {roofAiCueStatus === 'ready' ? 'vision model' : roofAiCueStatus === 'loading' ? 'analyzing…' : 'heuristic fallback'}
              </p>
              {mapLoaded && (solarData.roofSegmentStats ?? []).length > 0 && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={importSolarSegments}
                    className="touch-manipulation w-full flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                  >
                    <Zap size={12} />
                    Auto-import roof segments
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const segments = solarData.roofSegmentStats ?? [];
                      if (segments.length === 0) return;
                      if (!roofStructure) {
                        const aiCues = roofAiCues ?? deriveHeuristicRoofCues(segments, solarData.center);
                        setRoofStructure(
                          analyzeSolarSegments(segments, solarData.center, {
                            imageryQuality: solarData.imageryQuality,
                            hasDsm: !!solarDataLayers?.dsmUrl,
                            heightModel: heightModel ?? buildHeightModel(segments, solarDataLayers),
                            aiCues,
                          })
                        );
                      }
                      setShowRoofStructure(true);
                    }}
                    className="touch-manipulation w-full flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                  >
                    <Ruler size={12} />
                    View Roof Structure
                  </button>
                  {(roofStructurePreview || roofStructure) && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-2 py-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700">Structure confidence</span>
                        <span
                          className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 ${
                            (roofStructure ?? roofStructurePreview)?.confidenceBand === 'high'
                              ? 'bg-green-100 text-green-700'
                              : (roofStructure ?? roofStructurePreview)?.confidenceBand === 'medium'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {(roofStructure ?? roofStructurePreview)?.confidenceBand.toUpperCase()}
                        </span>
                      </div>
                      {(roofStructure ?? roofStructurePreview)?.confidenceBand === 'low' && (
                        <p className="text-[10px] text-amber-700 leading-snug">
                          Add 2-4 property photos to improve ridge/valley accuracy.
                        </p>
                      )}
                    </div>
                  )}
                </div>
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

        {/* ── Multi-Angle Photo Analysis ──────────────────────────── */}
        <div className="mx-3 mt-2">
          <button
            type="button"
            onClick={() => setShowMultiAngle(v => !v)}
            className="w-full flex items-center gap-2 text-xs font-semibold text-indigo-700 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 rounded-xl transition-colors"
          >
            <Camera size={13} className="text-indigo-500 shrink-0" />
            Multi-Angle Photo Analysis
            {multiCaptureCount > 0 && (
              <span className="ml-auto text-[10px] font-medium text-indigo-500">
                {multiCaptureCount}/6 uploaded · {multiTotalCues} cues
              </span>
            )}
            {showMultiAngle ? <ChevronUp size={12} className="ml-1 shrink-0" /> : <ChevronDown size={12} className="ml-1 shrink-0" />}
          </button>

          {showMultiAngle && (
            <div className="mt-1 rounded-xl border border-indigo-100 bg-indigo-50/60 p-2.5 space-y-2">
              <p className="text-[10px] text-indigo-600 leading-snug">
                Upload roof photos from different angles. AI extracts ridge, hip, valley, eave and rake cues to
                improve structure accuracy.
              </p>

              <div className="grid grid-cols-2 gap-1.5">
                {MULTI_ANGLE_SLOTS.map(slot => {
                  const capture = multiCaptures[slot.id];
                  const result  = multiResults[slot.id];
                  const analyzing = result?.status === 'analyzing';
                  const done      = result?.status === 'done' && result.result;
                  const error     = result?.status === 'error';
                  return (
                    <div key={slot.id} className="rounded-lg border border-indigo-100 bg-white p-1.5 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-600">{slot.label}</p>

                      {capture ? (
                        <img
                          src={capture.previewUrl}
                          alt={slot.label}
                          className="w-full h-14 object-cover rounded border border-slate-200"
                        />
                      ) : (
                        <label className="flex flex-col items-center justify-center w-full h-14 rounded border-2 border-dashed border-indigo-200 bg-indigo-50/50 cursor-pointer hover:bg-indigo-100 transition-colors">
                          <Camera size={16} className="text-indigo-300 mb-0.5" />
                          <span className="text-[9px] text-indigo-400">Upload</span>
                          <input
                            type="file"
                            accept="image/*"
                            className="sr-only"
                            onChange={e => handleMultiCapture(slot.id, e.target.files?.[0] ?? null)}
                          />
                        </label>
                      )}

                      <div className="flex items-center gap-1 flex-wrap">
                        {capture && (
                          <>
                            <label className="text-[10px] text-slate-500 cursor-pointer hover:text-indigo-600 border border-slate-200 rounded px-1.5 py-0.5">
                              Change
                              <input
                                type="file"
                                accept="image/*"
                                className="sr-only"
                                onChange={e => handleMultiCapture(slot.id, e.target.files?.[0] ?? null)}
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => analyzeMultiSlot(slot.id)}
                              disabled={analyzing}
                              className="text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 disabled:opacity-50"
                            >
                              {analyzing ? (
                                <Loader2 size={10} className="inline animate-spin" />
                              ) : 'Analyze'}
                            </button>
                          </>
                        )}
                        {done && (
                          <span className="ml-auto text-[10px] text-emerald-600 font-medium">
                            {result!.result!.cues.length}c · {Math.round(result!.result!.qualityScore * 100)}%
                          </span>
                        )}
                        {error && (
                          <span className="text-[10px] text-red-500 truncate" title={result?.error}>Err</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Summary + actions */}
              <div className="rounded-lg border border-indigo-100 bg-white px-2 py-1.5 text-[10px] text-slate-600 space-y-0.5">
                <p className="font-semibold text-slate-700">
                  {multiReadySlots}/{MULTI_ANGLE_SLOTS.length} quality angles · {multiTotalCues} total cues
                </p>
                {multiTotalCues > 0 && (
                  <p>
                    {Object.values(multiResults).filter(r => r?.status === 'done').map(r => r!.result!).reduce((s, r) => s + r.byType.ridge, 0)} ridge ·{' '}
                    {Object.values(multiResults).filter(r => r?.status === 'done').map(r => r!.result!).reduce((s, r) => s + r.byType.hip, 0)} hip ·{' '}
                    {Object.values(multiResults).filter(r => r?.status === 'done').map(r => r!.result!).reduce((s, r) => s + r.byType.valley, 0)} valley
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={analyzeAllMultiSlots}
                  disabled={multiCaptureCount === 0}
                  className="text-[10px] font-semibold text-indigo-700 border border-indigo-200 bg-white rounded px-2.5 py-1.5 hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Analyze All
                </button>
                {solarData && multiReadySlots >= 2 && (
                  <button
                    type="button"
                    onClick={applyMultiCuesToStructure}
                    className="text-[10px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 py-1.5 transition-colors"
                  >
                    Apply to Structure Analysis
                  </button>
                )}
                {!solarData && multiReadySlots >= 2 && (
                  <span className="text-[10px] text-indigo-500 italic">Waiting for Solar data to apply cues…</span>
                )}
                {solarData && multiReadySlots < 2 && multiCaptureCount > 0 && (
                  <span className="text-[10px] text-indigo-400">Analyze at least 2 angles to apply</span>
                )}
              </div>

              {roofAiCueStatus === 'ready' && multiReadySlots >= 2 && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-2 py-1 text-[10px] text-emerald-700">
                  Photo cues applied — structure analysis updated.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sections list */}
        <div className="space-y-2 p-3 pb-1">
          {sections.length === 0 && !isDrawing && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center mb-3">
                <Pencil size={20} className="text-blue-500" />
              </div>
              <p className="text-slate-700 font-medium text-sm mb-1">No sections yet</p>
              <p className="text-slate-400 text-xs leading-relaxed">
                Click "Draw Section" to start tracing the roof outline on the satellite map
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

        </>
        )}

        </div>

        {/* Primary actions — outside scroll region so Draw / Save stay visible without scrolling (mobile + desktop sidebar) */}
        {!hideQuickAnalysisSidebar && (
        <div className="shrink-0 border-t border-slate-200 bg-white p-2.5 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] shadow-[0_-6px_20px_-8px_rgba(15,23,42,0.12)] lg:p-3 lg:shadow-none">
          {!isDrawing ? (
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
        )}
      </aside>

      {showRoofStructure && roofStructure && (
        <RoofStructurePanel
          analysis={roofStructure}
          onApply={next => setRoofStructure(next)}
          onClose={() => setShowRoofStructure(false)}
        />
      )}

      <SaveProjectChoiceModal
        open={showSaveProjectModal}
        purpose="wizard"
        currentAddress={address}
        onCancel={() => {
          setShowSaveProjectModal(false);
          setOpenWizardAfterPropertySearch(false);
        }}
        onChooseNew={(folderName) => {
          setWizardAttach({ mode: 'new', newProjectName: folderName });
          setShowSaveProjectModal(false);
        }}
        onChooseExisting={(pid, displayTitle) => {
          setWizardAttach({ mode: 'existing', projectId: pid, existingDisplayName: displayTitle });
          setShowSaveProjectModal(false);
        }}
      />

      {showWizard && (
        <ErrorBoundary>
          <RoofMappingWizard
            apiKey={apiKey}
            address={address}
            coordinates={coordinates}
            solarData={solarData}
            solarDataLayers={solarDataLayers}
            existingProjectId={wizardAttach.projectId ?? null}
            forceNewProject={wizardAttach.mode === 'new'}
            initialProjectFolderName={wizardAttach.mode === 'new' ? (wizardAttach.newProjectName ?? null) : null}
            autoSegmentMode={startInAutoSegmentMode}
            onPersisted={(pid) => {
              setWizardAttach(prev => {
                if (prev.mode === 'new' && !prev.projectId) {
                  return { ...prev, projectId: pid };
                }
                return prev;
              });
              onWizardProjectPersisted?.(pid);
            }}
            onFolderManifestChange={setWizardFolderManifest}
            onSaveAndNew={onWizardSaveAndNew}
            onClose={() => {
              setShowWizard(false);
              setWizardAttach({ mode: 'inherit' });
              setWizardFolderManifest([]);
            }}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
