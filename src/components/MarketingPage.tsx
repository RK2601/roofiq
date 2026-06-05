import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import {
  Target, Search, Loader2, AlertTriangle, Trash2,
  PlusCircle, MinusCircle, Download, MapPin, Megaphone,
} from 'lucide-react';
import { analyzeRoofImage, RoofAnalysis, CONDITION_COLORS, CONDITION_BG, URGENCY_BG } from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';
import {
  loadMarketingProspects,
  persistMarketingProspects,
  type MarketingProspectStored,
} from '../utils/marketingPersistence';

interface MarketingPageProps {
  apiKey: string;
}

type Prospect = MarketingProspectStored;

const CONDITION_HEX: Record<string, string> = {
  Excellent: '22c55e',
  Good:      '84cc16',
  Fair:      'f59e0b',
  Poor:      'ef4444',
  Critical:  '991b1b',
};

function markerIconForProspect(
  maps: typeof google.maps,
  p: Prospect
): google.maps.Symbol {
  let fillColor = '#94a3b8';
  if (p.status === 'done' && p.analysis) {
    fillColor = `#${CONDITION_HEX[p.analysis.condition] ?? '94a3b8'}`;
  } else if (p.status === 'error') {
    fillColor = '#64748b';
  }
  return {
    path: maps.SymbolPath.CIRCLE,
    scale: 10,
    fillColor,
    fillOpacity: p.status === 'error' ? 0.8 : 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
  };
}

export default function MarketingPage({ apiKey }: MarketingPageProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const googleRef = useRef<typeof google.maps | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const prospectsRef = useRef<Prospect[]>([]);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'prospects' | 'campaign'>('prospects');
  const [mapError, setMapError] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const geminiKeyMissing = !readGeminiApiKey();

  prospectsRef.current = prospects;

  const runAnalysis = useCallback((id: string, snapshotUrl: string) => {
    const maps = googleRef.current;
    const marker = markersRef.current.get(id);
    analyzeRoofImage(snapshotUrl)
      .then(analysis => {
        if (maps && marker) {
          const hex = CONDITION_HEX[analysis.condition] ?? '94a3b8';
          marker.setIcon({
            path: maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: `#${hex}`,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          });
          marker.setTitle(`${analysis.condition} — ${analysis.urgency} urgency`);
        }
        setProspects(prev => prev.map(p =>
          p.id === id ? { ...p, status: 'done', analysis } : p
        ));
      })
      .catch(err => {
        if (maps && marker) {
          marker.setIcon({
            path: maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: '#64748b',
            fillOpacity: 0.8,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          });
        }
        setProspects(prev => prev.map(p =>
          p.id === id ? { ...p, status: 'error', error: err instanceof Error ? err.message : 'Analysis failed' } : p
        ));
      });
  }, []);

  const upsertMarker = useCallback((p: Prospect) => {
    const map = mapInstanceRef.current;
    const maps = googleRef.current;
    if (!map || !maps) return;

    let marker = markersRef.current.get(p.id);
    if (!marker) {
      marker = new maps.Marker({
        position: p.latlng,
        map,
        icon: markerIconForProspect(maps, p),
        title: p.status === 'done' && p.analysis
          ? `${p.analysis.condition} — ${p.analysis.urgency} urgency`
          : p.status === 'analyzing'
            ? 'Analyzing…'
            : p.address,
      });
      markersRef.current.set(p.id, marker);
    } else {
      marker.setPosition(p.latlng);
      marker.setMap(map);
      marker.setIcon(markerIconForProspect(maps, p));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadMarketingProspects()
      .then(rows => {
        if (!cancelled) {
          setProspects(rows);
          setHydrated(true);
        }
      })
      .catch(err => {
        console.error('[RoofIQ] marketing load', err);
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      void persistMarketingProspects(prospectsRef.current)
        .then(() => setSaveError(null))
        .catch(() => setSaveError('Could not save prospects. Check your database connection.'));
    }, 400);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [prospects, hydrated]);

  useEffect(() => {
    if (!apiKey) {
      setMapError('Map is not available. Add your Maps key in Settings or configure it for this app.');
      return;
    }

    const loader = new Loader({
      apiKey,
      version: '3.64',
      libraries: ['places', 'drawing', 'geometry'],
    });

    loader.load().then((google) => {
      if (!mapRef.current) return;

      googleRef.current = google.maps;
      const map = new google.maps.Map(mapRef.current, {
        center: { lat: 37.7749, lng: -122.4194 },
        zoom: 19,
        mapTypeId: 'satellite',
        tilt: 0,
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControl: false,
        gestureHandling: 'greedy',
        zoomControlOptions: {
          position: google.maps.ControlPosition.RIGHT_CENTER,
        },
      });

      mapInstanceRef.current = map;
      geocoderRef.current = new google.maps.Geocoder();
      setMapReady(true);

      const input = document.getElementById('mkt-search') as HTMLInputElement | null;
      if (input) {
        const ac = new google.maps.places.Autocomplete(input, { types: ['geocode'] });
        ac.addListener('place_changed', () => {
          const place = ac.getPlace();
          if (place.geometry?.location) {
            map.setCenter(place.geometry.location);
            map.setZoom(19);
          }
        });
      }

      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const latLng = e.latLng;
        const latlng = { lat: latLng.lat(), lng: latLng.lng() };
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const snapshotUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${latlng.lat},${latlng.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;

        const marker = new google.maps.Marker({
          position: latLng,
          map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: '#94a3b8',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
          title: 'Analyzing…',
        });
        markersRef.current.set(id, marker);

        const pending: Prospect = {
          id,
          latlng,
          address: `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`,
          snapshot_url: snapshotUrl,
          status: 'analyzing',
          analysis: null,
          inCampaign: false,
        };
        setProspects(prev => [pending, ...prev]);

        geocoderRef.current?.geocode({ location: latLng }, (results, status) => {
          if (status === 'OK' && results?.[0]) {
            const addr = results[0].formatted_address;
            setProspects(prev => prev.map(p => p.id === id ? { ...p, address: addr } : p));
          }
        });

        runAnalysis(id, snapshotUrl);
      });
    }).catch(() => setMapError('Failed to load Google Maps.'));

    return () => {
      setMapReady(false);
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current.clear();
      mapInstanceRef.current = null;
      googleRef.current = null;
    };
  }, [apiKey, runAnalysis]);

  useEffect(() => {
    if (!mapReady || !hydrated) return;
    const currentIds = new Set(prospects.map(p => p.id));
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.setMap(null);
        markersRef.current.delete(id);
      }
    });
    for (const p of prospects) {
      upsertMarker(p);
    }
  }, [prospects, mapReady, hydrated, upsertMarker]);

  useEffect(() => {
    if (!hydrated || !mapReady || geminiKeyMissing) return;
    for (const p of prospects) {
      if (p.status === 'analyzing') {
        runAnalysis(p.id, p.snapshot_url);
      }
    }
    // Only resume stuck analyses once when map becomes ready after load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, mapReady]);

  const removeProspect = (id: string) => {
    markersRef.current.get(id)?.setMap(null);
    markersRef.current.delete(id);
    setProspects(prev => prev.filter(p => p.id !== id));
  };

  const toggleCampaign = (id: string) => {
    setProspects(prev => prev.map(p =>
      p.id === id ? { ...p, inCampaign: !p.inCampaign } : p
    ));
  };

  const exportCsv = () => {
    const rows = prospects.filter(p => p.inCampaign && p.analysis);
    const header = 'Address,Condition,Score,Urgency,Est. Life,Recommendation,Marketing Message';
    const lines = rows.map(p => {
      const a = p.analysis!;
      return [p.address, a.condition, a.condition_score, a.urgency, a.estimated_remaining_life, `"${a.recommendation}"`, `"${a.marketing_message}"`].join(',');
    });
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'roofiq-campaign.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const campaignProspects = prospects.filter(p => p.inCampaign);
  const doneProspects = prospects.filter(p => p.status === 'done');

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row overflow-hidden">
      {/* Map area — top portion on phone, full flex on desktop */}
      <div className="relative w-full h-[38%] min-h-[200px] max-h-[45dvh] shrink-0 lg:h-auto lg:max-h-none lg:flex-1 lg:min-h-0">
        {/* Search overlay */}
        <div className="absolute top-[max(0.5rem,env(safe-area-inset-top,0px))] left-2 right-2 z-10 lg:top-4 lg:left-1/2 lg:right-auto lg:-translate-x-1/2 lg:w-full lg:max-w-md lg:px-4">
          <div className="flex items-center gap-2 bg-white rounded-xl shadow-lg border border-slate-200 px-3 py-2 min-h-[48px]">
            <Search size={18} className="text-slate-400 shrink-0" aria-hidden />
            <input
              id="mkt-search"
              type="text"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="street-address"
              placeholder="Search area or address…"
              className="flex-1 min-w-0 text-base lg:text-sm text-slate-800 placeholder-slate-400 outline-none bg-transparent"
            />
          </div>
        </div>

        {/* Instructions overlay */}
        {prospects.length === 0 && !mapError && hydrated && (
          <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-2 right-2 z-10 lg:bottom-6 lg:left-1/2 lg:right-auto lg:-translate-x-1/2 lg:max-w-lg">
            <div className="bg-slate-900/90 backdrop-blur-sm text-white text-xs sm:text-sm px-3 py-2.5 sm:px-4 sm:py-3 rounded-xl flex items-start gap-2 leading-snug shadow-lg">
              <Target size={16} className="text-blue-400 shrink-0 mt-0.5" aria-hidden />
              <span>
                <span className="lg:hidden">Tap a rooftop on the map to run AI analysis.</span>
                <span className="hidden lg:inline">Click any rooftop on the map to start AI analysis.</span>
              </span>
            </div>
          </div>
        )}

        {/* Map */}
        {mapError ? (
          <div className="h-full flex items-center justify-center bg-slate-100">
            <div className="text-center">
              <AlertTriangle size={40} className="text-amber-400 mx-auto mb-3" />
              <p className="text-slate-600 font-medium">{mapError}</p>
            </div>
          </div>
        ) : (
          <div ref={mapRef} className="w-full h-full min-h-[200px] touch-manipulation" />
        )}
      </div>

      {/* Panel — full width under map on phone */}
      <div className="flex w-full flex-1 min-h-0 max-h-[62%] lg:max-h-none lg:w-96 lg:flex-none flex-col bg-white border-t border-slate-200 lg:border-l lg:border-t-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] lg:shadow-none">
        {/* Panel header */}
        <div className="px-3 sm:px-4 py-3 sm:py-4 border-b border-slate-200 shrink-0 bg-white z-[1]">
          <div className="flex items-center gap-2 mb-2 sm:mb-3">
            <Megaphone size={18} className="text-blue-600 shrink-0" aria-hidden />
            <h2 className="font-bold text-slate-900 text-[15px] sm:text-base leading-tight">Marketing Intelligence</h2>
          </div>

          {geminiKeyMissing && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs sm:text-sm text-amber-900 mb-3 leading-relaxed">
              <strong className="font-semibold">AI key missing.</strong>{' '}
              Open <strong className="font-semibold">Settings</strong> and add your Gemini key to enable roof analysis.
            </div>
          )}

          {saveError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs sm:text-sm text-red-800 mb-3 leading-relaxed">
              {saveError}
            </div>
          )}

          {/* Tabs */}
          <div className="flex rounded-xl bg-slate-100 p-1 gap-1">
            {(['prospects', 'campaign'] as const).map(tab => (
              <button
                type="button"
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`touch-manipulation flex-1 min-h-[44px] sm:min-h-[40px] px-1.5 rounded-lg text-[11px] sm:text-xs font-semibold capitalize transition-colors leading-tight ${
                  activeTab === tab
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 active:bg-slate-200/50'
                }`}
              >
                {tab === 'prospects' ? (
                  <span className="block text-center">
                    Prospects
                    <span className="block text-[10px] font-bold text-slate-500 tabular-nums mt-0.5">{prospects.length}</span>
                  </span>
                ) : (
                  <span className="block text-center">
                    Campaign
                    <span className="block text-[10px] font-bold text-slate-500 tabular-nums mt-0.5">{campaignProspects.length}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Panel body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
          {!hydrated ? (
            <div className="flex flex-col items-center justify-center min-h-[12rem] py-10 px-4 text-center text-slate-500 text-sm">
              <Loader2 size={28} className="animate-spin mb-3 text-blue-600" aria-hidden />
              Loading saved prospects…
            </div>
          ) : activeTab === 'prospects' ? (
            prospects.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[12rem] py-10 px-4 text-center">
                <MapPin size={40} className="text-slate-200 mb-3" aria-hidden />
                <p className="text-slate-500 text-sm font-medium">No prospects yet</p>
                <p className="text-slate-400 text-xs mt-2 leading-relaxed max-w-xs">
                  Tap rooftops on the map above to analyze them.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {prospects.map(p => (
                  <ProspectCard
                    key={p.id}
                    prospect={p}
                    onRemove={() => removeProspect(p.id)}
                    onToggleCampaign={() => toggleCampaign(p.id)}
                  />
                ))}
              </div>
            )
          ) : (
            campaignProspects.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[12rem] py-10 px-4 text-center">
                <Megaphone size={36} className="text-slate-200 mb-3" aria-hidden />
                <p className="text-slate-500 text-sm font-medium">No campaign targets yet</p>
                <p className="text-slate-400 text-xs mt-2 leading-relaxed max-w-xs">
                  Use <strong className="font-medium text-slate-500">Add to Campaign</strong> on analyzed prospects.
                </p>
              </div>
            ) : (
              <div>
                <div className="px-3 sm:px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-slate-600 font-medium">
                    {campaignProspects.length} target{campaignProspects.length !== 1 ? 's' : ''}
                  </p>
                  <button
                    type="button"
                    onClick={exportCsv}
                    className="touch-manipulation inline-flex w-full sm:w-auto items-center justify-center gap-2 min-h-[44px] text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 active:bg-blue-100 px-4 rounded-xl transition-colors"
                  >
                    <Download size={16} aria-hidden />
                    Export CSV
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {campaignProspects.map(p => (
                    <CampaignCard
                      key={p.id}
                      prospect={p}
                      onRemove={() => toggleCampaign(p.id)}
                    />
                  ))}
                </div>
              </div>
            )
          )}
        </div>

        {/* Footer stats */}
        {doneProspects.length > 0 && (
          <div className="px-3 sm:px-4 py-3 border-t border-slate-200 bg-slate-50 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] lg:pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-slate-600">
              <span className="font-medium">{doneProspects.length} analyzed</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {(['Poor', 'Critical'] as const).map(c => {
                  const count = doneProspects.filter(p => p.analysis?.condition === c).length;
                  return count > 0 ? (
                    <span key={c} className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: CONDITION_COLORS[c] }} />
                      <span className="tabular-nums">{count}</span> {c}
                    </span>
                  ) : null;
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProspectCard({
  prospect: p,
  onRemove,
  onToggleCampaign,
}: {
  prospect: Prospect;
  onRemove: () => void;
  onToggleCampaign: () => void;
}) {
  return (
    <div className="p-3 sm:p-4">
      {/* Thumbnail + address row */}
      <div className="flex gap-3 mb-3">
        <img
          src={p.snapshot_url}
          alt=""
          className="w-20 h-14 sm:w-16 sm:h-12 rounded-lg object-cover border border-slate-200 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-800 leading-snug line-clamp-3 sm:line-clamp-2">{p.address}</p>
          {p.status === 'analyzing' && (
            <div className="flex items-center gap-1.5 mt-1.5 text-xs text-blue-600">
              <Loader2 size={14} className="animate-spin shrink-0" aria-hidden />
              Analyzing roof…
            </div>
          )}
          {p.status === 'error' && (
            <div className="flex items-start gap-1.5 mt-1.5 text-xs text-red-600 leading-snug">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden />
              <span>{p.error === 'GOOGLE_AI_KEY_MISSING' ? 'AI key not configured' : 'Analysis failed'}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="touch-manipulation shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors -mr-1"
          aria-label="Remove prospect"
        >
          <Trash2 size={18} aria-hidden />
        </button>
      </div>

      {p.status === 'done' && p.analysis && (
        <>
          {/* Condition + urgency badges */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className={`text-xs font-bold px-2 py-1 rounded-full ${CONDITION_BG[p.analysis.condition]}`}>
              {p.analysis.condition}
            </span>
            <span className={`text-xs font-medium px-2 py-1 rounded-full ${URGENCY_BG[p.analysis.urgency]}`}>
              {p.analysis.urgency} urgency
            </span>
            <span className="text-xs text-slate-500 font-semibold tabular-nums sm:ml-auto">{p.analysis.condition_score}/10</span>
          </div>

          {/* Score bar */}
          <div className="w-full h-1.5 bg-slate-100 rounded-full mb-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${p.analysis.condition_score * 10}%`,
                backgroundColor: CONDITION_COLORS[p.analysis.condition],
              }}
            />
          </div>

          {/* Est. life */}
          <p className="text-xs text-slate-500 mb-2">
            <span className="font-medium text-slate-600">Est. life:</span> {p.analysis.estimated_remaining_life}
          </p>

          {/* Issues */}
          {p.analysis.issues.length > 0 && (
            <ul className="text-xs text-slate-500 space-y-0.5 mb-2">
              {p.analysis.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1">
                  <span className="text-amber-400 mt-0.5">•</span>
                  {issue}
                </li>
              ))}
            </ul>
          )}

          {/* Marketing message */}
          <p className="text-xs text-slate-600 italic bg-blue-50 rounded-lg px-3 py-2 mb-3 leading-relaxed">
            "{p.analysis.marketing_message}"
          </p>

          {/* Campaign button */}
          <button
            type="button"
            onClick={onToggleCampaign}
            className={`touch-manipulation w-full flex items-center justify-center gap-2 text-xs font-semibold min-h-[48px] rounded-xl transition-colors ${
              p.inCampaign
                ? 'bg-green-50 text-green-800 hover:bg-red-50 hover:text-red-700 active:bg-red-100'
                : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
            }`}
          >
            {p.inCampaign ? (
              <><MinusCircle size={16} aria-hidden /> Remove from campaign</>
            ) : (
              <><PlusCircle size={16} aria-hidden /> Add to campaign</>
            )}
          </button>
        </>
      )}
    </div>
  );
}

function CampaignCard({ prospect: p, onRemove }: { prospect: Prospect; onRemove: () => void }) {
  const a = p.analysis;
  return (
    <div className="px-3 sm:px-4 py-3">
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-slate-800 line-clamp-2 leading-snug">{p.address}</p>
          {a && (
            <span className={`inline-block mt-2 text-xs font-bold px-2 py-0.5 rounded-full ${CONDITION_BG[a.condition]}`}>
              {a.condition}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="touch-manipulation shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition-colors -mr-1"
          aria-label="Remove from campaign"
        >
          <MinusCircle size={18} aria-hidden />
        </button>
      </div>
      {a && (
        <p className="text-xs text-slate-600 italic leading-relaxed pl-0.5 border-l-2 border-blue-200 pl-2.5">&ldquo;{a.marketing_message}&rdquo;</p>
      )}
    </div>
  );
}
