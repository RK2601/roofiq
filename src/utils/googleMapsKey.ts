/**
 * Google Maps key: build-time merge (`__ROOFIQ_MAPS_API_KEY__`) then `VITE_GOOGLE_MAPS_API_KEY`, then localStorage.
 */
export function readMapsApiKey(): string {
  const built = (__ROOFIQ_MAPS_API_KEY__ || '').trim();
  if (built) return built;
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

export function formatMapsInitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/InvalidKeyMapError|ApiNotActivatedMapError|RefererNotAllowedMapError/i.test(msg)) {
    return 'Google Maps rejected this API key. In Google Cloud Console enable Maps JavaScript API, Places API, and add your site domain to key restrictions.';
  }
  if (/BillingNotEnabled/i.test(msg)) {
    return 'Google Maps billing is not enabled on your Cloud project. Enable billing and the Maps JavaScript API.';
  }
  if (/drawing/i.test(msg)) {
    return 'Map loaded but drawing tools failed. Enable the Maps JavaScript API; drawing is optional for the wizard search flow.';
  }
  if (msg.length > 10 && msg.length < 280) return msg;
  return 'Failed to initialize map. Check your Google Maps API key, enabled APIs (Maps JavaScript, Places), and domain restrictions.';
}
