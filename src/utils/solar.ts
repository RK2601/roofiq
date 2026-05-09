import { PITCH_OPTIONS } from './roofCalculations';

export interface SolarLatLng {
  latitude: number;
  longitude: number;
}

export interface SolarBoundingBox {
  sw: SolarLatLng;
  ne: SolarLatLng;
}

export interface SolarRoofSegment {
  pitchDegrees: number;
  azimuthDegrees: number;
  stats: {
    areaMeters2: number;
    groundAreaMeters2?: number;
  };
  center: SolarLatLng;
  boundingBox: SolarBoundingBox;
  planeHeightAtCenterMeters?: number;
}

export interface SolarBuildingInsights {
  name: string;
  center: SolarLatLng;
  boundingBox: SolarBoundingBox;
  imageryDate: { year: number; month: number; day: number };
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  roofSegmentStats?: SolarRoofSegment[];
}

export interface SolarDataLayersResponse {
  imageryDate: { year: number; month: number; day: number };
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  dsmUrl?: string;
  rgbUrl?: string;
  annualFluxUrl?: string;
}

const SOLAR_API_BASE = 'https://solar.googleapis.com/v1';
const SOLAR_URL_RE = /^https:\/\/solar\.googleapis\.com\//;

function solarProxyUrl(original: string): string {
  if (typeof window === 'undefined') return original;
  if (!SOLAR_URL_RE.test(original)) return original;
  return `${window.location.origin}/api/proxy-solar?u=${encodeURIComponent(original)}`;
}

export async function fetchBuildingInsights(
  lat: number,
  lng: number,
  apiKey: string
): Promise<SolarBuildingInsights | null> {
  const url = `${SOLAR_API_BASE}/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${apiKey}`;

  const tryFetch = async (u: string): Promise<SolarBuildingInsights> => {
    const res = await fetch(u);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SOLAR_HTTP_${res.status}: ${body.slice(0, 120)}`);
    }
    return res.json() as Promise<SolarBuildingInsights>;
  };

  try {
    return await tryFetch(solarProxyUrl(url));
  } catch (proxyErr) {
    try {
      return await tryFetch(url);
    } catch {
      throw proxyErr;
    }
  }
}

/** Phase 2 prep: fetches Solar data layer metadata (DSM/RGB URLs when available). */
export async function fetchDataLayers(
  lat: number,
  lng: number,
  radiusMeters: number,
  apiKey: string
): Promise<SolarDataLayersResponse | null> {
  const url =
    `${SOLAR_API_BASE}/dataLayers:get?location.latitude=${lat}` +
    `&location.longitude=${lng}&radiusMeters=${radiusMeters}&requiredQuality=LOW&key=${apiKey}`;

  const tryFetch = async (u: string): Promise<SolarDataLayersResponse | null> => {
    const res = await fetch(u);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SOLAR_DATALAYERS_HTTP_${res.status}: ${body.slice(0, 120)}`);
    }
    const json = (await res.json()) as {
      imageryDate?: { year: number; month: number; day: number };
      imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
      dsmUrl?: string;
      rgbUrl?: string;
      annualFluxUrl?: string;
    };
    if (!json.imageryDate || !json.imageryQuality) return null;
    return {
      imageryDate: json.imageryDate,
      imageryQuality: json.imageryQuality,
      dsmUrl: json.dsmUrl,
      rgbUrl: json.rgbUrl,
      annualFluxUrl: json.annualFluxUrl,
    };
  };

  try {
    return await tryFetch(solarProxyUrl(url));
  } catch {
    try {
      return await tryFetch(url);
    } catch {
      return null;
    }
  }
}

/** Convert Solar API pitch degrees to the nearest PITCH_OPTIONS entry. */
export function pitchDegreesToOption(degrees: number): (typeof PITCH_OPTIONS)[number] {
  // rise/12 = tan(degrees)
  const rise = Math.tan((degrees * Math.PI) / 180) * 12;
  let best = PITCH_OPTIONS[0];
  let bestDiff = Infinity;
  for (const opt of PITCH_OPTIONS) {
    const optRise = parseFloat(opt.value.split('/')[0]);
    const diff = Math.abs(optRise - rise);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

/** Convert Solar roof segment bounding boxes into map polygon paths (4-corner rectangles). */
export function segmentToBoundingPolygon(
  segment: SolarRoofSegment
): Array<{ lat: number; lng: number }> {
  const { sw, ne } = segment.boundingBox;
  return [
    { lat: sw.latitude, lng: sw.longitude },
    { lat: ne.latitude, lng: sw.longitude },
    { lat: ne.latitude, lng: ne.longitude },
    { lat: sw.latitude, lng: ne.longitude },
  ];
}

/** Azimuth degrees → human-readable cardinal direction. */
export function azimuthLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/** Format Solar imagery date as a readable string. */
export function formatImageryDate(d: SolarBuildingInsights['imageryDate']): string {
  return new Date(d.year, d.month - 1, d.day).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
