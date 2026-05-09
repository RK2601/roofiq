/**
 * Gemini key: build-time merge (`__ROOFIQ_GEMINI_API_KEY__` from vite.config) then `VITE_GOOGLE_AI_KEY`, then localStorage.
 */
export function readGeminiApiKey(): string {
  const built = (__ROOFIQ_GEMINI_API_KEY__ || '').trim();
  if (built) return built;
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
