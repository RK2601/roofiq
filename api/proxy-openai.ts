/**
 * Vercel serverless proxy for OpenAI chat completions.
 * Keeps OPENAI_API_KEY off the client bundle and enables Gemini->OpenAI fallback.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

type OpenAiProxyTask = 'roof_analysis' | 'roof_geometry' | 'roof_cues' | 'segment_analysis';

function isTaskKind(v: unknown): v is OpenAiProxyTask {
  return v === 'roof_analysis' || v === 'roof_geometry' || v === 'roof_cues' || v === 'segment_analysis';
}

const UPSTREAM_MS = 180_000;

async function fetchChatCompletion(
  key: string,
  model: string,
  prompt: string,
  mimeType: string,
  imageData: string,
  maxTokens: number,
  retry: boolean
): Promise<{ status: number; body: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);
  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
    });
    clearTimeout(timer);
    const text = await upstream.text();
    if (!upstream.ok) {
      return {
        status: upstream.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'OpenAI upstream error', details: text.slice(0, 2000) }),
      };
    }
    return { status: 200, contentType: 'application/json', body: text };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    if (retry && (msg.includes('abort') || msg.includes('Abort') || msg.includes('fetch failed') || msg.includes('ECONNRESET'))) {
      await new Promise(r => setTimeout(r, 1200));
      return fetchChatCompletion(key, model, prompt, mimeType, imageData, maxTokens, false);
    }
    return {
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Upstream fetch failed', details: msg }),
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const key = (
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.OPENAI_KEY || '').trim()
  );

  if (!key) {
    return res.status(500).json({ error: 'OPENAI_API_KEY missing on server' });
  }

  let payload = req.body as Record<string, unknown>;
  if (Buffer.isBuffer(payload)) {
    try { payload = JSON.parse(payload.toString('utf8')); } catch { payload = {}; }
  } else if (typeof payload === 'string') {
    try { payload = payload.trim() ? JSON.parse(payload) : {}; } catch { payload = {}; }
  }

  const task = payload?.task;
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  const image = payload?.image as Record<string, unknown> | undefined;
  const imageData = typeof image?.data === 'string' ? image.data : '';
  const mimeType = typeof image?.mimeType === 'string' ? image.mimeType : 'image/png';

  if (!isTaskKind(task) || !prompt || !imageData) {
    return res.status(400).json({ error: 'Invalid request. Expected { task, prompt, image:{data,mimeType} }.' });
  }

  const model = typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : 'gpt-4o-mini';
  const maxTokens = task === 'roof_cues' ? 1800 : 2200;

  const result = await fetchChatCompletion(key, model, prompt, mimeType, imageData, maxTokens, true);
  res.setHeader('Content-Type', result.contentType);
  return res.status(result.status).send(result.body);
}
