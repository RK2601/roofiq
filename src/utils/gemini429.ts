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

/** Few retries with backoff for transient 429s (free-tier bursts). */
export async function withGemini429Retries<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isGemini429OrQuotaError(e) && i < maxAttempts - 1) {
        const base = 1100 * (i + 1);
        const jitter = Math.floor(Math.random() * 400);
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
