import { useState } from 'react';
import { Key, ExternalLink, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { readMapsApiKey } from '../utils/googleMapsKey';

interface ApiKeySetupProps {
  onSave: (key: string) => void;
}

const steps = [
  { step: '1', text: 'Go to Google Cloud Console', link: 'https://console.cloud.google.com' },
  { step: '2', text: 'Create a project and enable Maps JavaScript API, Places API' },
  { step: '3', text: 'Go to Credentials → Create API Key' },
  { step: '4', text: 'Copy and paste the key below' },
];

export default function ApiKeySetup({ onSave }: ApiKeySetupProps) {
  const [key, setKey] = useState(() => readMapsApiKey());
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);

  const handleSave = () => {
    const trimmed = key.trim();
    if (!trimmed.startsWith('AIza') || trimmed.length < 30) {
      setError('This does not look like a valid Google Maps API key. Keys start with "AIza".');
      return;
    }
    setValidating(true);
    setTimeout(() => {
      localStorage.setItem('roofiq_gmaps_key', trimmed);
      onSave(trimmed);
      setValidating(false);
    }, 800);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-blue-950 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-8 py-7">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center">
              <Key size={16} className="text-white" />
            </div>
            <span className="text-white font-bold text-lg">Google Maps Setup</span>
          </div>
          <p className="text-blue-100 text-sm">
            RoofIQ requires a Google Maps API key for satellite imagery and address search.
          </p>
        </div>

        <div className="px-8 py-7">
          {/* Steps */}
          <div className="space-y-3 mb-7">
            {steps.map(s => (
              <div key={s.step} className="flex items-start gap-3">
                <div className="w-6 h-6 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                  {s.step}
                </div>
                <div className="text-sm text-slate-600">
                  {s.text}
                  {s.link && (
                    <a
                      href={s.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Open <ExternalLink size={11} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="mb-2">
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Your API Key
            </label>
            <input
              type="text"
              value={key}
              onChange={e => { setKey(e.target.value); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="AIzaSy..."
              className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-300 placeholder-slate-300"
            />
          </div>
          {error && (
            <div className="flex items-center gap-1.5 text-red-500 text-xs mb-4">
              <AlertCircle size={12} />
              {error}
            </div>
          )}

          <p className="text-xs text-slate-400 mb-6">
            Your key is stored locally in your browser and never sent to our servers.
          </p>

          <button
            onClick={handleSave}
            disabled={!key.trim() || validating}
            className="w-full btn-primary justify-center py-3 text-base disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none disabled:translate-y-0"
          >
            {validating ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <CheckCircle2 size={17} />
                Save & Continue
                <ChevronRight size={16} />
              </>
            )}
          </button>

          <div className="mt-6 bg-amber-50 border border-amber-100 rounded-xl p-4 text-xs text-amber-800">
            <strong>Required APIs:</strong> Maps JavaScript API, Places API.
            Make sure both are enabled in your Google Cloud project. Billing must be enabled.
          </div>
        </div>
      </div>
    </div>
  );
}
