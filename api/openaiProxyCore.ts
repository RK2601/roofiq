/**
 * Shared OpenAI proxy logic (Vercel function + Vite dev middleware).
 */

export type OpenAiProxyTask = 'roof_analysis' | 'roof_geometry' | 'roof_cues';

function isTaskKind(v: unknown): v is OpenAiProxyTask {
  return v === 'roof_analysis' || v === 'roof_geometry' || v === 'roof_cues';
}

export interface OpenAiProxyResult {
  status: number;
  /** Response body string (JSON from OpenAI or error JSON). */
  body: string;
  contentType: string;
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

  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:${mimeType};base64,${imageData}` },
      ],
    },
  ];

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_output_tokens: task === 'roof_cues' ? 1800 : 2200,
      }),
    });

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
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Upstream fetch failed', details: msg }),
    };
  }
}
