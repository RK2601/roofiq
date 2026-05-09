import { useEffect, useRef, useState, useCallback } from 'react';
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
} from 'lucide-react';
import { saveProject } from '../utils/db';
import { analyzeRoofImage, RoofAnalysis, CONDITION_BG, URGENCY_BG, CONDITION_COLORS } from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';

interface AnalysisPageProps {
  apiKey: string;
  address: string;
  coordinates: Coordinates;
  onComplete: (sections: Omit<RoofSection, 'polygon'>[], projectId: string | null) => void;
}

export default function AnalysisPage({ apiKey, address, coordinates, onComplete }: AnalysisPageProps) {
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
  const [aiExpanded, setAiExpanded] = useState(true);
  const hasGeminiKey = !!readGeminiApiKey();
  const labelsRef = useRef<google.maps.InfoWindow[]>([]);

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

    const loader = new Loader({
      apiKey,
      version: 'weekly',
      libraries: ['places', 'drawing', 'geometry'],
    });

    loader.load().then(() => {
      if (!mapRef.current) return;
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
        setMapError('Failed to initialize map. Please verify your API key and enabled APIs.');
      }
    }).catch(() => {
      setMapError('Failed to load Google Maps. Please verify your API key.');
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, coordinates.lat, coordinates.lng]);

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

  const analyzeWithAI = async () => {
    setAiStatus('analyzing');
    setAiResult(null);
    setAiExpanded(true);
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;
    try {
      const result = await analyzeRoofImage(url);
      setAiResult(result);
      setAiStatus('done');
    } catch {
      setAiStatus('error');
    }
  };

  const handleComplete = async () => {
    const exportSections = sections.map(({ polygon: _p, ...rest }) => rest);
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
      projectId = await saveProject(address, coordinates, snapshots, sectionsToSave);
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
    <div className="flex h-full overflow-hidden">
      {/* Map area */}
      <div className="relative flex-1">
        <div ref={mapRef} className="w-full h-full" />

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
          <div className="absolute top-3 left-3 flex gap-2 z-10">
            <button
              onClick={centerOnProperty}
              title="Center on property"
              className="flex items-center gap-1.5 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium px-3 py-2 rounded-xl shadow-md border border-slate-200 transition-all"
            >
              <Maximize2 size={13} />
              Re-center
            </button>
            <button
              onClick={() => setTilt(t => !t)}
              title="Toggle 3D tilt"
              className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl shadow-md border transition-all ${
                tilt
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200'
              }`}
            >
              <Satellite size={13} />
              3D View
            </button>
            <button
              onClick={() => setShowLabels(l => !l)}
              title="Toggle labels"
              className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl shadow-md border transition-all ${
                showLabels
                  ? 'bg-white text-slate-700 border-slate-200'
                  : 'bg-slate-700 text-white border-slate-700'
              }`}
            >
              {showLabels ? <Eye size={13} /> : <EyeOff size={13} />}
              Labels
            </button>
          </div>
        )}

        {/* Drawing hint */}
        {isDrawing && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
            <div className="bg-slate-900/90 text-white text-sm font-medium px-4 py-2.5 rounded-2xl shadow-xl flex items-center gap-2 backdrop-blur">
              <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
              Click to add points · Double-click to close polygon
              <button
                onClick={cancelDrawing}
                className="ml-3 text-slate-400 hover:text-white text-xs border-l border-slate-600 pl-3"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="w-80 bg-white border-l border-slate-100 flex flex-col overflow-hidden shadow-xl">
        {/* Sidebar header */}
        <div className="p-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2 mb-1">
            <Layers size={15} className="text-blue-600" />
            <h2 className="font-semibold text-slate-900 text-sm">Roof Sections</h2>
            {sections.length > 0 && (
              <span className="ml-auto bg-blue-100 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                {sections.length}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">Draw polygons on the map to measure each roof section</p>
        </div>

        {/* Sections list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
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

        {/* Totals */}
        {sections.length > 0 && (
          <div className="border-t border-slate-100 p-3 bg-slate-50 space-y-2">
            <div className="flex items-center gap-1.5 mb-2">
              <Ruler size={13} className="text-slate-400" />
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Totals</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { label: 'Plan Area', value: formatArea(totalFlat) },
                { label: 'Roof Area', value: formatArea(totalActual) },
                { label: 'Squares (est.)', value: `${totalSquares} sq` },
              ].map(item => (
                <div key={item.label} className="bg-white rounded-lg p-2 border border-slate-100 text-center">
                  <div className="text-[10px] text-slate-400 leading-none mb-1">{item.label}</div>
                  <div className="text-xs font-bold text-slate-900">{item.value}</div>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-1.5 bg-blue-50 rounded-lg p-2 text-xs text-blue-700">
              <Info size={11} className="mt-0.5 flex-shrink-0" />
              <span>Includes 12% waste factor for ordering</span>
            </div>
          </div>
        )}

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
                  {aiExpanded ? <ChevronUp size={12} /> : <Brain size={12} />}
                </span>
              )}
            </button>

            {aiExpanded && (
              <div className="px-3 py-2.5 bg-purple-50/50 space-y-2">
                {aiStatus === 'idle' && (
                  <button
                    onClick={analyzeWithAI}
                    disabled={!hasGeminiKey}
                    className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                    title={!hasGeminiKey ? 'Add your Gemini key in Settings to enable AI' : ''}
                  >
                    <Brain size={13} />
                    Run AI Analysis
                  </button>
                )}
                {aiStatus === 'analyzing' && (
                  <div className="flex items-center justify-center gap-2 text-xs text-purple-600 py-2">
                    <Loader2 size={13} className="animate-spin" />
                    Analyzing roof condition…
                  </div>
                )}
                {aiStatus === 'error' && (
                  <div className="text-xs text-red-500 text-center py-1">
                    Analysis failed. Check your API key.
                    <button onClick={analyzeWithAI} className="block mx-auto mt-1 underline">Retry</button>
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
                    <button onClick={analyzeWithAI} className="text-purple-500 hover:text-purple-700 text-[10px] underline">Re-analyze</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="p-3 border-t border-slate-100 space-y-2">
          {!isDrawing ? (
            <button
              onClick={startDrawing}
              disabled={!mapLoaded}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold px-4 py-2.5 rounded-xl transition-all text-sm shadow-sm"
            >
              <Pencil size={14} />
              Draw Roof Section
            </button>
          ) : (
            <button
              onClick={cancelDrawing}
              className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-2.5 rounded-xl transition-all text-sm"
            >
              <RotateCcw size={14} />
              Cancel Drawing
            </button>
          )}

          <button
            onClick={handleComplete}
            disabled={sections.length === 0 || saving}
            className="w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400 text-white font-semibold px-4 py-2.5 rounded-xl transition-all text-sm"
          >
            {saving ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : saveStatus === 'saved' ? (
              <>
                <CheckCircle2 size={14} />
                Saved · Generate Quote
              </>
            ) : (
              <>
                <Save size={14} />
                Save & Quote
                <ArrowRight size={14} />
              </>
            )}
          </button>
          {saveStatus === 'error' && (
            <p className="text-xs text-red-500 text-center">Saved locally — DB save failed</p>
          )}
        </div>
      </aside>
    </div>
  );
}
