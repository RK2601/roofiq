import type { GenerateContentResult } from '@google/generative-ai';

/** Thrown when client-side cooldown is active after repeated 429 / quota errors. */
export const GEMINI_QUOTA_ERROR = 'GEMINI_QUOTA_EXCEEDED';

const GEMINI_COOLDOWN_MS = 15 * 60 * 1000;
const GEMINI_COOLDOWN_KEY = 'roofiq_gemini_cooldown_until';

function readPersistedCooldown(): number {
  try { return parseInt(sessionStorage.getItem(GEMINI_COOLDOWN_KEY) ?? '0', 10) || 0; } catch { return 0; }
}
function persistCooldown(until: number): void {
  try { sessionStorage.setItem(GEMINI_COOLDOWN_KEY, String(until)); } catch { /* ignore */ }
}

let geminiQuotaCooldownUntil = readPersistedCooldown();

export function isGeminiQuotaPaused(): boolean {
  if (geminiQuotaCooldownUntil === 0) geminiQuotaCooldownUntil = readPersistedCooldown();
  return Date.now() < geminiQuotaCooldownUntil;
}

export function getGeminiQuotaCooldownRemainingMs(): number {
  return Math.max(0, geminiQuotaCooldownUntil - Date.now());
}

export function triggerGeminiQuotaCooldown(reason?: string): void {
  geminiQuotaCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
  persistCooldown(geminiQuotaCooldownUntil);
  if (reason) console.warn(reason);
}

export function clearGeminiQuotaCooldown(): void {
  geminiQuotaCooldownUntil = 0;
  persistCooldown(0);
}

export function formatGeminiQuotaUserMessage(): string {
  const mins = Math.max(1, Math.ceil(getGeminiQuotaCooldownRemainingMs() / 60_000));
  return `Gemini API quota or rate limit reached. Wait about ${mins} minute${mins === 1 ? '' : 's'} (or check billing in Google AI Studio), then try again.`;
}

/**
 * Read model text, or throw with reasons when `response.text()` fails (blocked,
 * non-STOP finish, empty candidates). Keeps errors debuggable vs a bare SDK throw.
 */
export function readGeminiResponseText(result: GenerateContentResult): string {
  const res = result.response;
  try {
    return res.text();
  } catch (first) {
    const pf = res.promptFeedback;
    if (pf?.blockReason) {
      throw new Error(`GEMINI_BLOCKED:${pf.blockReason}`);
    }
    const c0 = res.candidates?.[0];
    if (c0?.finishReason && c0.finishReason !== 'STOP') {
      throw new Error(`GEMINI_FINISH:${c0.finishReason}`);
    }
    throw first instanceof Error ? first : new Error(String(first));
  }
}

/** Detect Gemini / Google quota or rate-limit responses. */
export function isGemini429OrQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b|RESOURCE_EXHAUSTED|quota exceeded|Quota exceeded|rate limit|Too Many Requests/i.test(msg);
}

/**
 * Global serial queue — ALL Gemini callers must go through this so concurrent
 * tabs/features don't stack up simultaneous requests and multiply 429s.
 * Free tier ≈ 15 RPM → keep ≥2s between calls.
 */
const MIN_REQUEST_GAP_MS = 2_500;
let _geminiTail: Promise<unknown> = Promise.resolve();
let _lastRequestAt = 0;

export function enqueueGeminiRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (isGeminiQuotaPaused()) {
      throw new Error(GEMINI_QUOTA_ERROR);
    }
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - _lastRequestAt);
    if (gap > 0) await new Promise<void>(r => setTimeout(r, gap));
    _lastRequestAt = Date.now();
    return fn();
  };
  const next = _geminiTail.then(run, run) as Promise<T>;
  _geminiTail = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * Retry with backoff for 429 / quota errors (at most 2 attempts).
 * On exhaustion, activates a 15-minute client cooldown to stop DevTools spam.
 */
export async function withGemini429Retries<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  if (isGeminiQuotaPaused()) {
    throw new Error(GEMINI_QUOTA_ERROR);
  }

  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isGemini429OrQuotaError(e)) {
        if (i < maxAttempts - 1) {
          const base = 8_000 * (i + 1);
          const jitter = Math.floor(Math.random() * 2_000);
          await new Promise<void>(resolve => {
            window.setTimeout(resolve, base + jitter);
          });
          continue;
        }
        triggerGeminiQuotaCooldown('[Gemini] Quota/rate limit — pausing API calls for 15 minutes.');
      }
      throw e;
    }
  }
  throw last;
}
