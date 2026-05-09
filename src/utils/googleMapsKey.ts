/** Prefer localStorage so a key saved in the app is not overridden by an empty build-time env (e.g. Vercel). */
export function readMapsApiKey(): string {
  try {
    const stored = localStorage.getItem('roofiq_gmaps_key');
    if (stored?.trim()) return stored.trim();
  } catch {
    /* private / blocked storage */
  }
  const env = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  return typeof env === 'string' && env.trim() ? env.trim() : '';
}
