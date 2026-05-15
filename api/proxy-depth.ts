import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  api: { bodyParser: false },
};

const DEPTH_SERVICE = process.env.DEPTH_SERVICE_URL || 'http://72.62.81.209:8001';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.query.path as string) || '';
  const url = `${DEPTH_SERVICE}/${path.replace(/^\//, '')}`;

  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const totalLength = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }

  const headers: Record<string, string> = {};
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body.buffer as ArrayBuffer : undefined,
    });
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch {
    return res.status(502).send('Upstream depth service unreachable');
  }
}
