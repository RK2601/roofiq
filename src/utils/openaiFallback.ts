import { ensureOpenAiServerProbe, isOpenAiConfiguredAtBuild } from './aiProvider';

export type OpenAiFallbackTask =
  | 'roof_analysis'
  | 'roof_geometry'
  | 'roof_cues'
  | 'segment_analysis'
  | 'outline_analysis'
  | 'structure_detection'
  | 'wizard_vision';

const OPENAI_BACKOFF_KEY = 'roofiq_openai_backoff_until';
function readOpenAiBackoff(): number {
  try { return parseInt(sessionStorage.getItem(OPENAI_BACKOFF_KEY) ?? '0', 10) || 0; } catch { return 0; }
}
function persistOpenAiBackoff(until: number): void {
  try { sessionStorage.setItem(OPENAI_BACKOFF_KEY, String(until)); } catch { /* ignore */ }
}
let openAiProxyDisabledUntil = readOpenAiBackoff();

/** Whether we should attempt `/api/proxy-openai`. */
export function isOpenAiFallbackAvailable(): boolean {
  // Re-read from sessionStorage in case this was set in a previous page load
  if (openAiProxyDisabledUntil === 0) openAiProxyDisabledUntil = readOpenAiBackoff();
  if (Date.now() < openAiProxyDisabledUntil) return false;
  try {
    const v = import.meta.env.VITE_OPENAI_FALLBACK;
    if (v === '0' || v === 'false') return false;
  } catch {
    /* ignore */
  }
  return isOpenAiConfiguredAtBuild() || serverOpenAiKnownAvailable();
}

function serverOpenAiKnownAvailable(): boolean {
  // Populated by ensureOpenAiServerProbe() from App mount.
  return _probedOpenAiAvailable === true;
}

let _probedOpenAiAvailable: boolean | null = null;

/** Called once from App after /api/ai-health probe. */
export function setOpenAiServerAvailability(available: boolean): void {
  _probedOpenAiAvailable = available;
  if (available) openAiProxyDisabledUntil = 0;
}

function markOpenAiProxyUnavailable(reason: string): void {
  openAiProxyDisabledUntil = Date.now() + 2 * 60 * 1000;
  persistOpenAiBackoff(openAiProxyDisabledUntil);
  console.warn('[OpenAI fallback] Temporarily skipping proxy (2 min):', reason);
}

/** Warm probe — call from App on load. */
export async function warmOpenAiFallbackAvailability(): Promise<boolean> {
  const fromBuild = isOpenAiConfiguredAtBuild();
  const fromServer = await ensureOpenAiServerProbe();
  const ok = fromBuild || fromServer;
  setOpenAiServerAvailability(ok);
  return ok;
}

export interface OpenAiImagePayload {
  data: string;
  mimeType: string;
}

/** Large base64 payloads exceed common serverless body limits (~4.5MB) and break the proxy with 502/413. */
const MAX_IMAGE_BASE64_CHARS = 3_200_000;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Downscale to JPEG so POST body stays under serverless limits (browser only).
 */
async function shrinkImageForOpenAi(
  image: OpenAiImagePayload,
  options?: { maxSide?: number; force?: boolean }
): Promise<OpenAiImagePayload> {
  const maxSide = options?.maxSide ?? 1600;
  const force = options?.force ?? false;
  if (!force && image.data.length <= MAX_IMAGE_BASE64_CHARS) return image;
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    console.warn('[OpenAI fallback] Image is large; resize unavailable — proxy may fail.');
    return image;
  }
  try {
    const dataUrl = `data:${image.mimeType};base64,${image.data}`;
    const blob = await fetch(dataUrl).then(r => r.blob());
    const bmp = await createImageBitmap(blob);
    let w = bmp.width;
    let h = bmp.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return image;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const jpegBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!jpegBlob) return image;
    const buf = await jpegBlob.arrayBuffer();
    const b64 = uint8ToBase64(new Uint8Array(buf));
    return { data: b64, mimeType: 'image/jpeg' };
  } catch (e) {
    console.warn('[OpenAI fallback] shrink failed:', e instanceof Error ? e.message : e);
    return image;
  }
}

function cleanedJsonFromOpenAiResponse(resp: any): string {
  const fromChat =
    typeof resp?.choices?.[0]?.message?.content === 'string' ? resp.choices[0].message.content : '';
  const directText =
    typeof resp?.output_text === 'string'
      ? resp.output_text
      : typeof resp?.output?.[0]?.content?.[0]?.text === 'string'
        ? resp.output[0].content[0].text
        : '';

  const raw = (fromChat || directText || JSON.stringify(resp)).trim();
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
  if (!isOpenAiFallbackAvailable()) {
    throw new Error('OPENAI_FALLBACK_UNAVAILABLE');
  }

  let payload: { task: OpenAiFallbackTask; prompt: string; image: OpenAiImagePayload } = {
    ...args,
    image: await shrinkImageForOpenAi(args.image),
  };

  const post = async () => {
    const res = await fetch('/api/proxy-openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { res, text };
  };

  let { res, text } = await post();

  if (!res.ok && (res.status === 502 || res.status === 503)) {
    payload = {
      ...args,
      image: await shrinkImageForOpenAi(args.image, { maxSide: 1024, force: true }),
    };
    const retry = await fetch('/api/proxy-openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t2 = await retry.text();
    res = retry;
    text = t2;
  }

  if (!res.ok && (res.status === 502 || res.status === 503)) {
    await new Promise(r => setTimeout(r, 1500));
    const second = await post();
    res = second.res;
    text = second.text;
  }

  if (!res.ok) {
    if (res.status === 500 && /OPENAI_API_KEY missing|OPENAI_KEY missing/i.test(text)) {
      markOpenAiProxyUnavailable('OPENAI_API_KEY missing on server');
    } else if (res.status === 429) {
      // OpenAI rate-limited — back off for 3 minutes (persisted across page refreshes)
      openAiProxyDisabledUntil = Date.now() + 3 * 60 * 1000;
      persistOpenAiBackoff(openAiProxyDisabledUntil);
      console.warn('[OpenAI fallback] Rate-limited (429) — pausing proxy calls for 3 minutes.');
    }
    throw new Error(`OPENAI_PROXY_HTTP_${res.status}:${text.slice(0, 240)}`);
  }
  const parsed = JSON.parse(text);
  const jsonStr = cleanedJsonFromOpenAiResponse(parsed);
  return JSON.parse(jsonStr) as T;
}

