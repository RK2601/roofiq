import { useEffect, useRef, useState } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import { Coordinates } from '../types';
import { Search, MapPin, Zap, FileText, Shield, ArrowRight, Star, CheckCircle2, Settings } from 'lucide-react';

interface LandingPageProps {
  apiKey: string;
  onAddressSelect: (address: string, coords: Coordinates) => void;
  onNeedApiKey: () => void;
  onSignIn: () => void;
}

const features = [
  {
    icon: MapPin,
    title: 'Satellite Roof View',
    description: 'Pin any address and instantly see its roof from above using high-resolution satellite imagery.',
    color: 'bg-blue-50 text-blue-600',
  },
  {
    icon: Zap,
    title: 'Instant Measurements',
    description: 'Draw polygons directly on the map to measure roof sections with precision to the square foot.',
    color: 'bg-orange-50 text-orange-600',
  },
  {
    icon: FileText,
    title: 'Professional Quotes',
    description: 'Generate itemized material and labor estimates in seconds — ready to send to your customer.',
    color: 'bg-green-50 text-green-600',
  },
  {
    icon: Shield,
    title: 'Material Intelligence',
    description: 'Compare asphalt, metal, tile, and TPO roofing systems with realistic cost breakdowns.',
    color: 'bg-purple-50 text-purple-600',
  },
];

const stats = [
  { value: '10,000+', label: 'Roofs Analyzed' },
  { value: '< 5 min', label: 'Quote Generation' },
  { value: '±3%', label: 'Measurement Accuracy' },
  { value: '$2.4M', label: 'Quotes Generated' },
];

export default function LandingPage({ apiKey, onAddressSelect, onNeedApiKey, onSignIn }: LandingPageProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inputValue, setInputValue] = useState('');
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  useEffect(() => {
    if (!apiKey) return;

    const loader = new Loader({
      apiKey,
      version: 'weekly',
      libraries: ['places', 'drawing', 'geometry'],
    });

    loader.load().then(() => {
      if (!inputRef.current) return;

      autocompleteRef.current = new google.maps.places.Autocomplete(inputRef.current, {
        types: ['address'],
        fields: ['formatted_address', 'geometry'],
      });

      autocompleteRef.current.addListener('place_changed', () => {
        const place = autocompleteRef.current?.getPlace();
        if (!place?.geometry?.location) {
          setError('Could not find this address. Please try again.');
          return;
        }
        const coords: Coordinates = {
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng(),
        };
        onAddressSelect(place.formatted_address || inputRef.current?.value || '', coords);
      });
    }).catch(() => {
      setError('Failed to load Google Maps. Please check your API key.');
    });
  }, [apiKey]);

  const handleSearch = () => {
    if (!apiKey) {
      onNeedApiKey();
      return;
    }
    if (!inputValue.trim()) {
      setError('Please enter a property address.');
      return;
    }
    setError('Select an address from the dropdown suggestions.');
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav bar */}
      <nav className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white font-black text-xs">R</span>
          </div>
          <span className="text-white font-bold">RoofIQ</span>
        </div>
        <button
          onClick={onSignIn}
          className="flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-lg transition-all"
        >
          Sign In <ArrowRight size={14} />
        </button>
      </nav>

      {/* Hero */}
      <section className="relative flex-1 flex flex-col items-center justify-center px-4 py-24 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-blue-950">
        {/* Background grid */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `linear-gradient(rgba(148,163,184,0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(148,163,184,0.3) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }}
        />
        {/* Glow orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 text-center max-w-3xl mx-auto animate-fade-in">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-400/20 text-blue-300 text-sm font-medium px-4 py-1.5 rounded-full mb-6">
            <Star size={13} fill="currentColor" />
            Trusted by 500+ roofing professionals
          </div>

          <h1 className="text-5xl sm:text-6xl font-black text-white mb-5 leading-tight tracking-tight">
            Measure Any Roof
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
              From Anywhere.
            </span>
          </h1>

          <p className="text-slate-400 text-lg sm:text-xl mb-10 max-w-xl mx-auto leading-relaxed">
            Enter a property address, trace the roof on satellite imagery, and get a professional
            material & labor quote — in under 5 minutes.
          </p>

          {/* Search bar */}
          <div className="max-w-xl mx-auto w-full">
            <div className="relative flex items-center bg-white rounded-2xl shadow-2xl shadow-black/30 overflow-hidden border border-white/10">
              <MapPin size={18} className="absolute left-4 text-slate-400 pointer-events-none flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={e => { setInputValue(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Enter property address..."
                className="flex-1 pl-11 pr-4 py-4 text-slate-800 bg-transparent outline-none placeholder-slate-400 text-base font-medium"
              />
              <button
                onClick={handleSearch}
                className="m-2 flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-xl transition-all duration-200 text-sm whitespace-nowrap flex-shrink-0"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Search size={15} />
                )}
                Analyze Roof
              </button>
            </div>
            {error && (
              <p className="mt-3 text-orange-400 text-sm flex items-center gap-1.5 justify-center">
                <span>⚠</span> {error}
              </p>
            )}
            {apiKey ? (
              <p className="mt-3 text-slate-400 text-sm flex items-center justify-center gap-1.5">
                <CheckCircle2 size={13} className="text-green-400" />
                <span className="text-green-400 font-medium">API key saved</span>
                <button onClick={onNeedApiKey} className="ml-1 text-slate-500 hover:text-slate-300 flex items-center gap-0.5">
                  <Settings size={12} /> Change
                </button>
              </p>
            ) : (
              <p className="mt-3 text-slate-400 text-sm">
                No API key configured.{' '}
                <button onClick={onNeedApiKey} className="text-blue-400 underline hover:text-blue-300">
                  Set up Google Maps API key
                </button>
              </p>
            )}
          </div>

          {/* Sample addresses */}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <span className="text-slate-500 text-xs">Try:</span>
            {[
              '1600 Amphitheatre Pkwy, Mountain View, CA',
              '350 Fifth Ave, New York, NY',
              '1 Apple Park Way, Cupertino, CA',
            ].map(addr => (
              <button
                key={addr}
                onClick={() => {
                  if (inputRef.current) {
                    inputRef.current.value = addr;
                    setInputValue(addr);
                  }
                }}
                className="text-xs text-slate-400 hover:text-blue-400 transition-colors bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 py-1 rounded-full"
              >
                {addr.split(',')[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Stats bar */}
        <div className="relative z-10 mt-16 w-full max-w-3xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/10 rounded-2xl overflow-hidden border border-white/10">
            {stats.map(stat => (
              <div key={stat.label} className="bg-white/5 px-4 py-4 text-center">
                <div className="text-2xl font-black text-white">{stat.value}</div>
                <div className="text-xs text-slate-400 mt-0.5">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-white py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-slate-900 mb-3">
              Everything a roofing pro needs
            </h2>
            <p className="text-slate-500 text-lg max-w-xl mx-auto">
              From satellite measurement to customer-ready quotes — all in one workflow.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map(f => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="card p-6 hover:shadow-md transition-shadow duration-300 group">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${f.color}`}>
                    <Icon size={20} />
                  </div>
                  <h3 className="font-semibold text-slate-900 mb-2">{f.title}</h3>
                  <p className="text-slate-500 text-sm leading-relaxed">{f.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="bg-slate-50 py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-slate-900 mb-3">How it works</h2>
            <p className="text-slate-500 text-lg">Three steps to a professional roof quote</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-8">
            {[
              {
                step: '01',
                title: 'Enter Address',
                desc: 'Type the property address. Our system locates it on satellite imagery instantly.',
                color: 'text-blue-600 bg-blue-50',
              },
              {
                step: '02',
                title: 'Trace the Roof',
                desc: 'Draw polygons over each roof section. Areas are calculated automatically.',
                color: 'text-orange-600 bg-orange-50',
              },
              {
                step: '03',
                title: 'Generate Quote',
                desc: 'Select your material and get a full itemized estimate with labor and materials.',
                color: 'text-green-600 bg-green-50',
              },
            ].map((item, idx) => (
              <div key={item.step} className="relative flex flex-col items-center text-center">
                {idx < 2 && (
                  <div className="hidden sm:block absolute top-6 left-[calc(50%+32px)] right-0 h-px border-t-2 border-dashed border-slate-200" />
                )}
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg mb-4 ${item.color}`}>
                  {item.step}
                </div>
                <h3 className="font-semibold text-slate-900 mb-2">{item.title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 text-center">
            <button
              onClick={() => inputRef.current?.focus()}
              className="btn-primary"
            >
              Get Started Free
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-900 py-8 px-4 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className="w-6 h-6 bg-gradient-to-br from-blue-500 to-blue-400 rounded-md flex items-center justify-center">
            <span className="text-white font-black text-xs">R</span>
          </div>
          <span className="text-white font-bold">RoofIQ</span>
        </div>
        <p className="text-slate-500 text-sm">© 2026 RoofIQ · Professional Roofing Analysis Platform</p>
      </footer>
    </div>
  );
}
