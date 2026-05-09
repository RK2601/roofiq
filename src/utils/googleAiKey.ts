/**
 * Gemini key: non-empty `VITE_GOOGLE_AI_KEY` from `.env` / build wins first, then localStorage.
 */
export function readGeminiApiKey(): string {
  const env = import.meta.env.VITE_GOOGLE_AI_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  try {
    const stored = localStorage.getItem('roofiq_gemini_key');
    if (stored?.trim()) return stored.trim();
  } catch {
    /* private / blocked storage */
  }
  return '';
}
