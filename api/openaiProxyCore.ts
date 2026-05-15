/**
 * Shared OpenAI proxy logic (Vercel function + Vite dev middleware).
 */

export type OpenAiProxyTask = 'roof_analysis' | 'roof_geometry' | 'roof_cues' | 'segment_analysis';

function isTaskKind(v: unknown): v is OpenAiProxyTask {
  return v === 'roof_analysis' || v === 'roof_geometry' || v === 'roof_cues' || v === 'segment_analysis';
}

export interface OpenAiProxyResult {
  status: number;
  /** Response body string (JSON from OpenAI or error JSON). */
  body: string;
  contentType: string;
}

const UPSTREAM_MS = 180_000;

async function fetchChatCompletionOnce(
  key: string,
  model: string,
  prompt: string,
  mimeType: string,
  imageData: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<Response> {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
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
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageData}` },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
}

export async function runOpenAiProxy(apiKey: string, rawBody: unknown): Promise<OpenAiProxyResult> {
  const key = apiKey.trim();
  if (!key) {
    return {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'OPENAI_API_KEY missing' }),
    };
  }

  const body = rawBody as Record<string, unknown>;
  const task = body?.task;
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const image = body?.image as Record<string, unknown> | undefined;
  const imageData = typeof image?.data === 'string' ? image.data : '';
  const mimeType = typeof image?.mimeType === 'string' ? image.mimeType : 'image/png';

  if (!isTaskKind(task) || !prompt || !imageData) {
    return {
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Invalid request. Expected { task, prompt, image:{data,mimeType} }.',
      }),
    };
  }

  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : 'gpt-4o-mini';

  const maxTokens = task === 'roof_cues' ? 1800 : 2200;

  const attempt = async (retry: boolean): Promise<OpenAiProxyResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);
    try {
      const upstream = await fetchChatCompletionOnce(key, model, prompt, mimeType, imageData, maxTokens, controller.signal);
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
      if (
        retry &&
        (msg.includes('abort') || msg.includes('Abort') || msg.includes('fetch failed') || msg.includes('ECONNRESET'))
      ) {
        await new Promise(r => setTimeout(r, 1200));
        return attempt(false);
      }
      return {
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Upstream fetch failed', details: msg }),
      };
    }
  };

  return attempt(true);
}
