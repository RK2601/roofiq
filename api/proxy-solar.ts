/**
 * Vercel serverless proxy for the Google Solar API (`solar.googleapis.com`).
 * The browser calls same-origin `/api/proxy-solar?u=<encoded Solar URL>` so a **Maps-only** key is not
 * required to expose a Solar key to the client (optional hardening). Local dev: ensure this route is
 * served (e.g. `vercel dev`) or rely on direct Solar fetches when the upstream allows your origin.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

/** DSM/RGB GeoTIFF links are usually on solar.googleapis.com; some responses use signed GCS URLs. */
const ALLOWED = /^https:\/\/(solar|storage)\.googleapis\.com\//;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const raw = req.query.u;
  const target = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  if (!target || !ALLOWED.test(target)) {
    return res.status(400).send('Invalid or missing target URL');
  }

  try {
    const upstream = await fetch(target);
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch {
    return res.status(502).send('Upstream fetch failed');
  }
}
