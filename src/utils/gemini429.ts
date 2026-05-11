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
