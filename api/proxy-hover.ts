import type { VercelRequest, VercelResponse } from '@vercel/node';

const HOVER_BASE = 'https://api.hover.to/v3';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.HOVER_API_KEY;
  if (!apiKey) return res.status(503).send('HOVER_API_KEY not configured in environment');

  const path = (req.query.path as string) || '';
  const url = `${HOVER_BASE}/${path.replace(/^\//, '')}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch {
    return res.status(502).send('Upstream fetch failed');
  }
}
