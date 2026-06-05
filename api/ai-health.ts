/**
 * Lightweight config probe — tells the client whether server-side AI proxies are configured.
 * Does not expose key values.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveGeminiApiKeyForServer, resolveOpenAiApiKey } from './resolveEnvKeys';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const openai = !!resolveOpenAiApiKey();
  const gemini = !!resolveGeminiApiKeyForServer();

  return res.status(200).json({
    openai,
    gemini,
    /** When true, the client should route vision work through OpenAI first. */
    preferOpenAi: openai,
  });
}
