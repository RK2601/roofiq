import { useState } from 'react';
import { Eye, EyeOff, CheckCircle2, ExternalLink } from 'lucide-react';
import { User } from '../types';
import { readGeminiApiKey } from '../utils/googleAiKey';

interface SettingsPageProps {
  apiKey: string;
  user: User;
  onNeedApiKey: () => void;
  onLogout: () => void;
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key.slice(0, 4) + '...';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

export default function SettingsPage({ apiKey, user, onNeedApiKey, onLogout }: SettingsPageProps) {
  const [geminiKey, setGeminiKey] = useState(() => readGeminiApiKey());
  const [geminiInput, setGeminiInput] = useState('');
  const [geminiEditing, setGeminiEditing] = useState(false);
  const [geminiVisible, setGeminiVisible] = useState(false);
  const [geminiSaved, setGeminiSaved] = useState(false);

  const startEditGemini = () => {
    setGeminiInput(geminiKey);
    setGeminiEditing(true);
    setGeminiSaved(false);
  };

  const saveGeminiKey = () => {
    const trimmed = geminiInput.trim();
    localStorage.setItem('roofiq_gemini_key', trimmed);
    setGeminiKey(trimmed);
    setGeminiEditing(false);
    setGeminiSaved(true);
    setTimeout(() => setGeminiSaved(false), 3000);
  };

  const cancelGemini = () => {
    setGeminiEditing(false);
    setGeminiInput('');
  };

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Settings</h2>
        <p className="text-slate-500 mt-1">Manage your account and application configuration.</p>
      </div>

      {/* API Configuration */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="font-semibold text-slate-800">API Configuration</h3>
          <p className="text-slate-500 text-sm mt-0.5">Configure API keys for maps and AI features.</p>
        </div>
        <div className="divide-y divide-slate-100">

          {/* Google Maps key */}
          <div className="px-6 py-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-700 mb-1">Google Maps API Key</p>
              <p className="font-mono text-sm text-slate-500 bg-slate-100 px-3 py-1.5 rounded">
                {maskApiKey(apiKey) || '(not set)'}
              </p>
            </div>
            <button
              onClick={onNeedApiKey}
              className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Update Key
            </button>
          </div>

          {/* Gemini AI key */}
          <div className="px-6 py-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <p className="text-sm font-medium text-slate-700 mb-0.5">Google Gemini AI Key</p>
                <p className="text-xs text-slate-400">
                  Powers AI roof analysis.{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline inline-flex items-center gap-0.5"
                  >
                    Get a free key <ExternalLink size={10} />
                  </a>
                </p>
              </div>
              {geminiSaved && (
                <span className="flex items-center gap-1 text-xs text-green-600 font-medium flex-shrink-0">
                  <CheckCircle2 size={13} />
                  Saved
                </span>
              )}
            </div>

            {geminiEditing ? (
              <div className="space-y-2">
                <div className="relative">
                  <input
                    type={geminiVisible ? 'text' : 'password'}
                    value={geminiInput}
                    onChange={e => setGeminiInput(e.target.value)}
                    placeholder="AIza..."
                    autoFocus
                    className="w-full font-mono text-sm border border-slate-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-lg px-3 py-2.5 pr-10 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setGeminiVisible(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {geminiVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={saveGeminiKey}
                    disabled={!geminiInput.trim()}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    Save Key
                  </button>
                  <button
                    onClick={cancelGemini}
                    className="bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  {geminiKey ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <p className="font-mono text-sm text-slate-500 bg-slate-100 px-3 py-1.5 rounded">
                        {maskApiKey(geminiKey)}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-amber-400" />
                      <p className="text-sm text-slate-400 italic">Not configured — AI features disabled</p>
                    </>
                  )}
                </div>
                <button
                  onClick={startEditGemini}
                  className="flex-shrink-0 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {geminiKey ? 'Update' : 'Add Key'}
                </button>
              </div>
            )}
          </div>

        </div>
      </section>

      {/* Account */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="font-semibold text-slate-800">Account</h3>
          <p className="text-slate-500 text-sm mt-0.5">Your account information.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {[
            { label: 'Full Name', value: user.name },
            { label: 'Email Address', value: user.email },
            { label: 'Role', value: user.role },
          ].map(field => (
            <div key={field.label}>
              <label className="block text-sm font-medium text-slate-500 mb-1">{field.label}</label>
              <div className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-sm">
                {field.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Danger Zone */}
      <section className="bg-white rounded-xl border border-red-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-red-100 bg-red-50">
          <h3 className="font-semibold text-red-700">Danger Zone</h3>
          <p className="text-red-500 text-sm mt-0.5">Irreversible actions. Proceed with caution.</p>
        </div>
        <div className="px-6 py-5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-700">Sign Out</p>
            <p className="text-slate-400 text-sm mt-0.5">You will be redirected to the home page.</p>
          </div>
          <button
            onClick={onLogout}
            className="bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Sign Out
          </button>
        </div>
      </section>
    </div>
  );
}
