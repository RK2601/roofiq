/**
 * Vercel serverless proxy for OpenAI Responses API.
 * Keeps OPENAI_API_KEY off the client bundle and enables Gemini->OpenAI fallback.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runOpenAiProxy } from './openaiProxyCore';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

function resolveOpenAiKey(): string {
  return (
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.OPENAI_KEY || '').trim()
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const key = resolveOpenAiKey();
  let payload: unknown = req.body;
  if (Buffer.isBuffer(payload)) {
    try {
      payload = JSON.parse(payload.toString('utf8'));
    } catch {
      payload = {};
    }
  } else if (typeof payload === 'string') {
    try {
      payload = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      payload = {};
    }
  }
  const out = await runOpenAiProxy(key, payload);
  res.setHeader('Content-Type', out.contentType);
  return res.status(out.status).send(out.body);
}
