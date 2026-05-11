import type { VercelRequest, VercelResponse } from '@vercel/node';

const REPLICATE_BASE = 'https://api.replicate.com/v1';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.REPLICATE_API_TOKEN;
  if (!apiKey) return res.status(503).send('REPLICATE_API_TOKEN not configured in environment');

  const path = (req.query.path as string) || '';
  const url = `${REPLICATE_BASE}/${path.replace(/^\//, '')}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `Token ${apiKey}`,
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
