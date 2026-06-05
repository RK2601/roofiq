import { useEffect, useRef, useState } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import { Coordinates } from '../types';
import { Search, MapPin, Zap, FileText, Shield, ArrowRight, Star } from 'lucide-react';

interface LandingPageProps {
  /** Maps key from env or storage — never shown on this page. */
  apiKey: string;
  onAddressSelect: (address: string, coords: Coordinates) => void;
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

export default function LandingPage({ apiKey, onAddressSelect, onSignIn }: LandingPageProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [inputValue, setInputValue] = useState('');
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  useEffect(() => {
    if (!apiKey) return;

    const loader = new Loader({
      apiKey,
      version: '3.64',
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
      setError('Address search could not load. Try again in a moment or refresh the page.');
    });
  }, [apiKey]);

  const handleSearch = () => {
    if (!apiKey) {
      onSignIn();
      return;
    }
    if (!inputValue.trim()) {
      setError('Please enter a property address.');
      return;
    }
    setError('Choose an address from the suggestions list.');
  };

  return (
    <div className="min-h-[100dvh] flex flex-col overflow-x-hidden">
      {/* Nav bar */}
      <nav className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between gap-3 px-4 sm:px-6 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-md flex items-center justify-center shrink-0">
            <span className="text-white font-black text-xs">R</span>
          </div>
          <span className="text-white font-bold text-base sm:text-sm truncate">RoofIQ</span>
        </div>
        <button
          type="button"
          onClick={onSignIn}
          className="touch-manipulation flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 active:bg-white/25 border border-white/20 text-white text-sm font-medium min-h-[44px] px-4 rounded-xl transition-all shrink-0"
        >
          Sign In <ArrowRight size={16} className="shrink-0" aria-hidden />
        </button>
      </nav>

      {/* Hero */}
      <section className="relative flex-1 flex flex-col items-center justify-start sm:justify-center px-4 sm:px-6 pt-[max(5.5rem,calc(env(safe-area-inset-top,0px)+4.75rem))] pb-12 sm:pb-20 sm:pt-28 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-blue-950">
        {/* Background grid */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `linear-gradient(rgba(148,163,184,0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(148,163,184,0.3) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }}
        />
        {/* Glow orbs — constrained on narrow screens */}
        <div className="absolute top-1/4 left-1/4 w-[min(24rem,90vw)] h-[min(24rem,90vw)] sm:w-96 sm:h-96 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/4 w-[min(16rem,70vw)] h-[min(16rem,70vw)] sm:w-64 sm:h-64 bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 w-full max-w-3xl mx-auto text-center animate-fade-in">
          {/* Badge */}
          <div className="inline-flex max-w-full items-center justify-center gap-2 bg-blue-500/10 border border-blue-400/20 text-blue-300 text-xs sm:text-sm font-medium px-3 py-2 sm:px-4 sm:py-1.5 rounded-full mb-4 sm:mb-6 leading-snug">
            <Star size={14} fill="currentColor" className="shrink-0" aria-hidden />
            <span>Trusted by 500+ roofing professionals</span>
          </div>

          <h1 className="text-3xl leading-tight sm:text-5xl lg:text-6xl font-black text-white mb-4 sm:mb-5 tracking-tight px-0.5">
            Measure Any Roof
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
              From Anywhere.
            </span>
          </h1>

          <p className="text-slate-400 text-base sm:text-lg lg:text-xl mb-6 sm:mb-10 max-w-xl mx-auto leading-relaxed px-1">
            Enter a property address, trace the roof on satellite imagery, and get a professional
            material & labor quote — in under 5 minutes.
          </p>

          {/* Search bar — stack on phone */}
          <div className="max-w-xl mx-auto w-full">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch bg-white rounded-2xl shadow-2xl shadow-black/30 p-2 sm:p-0 border border-white/10 sm:overflow-hidden">
              <div className="relative flex-1 flex items-center min-h-[52px] sm:min-h-0">
                <MapPin size={18} className="absolute left-3 sm:left-4 text-slate-400 pointer-events-none shrink-0" aria-hidden />
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="search"
                  autoComplete="street-address"
                  enterKeyHint="search"
                  value={inputValue}
                  disabled={!apiKey}
                  onChange={e => { setInputValue(e.target.value); setError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  onFocus={() => {
                    setTimeout(() => {
                      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 300);
                  }}
                  placeholder={apiKey ? 'Enter property address…' : 'Sign in to search addresses'}
                  className="w-full min-h-[48px] pl-10 sm:pl-11 pr-3 py-3.5 sm:py-4 text-slate-800 bg-transparent outline-none placeholder-slate-400 text-base font-medium rounded-xl border border-slate-200 sm:border-0 sm:rounded-none disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <button
                type="button"
                onClick={handleSearch}
                className="touch-manipulation flex w-full sm:w-auto shrink-0 items-center justify-center gap-2 min-h-[48px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold px-5 py-3 rounded-xl transition-all duration-200 text-base sm:text-sm"
              >
                <Search size={18} aria-hidden />
                {apiKey ? 'Analyze roof' : 'Sign in to start'}
              </button>
            </div>
            {!apiKey && (
              <p className="mt-3 text-slate-400 text-sm leading-relaxed px-1 text-center">
                Sign in to search for a property and open satellite measurements.
              </p>
            )}
            {error && (
              <p className="mt-3 text-orange-400 text-sm text-left sm:text-center leading-snug flex items-start sm:items-center gap-1.5 justify-start sm:justify-center px-0.5">
                <span className="shrink-0" aria-hidden>⚠</span>
                <span>{error}</span>
              </p>
            )}
          </div>

          {/* Sample addresses — horizontal scroll on small screens */}
          <div className="mt-4 sm:mt-5 -mx-1 px-1">
            <div className="flex sm:flex-wrap items-stretch gap-2 overflow-x-auto pb-1 sm:pb-0 sm:justify-center [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="text-slate-500 text-xs shrink-0 self-center py-2 pr-1">Try:</span>
              {[
                '1600 Amphitheatre Pkwy, Mountain View, CA',
                '350 Fifth Ave, New York, NY',
                '1 Apple Park Way, Cupertino, CA',
              ].map(addr => (
                <button
                  type="button"
                  key={addr}
                  disabled={!apiKey}
                  onClick={() => {
                    if (!apiKey) return;
                    if (inputRef.current) {
                      inputRef.current.value = addr;
                      setInputValue(addr);
                    }
                  }}
                  className="touch-manipulation shrink-0 text-left text-xs text-slate-300 max-w-[11rem] sm:max-w-none sm:text-center sm:text-slate-400 hover:text-blue-300 sm:hover:text-blue-400 transition-colors bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-2.5 rounded-xl leading-snug disabled:opacity-40 disabled:pointer-events-none"
                >
                  {addr.split(',')[0]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="relative z-10 mt-10 sm:mt-16 w-full max-w-3xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/10 rounded-xl sm:rounded-2xl overflow-hidden border border-white/10">
            {stats.map(stat => (
              <div key={stat.label} className="bg-white/5 px-2 py-3 sm:px-4 sm:py-4 text-center">
                <div className="text-xl sm:text-2xl font-black text-white tabular-nums">{stat.value}</div>
                <div className="text-[10px] sm:text-xs text-slate-400 mt-1 leading-tight">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-white py-12 sm:py-20 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8 sm:mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2 sm:mb-3 px-1">
              Everything a roofing pro needs
            </h2>
            <p className="text-slate-500 text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
              From satellite measurement to customer-ready quotes — all in one workflow.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {features.map(f => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="card p-5 sm:p-6 hover:shadow-md transition-shadow duration-300 group">
                  <div className={`w-11 h-11 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center mb-3 sm:mb-4 ${f.color}`}>
                    <Icon size={20} strokeWidth={2} />
                  </div>
                  <h3 className="font-semibold text-slate-900 mb-2 text-[15px] sm:text-base">{f.title}</h3>
                  <p className="text-slate-500 text-sm leading-relaxed">{f.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="bg-slate-50 py-12 sm:py-20 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8 sm:mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2 sm:mb-3">How it works</h2>
            <p className="text-slate-500 text-base sm:text-lg">Three steps to a professional roof quote</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
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
              <div key={item.step} className="relative flex flex-col items-center text-center px-1">
                {idx < 2 && (
                  <div className="hidden sm:block absolute top-6 left-[calc(50%+32px)] right-0 h-px border-t-2 border-dashed border-slate-200" />
                )}
                {idx > 0 && (
                  <div className="sm:hidden w-px h-6 border-l-2 border-dashed border-slate-200 mb-2" aria-hidden />
                )}
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg mb-3 sm:mb-4 shrink-0 ${item.color}`}>
                  {item.step}
                </div>
                <h3 className="font-semibold text-slate-900 mb-2 text-[15px] sm:text-base">{item.title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed max-w-xs mx-auto">{item.desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 sm:mt-12 text-center px-1">
            <button
              type="button"
              onClick={() => inputRef.current?.focus()}
              className="btn-primary w-full max-w-sm mx-auto sm:w-auto"
            >
              Get Started Free
              <ArrowRight size={16} aria-hidden />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-900 py-8 px-4 text-center pb-[max(2rem,env(safe-area-inset-bottom,0px))]">
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
