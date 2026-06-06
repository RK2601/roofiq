import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Server-side image proxy — fetches any HTTPS image URL and streams it back.
 * Used to bypass CORS restrictions when converting Replicate CDN depth-map
 * images to base64 data URLs in the browser.
 *
 * GET /api/proxy-image?url=<encoded-url>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }

  const raw = req.query.url;
  const url = Array.isArray(raw) ? raw[0] : raw;
  if (!url || !url.startsWith('https://')) {
    res.status(400).json({ error: 'Missing or non-https url parameter' });
    return;
  }

  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'RoofIQ/1.0' } });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
      return;
    }
    const contentType = upstream.headers.get('content-type') ?? 'image/png';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
