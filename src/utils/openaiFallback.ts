export type OpenAiFallbackTask = 'roof_analysis' | 'roof_geometry' | 'roof_cues';

export interface OpenAiImagePayload {
  data: string;
  mimeType: string;
}

function cleanedJsonFromOpenAiResponse(resp: any): string {
  // Responses API usually includes output_text; but since we asked for json_object,
  // the easiest stable path is to scan for the first object-like text.
  const directText =
    typeof resp?.output_text === 'string'
      ? resp.output_text
      : typeof resp?.output?.[0]?.content?.[0]?.text === 'string'
        ? resp.output[0].content[0].text
        : '';

  const raw = (directText || JSON.stringify(resp)).trim();
  // If it's already valid JSON object string, return as-is.
  if (raw.startsWith('{') && raw.endsWith('}')) return raw;
  // Fallback: find first {...} block.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  throw new Error('OPENAI_BAD_JSON');
}

export async function callOpenAiFallbackJson<T>(args: {
  task: OpenAiFallbackTask;
  prompt: string;
  image: OpenAiImagePayload;
}): Promise<T> {
  const res = await fetch('/api/proxy-openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OPENAI_PROXY_HTTP_${res.status}:${text.slice(0, 240)}`);
  }
  const parsed = JSON.parse(text);
  const jsonStr = cleanedJsonFromOpenAiResponse(parsed);
  return JSON.parse(jsonStr) as T;
}

