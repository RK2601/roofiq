import { useState } from 'react';
import { User } from '../types';

interface LoginPageProps {
  onLogin: (user: User) => void;
  onBack: () => void;
}

const USERS: Array<{ email: string; password: string; name: string; role: string; avatar: string }> = [
  { email: 'admin@roofiq.com', password: 'roofiq2024', name: 'Admin User', role: 'Admin', avatar: 'AU' },
  { email: 'demo@roofiq.com', password: 'demo123', name: 'Demo User', role: 'Contractor', avatar: 'DU' },
];

export default function LoginPage({ onLogin, onBack }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    await new Promise(r => setTimeout(r, 500));

    const match = USERS.find(u => u.email === email && u.password === password);
    if (match) {
      const { password: _pw, ...user } = match;
      void _pw;
      onLogin(user);
    } else {
      setError('Invalid email or password. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 flex-col justify-between p-12">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xl">R</span>
            </div>
            <span className="text-white text-2xl font-bold">RoofIQ</span>
          </div>
          <div className="border-b border-blue-600 w-24 mb-10" />
          <h2 className="text-white text-3xl font-bold mb-4 leading-snug">
            Professional Roofing<br />Estimates, Powered by AI
          </h2>
          <p className="text-slate-400 text-lg mb-10">
            Measure roofs from satellite imagery and generate accurate quotes in minutes.
          </p>
          <ul className="space-y-5">
            {[
              { icon: '📍', title: 'Satellite Roof Mapping', desc: 'Draw sections directly on satellite imagery with precision polygon tools.' },
              { icon: '📐', title: 'Accurate Area Calculation', desc: 'Pitch-adjusted area calculations using industry-standard multipliers.' },
              { icon: '📄', title: 'Instant Quote Generation', desc: 'Professional PDF quotes with materials, labor, and tax breakdown.' },
            ].map(f => (
              <li key={f.title} className="flex gap-4">
                <span className="text-2xl">{f.icon}</span>
                <div>
                  <p className="text-white font-semibold">{f.title}</p>
                  <p className="text-slate-400 text-sm">{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-slate-600 text-sm">© 2024 RoofIQ. All rights reserved.</p>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col justify-center items-center bg-white px-8 py-12">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-3 mb-8">
            <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-lg">R</span>
            </div>
            <span className="text-slate-900 text-xl font-bold">RoofIQ</span>
          </div>

          <h1 className="text-2xl font-bold text-slate-900 mb-2">Welcome back</h1>
          <p className="text-slate-500 mb-8">Sign in to your account to continue</p>

          {/* Test credentials info */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
            <p className="text-amber-800 text-sm font-semibold mb-1">Test Credentials</p>
            <p className="text-amber-700 text-sm">Email: <span className="font-mono">admin@roofiq.com</span></p>
            <p className="text-amber-700 text-sm">Password: <span className="font-mono">roofiq2024</span></p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </>
              ) : 'Sign in'}
            </button>
          </form>

          <button
            onClick={onBack}
            className="mt-6 text-sm text-slate-500 hover:text-slate-700 transition-colors w-full text-center"
          >
            ← Back to home
          </button>
        </div>
      </div>
    </div>
  );
}
