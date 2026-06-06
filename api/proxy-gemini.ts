/**
 * Server-side Gemini proxy.
 * Routes Gemini generateContent calls through the server so the browser never
 * touches generativelanguage.googleapis.com directly (CORS-blocked in production).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

function resolveGeminiApiKey(): string {
  return (
    (process.env.VITE_GOOGLE_AI_KEY || '').trim() ||
    (process.env.GEMINI_API_KEY || '').trim() ||
    (process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim()
  );
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

const UPSTREAM_MS = 120_000;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers first — before any logic that might throw
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = resolveGeminiApiKey();
  if (!key) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY missing on server',
      hint: 'Set VITE_GOOGLE_AI_KEY or GEMINI_API_KEY in Vercel → Settings → Environment Variables.',
    });
  }

  let payload = req.body as Record<string, unknown>;
  if (Buffer.isBuffer(payload)) {
    try { payload = JSON.parse(payload.toString('utf8')); } catch { payload = {}; }
  } else if (typeof payload === 'string') {
    try { payload = payload.trim() ? JSON.parse(payload) : {}; } catch { payload = {}; }
  }

  const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
  const body = payload?.body;

  if (!model || !ALLOWED_MODELS.has(model) || !body) {
    return res.status(400).json({ error: 'Expected { model, body } where model is a supported Gemini model ID.' });
  }

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    // Always send CORS headers even on non-2xx (rate limit, quota, etc.)
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(upstream.status).send(text);
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: 'Gemini upstream fetch failed', details: msg });
  }
}
