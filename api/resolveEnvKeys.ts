/**
 * Server-side env resolution (Vercel functions + build scripts).
 * Accepts common aliases so dashboard typos (e.g. VITE_OPENAI_API_KEY) still work at runtime.
 */

export function resolveOpenAiApiKey(): string {
  return (
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.OPENAI_KEY || '').trim() ||
    (process.env.VITE_OPENAI_API_KEY || '').trim()
  );
}

export function resolveGeminiApiKeyForServer(): string {
  return (
    (process.env.VITE_GOOGLE_AI_KEY || '').trim() ||
    (process.env.GEMINI_API_KEY || '').trim() ||
    (process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim()
  );
}
