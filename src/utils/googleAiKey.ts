/** Prefer localStorage so a saved key works even when build-time env is missing (e.g. first Vercel deploy). */
export function readGeminiApiKey(): string {
  try {
    const stored = localStorage.getItem('roofiq_gemini_key');
    if (stored?.trim()) return stored.trim();
  } catch {
    /* private / blocked storage */
  }
  const env = import.meta.env.VITE_GOOGLE_AI_KEY;
  return typeof env === 'string' && env.trim() ? env.trim() : '';
}
