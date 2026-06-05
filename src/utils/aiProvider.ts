/**
 * Chooses OpenAI vs Gemini for vision/analysis calls.
 * OpenAI runs through `/api/proxy-openai` (server key). Gemini uses the client/bundled key.
 */

declare const __ROOFIQ_OPENAI_CONFIGURED__: string | boolean;

let serverOpenAiAvailable: boolean | null = null;
let probePromise: Promise<boolean> | null = null;

export function isOpenAiConfiguredAtBuild(): boolean {
  try {
    if (typeof __ROOFIQ_OPENAI_CONFIGURED__ === 'boolean') return __ROOFIQ_OPENAI_CONFIGURED__;
    if (typeof __ROOFIQ_OPENAI_CONFIGURED__ === 'string') {
      return __ROOFIQ_OPENAI_CONFIGURED__ === 'true' || __ROOFIQ_OPENAI_CONFIGURED__ === '1';
    }
  } catch {
    /* SSR / tests */
  }
  return false;
}

/** Probe `/api/ai-health` once per session (works on Vercel after env changes + redeploy). */
export async function ensureOpenAiServerProbe(): Promise<boolean> {
  if (serverOpenAiAvailable !== null) return serverOpenAiAvailable;
  if (!probePromise) {
    probePromise = fetch('/api/ai-health', { method: 'GET' })
      .then(async res => {
        if (!res.ok) return false;
        const data = (await res.json()) as { openai?: boolean };
        return !!data.openai;
      })
      .catch(() => false)
      .then(ok => {
        serverOpenAiAvailable = ok;
        return ok;
      });
  }
  return probePromise;
}

/** Reset cached probe (e.g. after Settings change in dev). */
export function resetOpenAiServerProbe(): void {
  serverOpenAiAvailable = null;
  probePromise = null;
}

/**
 * When true, vision helpers should call OpenAI first and skip Gemini unless OpenAI fails
 * or the user explicitly disabled OpenAI (`VITE_PREFER_OPENAI_VISION=0`).
 */
export async function shouldPreferOpenAiVision(): Promise<boolean> {
  try {
    const v = import.meta.env.VITE_PREFER_OPENAI_VISION;
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
  } catch {
    /* ignore */
  }
  if (isOpenAiConfiguredAtBuild()) return true;
  return ensureOpenAiServerProbe();
}
