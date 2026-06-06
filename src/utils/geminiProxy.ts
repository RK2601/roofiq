/**
 * Routes Gemini generateContent calls through /api/proxy-gemini (server-side).
 * Use this instead of calling the Gemini SDK directly from the browser to avoid
 * CORS issues with generativelanguage.googleapis.com.
 */

export interface GeminiProxyPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiGenerationConfig {
  responseMimeType?: string;
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiSafetySetting {
  category: string;
  threshold: string;
}

export interface GeminiProxyRequest {
  model: string;
  parts: GeminiProxyPart[];
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: GeminiSafetySetting[];
}

export interface GeminiProxyResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

const UPSTREAM_MS = 120_000;

export async function callGeminiProxy(req: GeminiProxyRequest): Promise<string> {
  const body = {
    contents: [{ parts: req.parts }],
    generationConfig: req.generationConfig,
    safetySettings: req.safetySettings,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);

  let res: Response;
  try {
    res = await fetch('/api/proxy-gemini', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: req.model, body }),
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    // Surface quota / rate-limit errors with a recognizable code
    if (res.status === 429 || text.includes('RESOURCE_EXHAUSTED') || text.includes('QuotaFailure')) {
      throw new Error(`429 RESOURCE_EXHAUSTED via proxy: ${text.slice(0, 300)}`);
    }
    throw new Error(`Gemini proxy HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as GeminiProxyResponse;

  if (json.error) {
    const code = json.error.code ?? 0;
    const msg = json.error.message ?? 'Unknown Gemini error';
    if (code === 429 || json.error.status === 'RESOURCE_EXHAUSTED') {
      throw new Error(`429 RESOURCE_EXHAUSTED: ${msg}`);
    }
    throw new Error(`Gemini API error ${code}: ${msg}`);
  }

  const blockReason = json.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`GEMINI_BLOCKED:${blockReason}`);

  const candidate = json.candidates?.[0];
  if (!candidate) throw new Error('GEMINI_NO_CANDIDATES');

  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`GEMINI_FINISH:${candidate.finishReason}`);
  }

  const responseText = candidate.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!responseText.trim()) throw new Error('GEMINI_EMPTY_RESPONSE');

  return responseText;
}

/** Convenience: call proxy and parse JSON from response text. */
export async function callGeminiProxyJson<T>(req: GeminiProxyRequest): Promise<T> {
  const text = await callGeminiProxy(req);
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}
