/**
 * Google Maps key: non-empty `VITE_GOOGLE_MAPS_API_KEY` from `.env` / build wins first
 * (so local dev uses `.env` instead of a stale browser-saved key). Falls back to localStorage.
 */
export function readMapsApiKey(): string {
  const env = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  try {
    const stored = localStorage.getItem('roofiq_gmaps_key');
    if (stored?.trim()) return stored.trim();
  } catch {
    /* private / blocked storage */
  }
  return '';
}
