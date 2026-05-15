import type { GenerateContentResult } from '@google/generative-ai';

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
 * A minimum 1 s gap is enforced between requests (free tier = 15 RPM).
 */
const MIN_REQUEST_GAP_MS = 1_000;
let _geminiTail: Promise<unknown> = Promise.resolve();
let _lastRequestAt = 0;

export function enqueueGeminiRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
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
 * Retry with backoff for 429 / quota errors.
 * Delays: ~30 s, ~60 s, ~90 s — long enough for Gemini's rate-limit window
 * to clear (the previous 1–3 s delays were too short and just created more 429s).
 */
export async function withGemini429Retries<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isGemini429OrQuotaError(e) && i < maxAttempts - 1) {
        const base = 30_000 * (i + 1);
        const jitter = Math.floor(Math.random() * 10_000);
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, base + jitter);
        });
        continue;
      }
      throw e;
    }
  }
  throw last;
}
