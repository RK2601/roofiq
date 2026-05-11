/**
 * Vercel serverless proxy for OpenAI Responses API.
 * Keeps OPENAI_API_KEY off the client bundle and enables Gemini->OpenAI fallback.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runOpenAiProxy } from './openaiProxyCore';

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
  const out = await runOpenAiProxy(key, req.body);
  res.setHeader('Content-Type', out.contentType);
  return res.status(out.status).send(out.body);
}
