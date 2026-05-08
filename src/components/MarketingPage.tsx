import { useEffect, useRef, useState } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import {
  Target, Search, Loader2, AlertTriangle, Trash2,
  PlusCircle, MinusCircle, Download, MapPin, Megaphone,
} from 'lucide-react';
import { analyzeRoofImage, RoofAnalysis, CONDITION_COLORS, CONDITION_BG, URGENCY_BG } from '../utils/ai';

interface MarketingPageProps {
  apiKey: string;
}

interface Prospect {
  id: string;
  latlng: { lat: number; lng: number };
  address: string;
  snapshot_url: string;
  status: 'analyzing' | 'done' | 'error';
  analysis: RoofAnalysis | null;
  error?: string;
  inCampaign: boolean;
}

const CONDITION_HEX: Record<string, string> = {
  Excellent: '22c55e',
  Good:      '84cc16',
  Fair:      'f59e0b',
  Poor:      'ef4444',
  Critical:  '991b1b',
};

export default function MarketingPage({ apiKey }: MarketingPageProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [activeTab, setActiveTab] = useState<'prospects' | 'campaign'>('prospects');
  const [mapError, setMapError] = useState('');
  const anthropicKeyMissing = !(import.meta.env.VITE_GOOGLE_AI_KEY || localStorage.getItem('roofiq_gemini_key'));

  useEffect(() => {
    if (!apiKey) {
      setMapError('Google Maps API key is required.');
      return;
    }

    const loader = new Loader({
      apiKey,
      version: 'weekly',
      libraries: ['places', 'drawing', 'geometry'],
    });

    loader.load().then((google) => {
      if (!mapRef.current) return;

      const map = new google.maps.Map(mapRef.current, {
        center: { lat: 37.7749, lng: -122.4194 },
        zoom: 19,
        mapTypeId: 'satellite',
        tilt: 0,
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControl: false,
        zoomControlOptions: {
          position: google.maps.ControlPosition.RIGHT_CENTER,
        },
      });

      mapInstanceRef.current = map;
      geocoderRef.current = new google.maps.Geocoder();

      // Search autocomplete
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

      // Map click → add prospect
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const latLng = e.latLng;
        const latlng = { lat: latLng.lat(), lng: latLng.lng() };
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const snapshotUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${latlng.lat},${latlng.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${apiKey}`;

        // Pending marker
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

        // Reverse geocode
        geocoderRef.current?.geocode({ location: latLng }, (results, status) => {
          if (status === 'OK' && results?.[0]) {
            const addr = results[0].formatted_address;
            setProspects(prev => prev.map(p => p.id === id ? { ...p, address: addr } : p));
          }
        });

        // AI analysis
        analyzeRoofImage(snapshotUrl)
          .then(analysis => {
            const hex = CONDITION_HEX[analysis.condition] ?? '94a3b8';
            marker.setIcon({
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: `#${hex}`,
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            });
            marker.setTitle(`${analysis.condition} — ${analysis.urgency} urgency`);
            setProspects(prev => prev.map(p =>
              p.id === id ? { ...p, status: 'done', analysis } : p
            ));
          })
          .catch(err => {
            marker.setIcon({
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: '#64748b',
              fillOpacity: 0.8,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            });
            setProspects(prev => prev.map(p =>
              p.id === id ? { ...p, status: 'error', error: err.message } : p
            ));
          });
      });
    }).catch(() => setMapError('Failed to load Google Maps.'));

    return () => {
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current.clear();
    };
  }, [apiKey]);

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
    <div className="flex h-full overflow-hidden">
      {/* Map area */}
      <div className="flex-1 relative">
        {/* Search overlay */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 w-full max-w-md px-4">
          <div className="flex items-center gap-2 bg-white rounded-xl shadow-lg border border-slate-200 px-3 py-2.5">
            <Search size={16} className="text-slate-400 flex-shrink-0" />
            <input
              id="mkt-search"
              type="text"
              placeholder="Search a neighborhood or address…"
              className="flex-1 text-sm text-slate-800 placeholder-slate-400 outline-none bg-transparent"
            />
          </div>
        </div>

        {/* Instructions overlay */}
        {prospects.length === 0 && !mapError && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
            <div className="bg-slate-900/80 backdrop-blur-sm text-white text-sm px-4 py-2.5 rounded-xl flex items-center gap-2">
              <Target size={15} className="text-blue-400 flex-shrink-0" />
              Click any rooftop on the map to start AI analysis
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
          <div ref={mapRef} className="w-full h-full" />
        )}
      </div>

      {/* Right panel */}
      <div className="w-96 flex flex-col bg-white border-l border-slate-200 flex-shrink-0">
        {/* Panel header */}
        <div className="px-4 py-4 border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <Megaphone size={16} className="text-blue-600" />
            <h2 className="font-bold text-slate-900 text-base">Marketing Intelligence</h2>
          </div>

          {anthropicKeyMissing && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 mb-3">
              <strong>AI key missing.</strong> Go to <strong>Settings → Gemini AI Key</strong> to add your free Google AI key and enable roof analysis.
            </div>
          )}

          {/* Tabs */}
          <div className="flex rounded-lg bg-slate-100 p-0.5 gap-0.5">
            {(['prospects', 'campaign'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-1.5 rounded-md text-xs font-semibold capitalize transition-colors ${
                  activeTab === tab
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab === 'prospects' ? `Prospects (${prospects.length})` : `Campaign (${campaignProspects.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Panel body */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'prospects' ? (
            prospects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
                <MapPin size={40} className="text-slate-200 mb-3" />
                <p className="text-slate-400 text-sm font-medium">No prospects yet</p>
                <p className="text-slate-400 text-xs mt-1">Click rooftops on the map to analyze them</p>
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
              <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
                <Megaphone size={40} className="text-slate-200 mb-3" />
                <p className="text-slate-400 text-sm font-medium">No campaign targets yet</p>
                <p className="text-slate-400 text-xs mt-1">Click "Add to Campaign" on analyzed prospects</p>
              </div>
            ) : (
              <div>
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <p className="text-xs text-slate-500 font-medium">{campaignProspects.length} target{campaignProspects.length !== 1 ? 's' : ''}</p>
                  <button
                    onClick={exportCsv}
                    className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    <Download size={12} />
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
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex-shrink-0">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{doneProspects.length} analyzed</span>
              <div className="flex items-center gap-2">
                {(['Poor', 'Critical'] as const).map(c => {
                  const count = doneProspects.filter(p => p.analysis?.condition === c).length;
                  return count > 0 ? (
                    <span key={c} className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: CONDITION_COLORS[c] }} />
                      {count} {c}
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
    <div className="p-4">
      {/* Thumbnail + address row */}
      <div className="flex gap-3 mb-3">
        <img
          src={p.snapshot_url}
          alt={p.address}
          className="w-16 h-12 rounded-lg object-cover border border-slate-200 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-700 leading-snug line-clamp-2">{p.address}</p>
          {p.status === 'analyzing' && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-blue-500">
              <Loader2 size={11} className="animate-spin" />
              Analyzing roof…
            </div>
          )}
          {p.status === 'error' && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-red-500">
              <AlertTriangle size={11} />
              {p.error === 'GOOGLE_AI_KEY_MISSING' ? 'AI key not configured' : 'Analysis failed'}
            </div>
          )}
        </div>
        <button onClick={onRemove} className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0">
          <Trash2 size={14} />
        </button>
      </div>

      {p.status === 'done' && p.analysis && (
        <>
          {/* Condition + urgency badges */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${CONDITION_BG[p.analysis.condition]}`}>
              {p.analysis.condition}
            </span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${URGENCY_BG[p.analysis.urgency]}`}>
              {p.analysis.urgency} urgency
            </span>
            <span className="ml-auto text-xs text-slate-400">{p.analysis.condition_score}/10</span>
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
            onClick={onToggleCampaign}
            className={`w-full flex items-center justify-center gap-1.5 text-xs font-semibold py-1.5 rounded-lg transition-colors ${
              p.inCampaign
                ? 'bg-green-50 text-green-700 hover:bg-red-50 hover:text-red-600'
                : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
            }`}
          >
            {p.inCampaign ? (
              <><MinusCircle size={12} /> Remove from Campaign</>
            ) : (
              <><PlusCircle size={12} /> Add to Campaign</>
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
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-xs font-semibold text-slate-700 line-clamp-1 flex-1">{p.address}</p>
        {a && (
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${CONDITION_BG[a.condition]}`}>
            {a.condition}
          </span>
        )}
        <button onClick={onRemove} className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0">
          <MinusCircle size={13} />
        </button>
      </div>
      {a && (
        <p className="text-xs text-slate-500 italic leading-relaxed">"{a.marketing_message}"</p>
      )}
    </div>
  );
}
