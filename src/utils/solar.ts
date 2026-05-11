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

interface RawSolarBuildingInsights {
  name?: string;
  center?: SolarLatLng;
  boundingBox?: SolarBoundingBox;
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
  roofSegmentStats?: SolarRoofSegment[];
  solarPotential?: {
    roofSegmentStats?: SolarRoofSegment[];
    imageryDate?: { year: number; month: number; day: number };
    imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
  };
}

export interface SolarDataLayersResponse {
  imageryDate: { year: number; month: number; day: number };
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  dsmUrl?: string;
  rgbUrl?: string;
  annualFluxUrl?: string;
}

export interface SolarSegmentFilterSummary {
  originalCount: number;
  keptCount: number;
  droppedCount: number;
  retainedAreaRatio: number;
}

const SOLAR_API_BASE = 'https://solar.googleapis.com/v1';
const SOLAR_URL_RE = /^https:\/\/solar\.googleapis\.com\//;

function solarProxyUrl(original: string): string {
  if (typeof window === 'undefined') return original;
  if (!SOLAR_URL_RE.test(original)) return original;
  return `${window.location.origin}/api/proxy-solar?u=${encodeURIComponent(original)}`;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two WGS84 points in meters. */
export function haversineDistanceMeters(a: SolarLatLng, b: SolarLatLng): number {
  const r1 = (a.latitude * Math.PI) / 180;
  const r2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(r1) * Math.cos(r2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface SolarValidationResult {
  ok: boolean;
  warnings: string[];
  rejectReason?: string;
}

/**
 * Post-fetch checks: pin vs Solar building center, segment presence.
 * `ok: false` means the UI should reject this response (likely wrong building).
 */
export function validateSolarBuildingInsights(
  insights: SolarBuildingInsights,
  requestLat: number,
  requestLng: number
): SolarValidationResult {
  const warnings: string[] = [];
  const c = insights.center;
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) {
    return { ok: false, warnings, rejectReason: 'Solar response is missing a valid building center.' };
  }
  if (Math.abs(c.latitude) < 1e-8 && Math.abs(c.longitude) < 1e-8) {
    return { ok: false, warnings, rejectReason: 'Solar returned an invalid (zero) building center.' };
  }

  const pin: SolarLatLng = { latitude: requestLat, longitude: requestLng };
  const distM = haversineDistanceMeters(pin, c);
  const hardRejectM = 450;
  const warnOffsetM = 55;
  if (distM > hardRejectM) {
    return {
      ok: false,
      warnings,
      rejectReason: `Solar building center is about ${Math.round(distM)} m from the map pin — likely a different building. Adjust the pin or address.`,
    };
  }
  if (distM > warnOffsetM) {
    warnings.push(
      `Solar center is ~${Math.round(distM)} m from your pin — confirm this is the intended building.`
    );
  }

  const segs = insights.roofSegmentStats ?? [];
  if (segs.length === 0) {
    warnings.push(
      'Solar returned no roof segments for this building. Trace sections manually, use the wizard, or capture drone imagery for survey-grade work.'
    );
  }

  return { ok: true, warnings };
}

export type SolarRequiredQuality = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FetchBuildingInsightsOptions {
  /** Passed to `requiredQuality` on the Solar API (default LOW). */
  requiredQuality?: SolarRequiredQuality;
}

function normalizeBuildingInsights(raw: RawSolarBuildingInsights): SolarBuildingInsights {
  const roofSegmentStats = raw.roofSegmentStats ?? raw.solarPotential?.roofSegmentStats ?? [];
  const imageryDate =
    raw.imageryDate ??
    raw.solarPotential?.imageryDate ?? {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      day: new Date().getDate(),
    };
  const imageryQuality = raw.imageryQuality ?? raw.solarPotential?.imageryQuality ?? 'LOW';

  return {
    name: raw.name ?? 'buildingInsights',
    center: raw.center ?? { latitude: 0, longitude: 0 },
    boundingBox:
      raw.boundingBox ?? {
        sw: raw.center ?? { latitude: 0, longitude: 0 },
        ne: raw.center ?? { latitude: 0, longitude: 0 },
      },
    imageryDate,
    imageryQuality,
    roofSegmentStats,
  };
}

export function filterUsableRoofSegments(segments: SolarRoofSegment[]): {
  segments: SolarRoofSegment[];
  summary: SolarSegmentFilterSummary;
} {
  const toSummary = (
    originalCount: number,
    keptCount: number,
    droppedCount: number,
    retainedAreaRatio: number
  ): SolarSegmentFilterSummary => ({
    originalCount,
    keptCount,
    droppedCount,
    retainedAreaRatio: Math.max(0, Math.min(1, retainedAreaRatio)),
  });

  const azimuthGap = (a: number, b: number) => {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  };

  const normalized = segments.filter(
    segment => Number.isFinite(segment.stats.areaMeters2) && segment.stats.areaMeters2 > 0
  );
  const normalizedArea = normalized.reduce((sum, segment) => sum + segment.stats.areaMeters2, 0);
  if (normalized.length <= 1) {
    return {
      segments: normalized,
      summary: toSummary(
        segments.length,
        normalized.length,
        Math.max(0, segments.length - normalized.length),
        normalizedArea > 0 ? 1 : 0
      ),
    };
  }

  const sorted = [...normalized].sort((a, b) => b.stats.areaMeters2 - a.stats.areaMeters2);
  const totalArea = sorted.reduce((sum, segment) => sum + segment.stats.areaMeters2, 0);
  const areaThreshold = Math.max(4, totalArea * 0.0125);
  const large = sorted.filter(segment => segment.stats.areaMeters2 >= areaThreshold);
  const candidates = large.length > 0 ? large : sorted;

  const selected: SolarRoofSegment[] = [];
  let coveredArea = 0;
  const maxSegments = 10;
  const targetCoverage = 0.96;

  for (const segment of candidates) {
    if (selected.length >= maxSegments) break;
    const sameOrientation = selected.some(existing => {
      const pitchClose = Math.abs(existing.pitchDegrees - segment.pitchDegrees) < 2.2;
      const azimuthClose = azimuthGap(existing.azimuthDegrees, segment.azimuthDegrees) < 15;
      const areaRatio = segment.stats.areaMeters2 / existing.stats.areaMeters2;
      return pitchClose && azimuthClose && areaRatio < 0.22;
    });

    // Ignore tiny duplicate slivers that mirror larger planes.
    if (sameOrientation && segment.stats.areaMeters2 < totalArea * 0.06) continue;

    selected.push(segment);
    coveredArea += segment.stats.areaMeters2;
    if (coveredArea / totalArea >= targetCoverage && selected.length >= 2) break;
  }

  const fallback = selected.length > 0 ? selected : sorted.slice(0, Math.min(2, sorted.length));
  const retainedArea = fallback.reduce((sum, segment) => sum + segment.stats.areaMeters2, 0);

  return {
    segments: fallback,
    summary: toSummary(
      segments.length,
      fallback.length,
      Math.max(0, segments.length - fallback.length),
      totalArea > 0 ? retainedArea / totalArea : 0
    ),
  };
}

export async function fetchBuildingInsights(
  lat: number,
  lng: number,
  apiKey: string,
  options?: FetchBuildingInsightsOptions
): Promise<SolarBuildingInsights | null> {
  const requiredQuality = options?.requiredQuality ?? 'LOW';
  const url =
    `${SOLAR_API_BASE}/buildingInsights:findClosest?location.latitude=${lat}` +
    `&location.longitude=${lng}&requiredQuality=${requiredQuality}&key=${apiKey}`;

  const tryFetch = async (u: string): Promise<SolarBuildingInsights> => {
    const res = await fetch(u);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SOLAR_HTTP_${res.status}: ${body.slice(0, 120)}`);
    }
    const raw = (await res.json()) as RawSolarBuildingInsights;
    return normalizeBuildingInsights(raw);
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
  apiKey: string,
  options?: FetchBuildingInsightsOptions
): Promise<SolarDataLayersResponse | null> {
  const requiredQuality = options?.requiredQuality ?? 'LOW';
  const url =
    `${SOLAR_API_BASE}/dataLayers:get?location.latitude=${lat}` +
    `&location.longitude=${lng}&radiusMeters=${radiusMeters}&requiredQuality=${requiredQuality}&key=${apiKey}`;

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
      dsmLayer?: { geoTiffUrl?: string };
      rgbUrl?: string;
      rgbLayer?: { geoTiffUrl?: string; imageUrl?: string };
      annualFluxUrl?: string;
      annualFluxLayer?: { geoTiffUrl?: string };
    };
    if (!json.imageryDate || !json.imageryQuality) return null;
    return {
      imageryDate: json.imageryDate,
      imageryQuality: json.imageryQuality,
      dsmUrl: json.dsmUrl ?? json.dsmLayer?.geoTiffUrl,
      rgbUrl: json.rgbUrl ?? json.rgbLayer?.geoTiffUrl ?? json.rgbLayer?.imageUrl,
      annualFluxUrl: json.annualFluxUrl ?? json.annualFluxLayer?.geoTiffUrl,
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

function clampAzimuth(deg: number): number {
  const normalized = deg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function estimateGroundAreaMeters2(segment: SolarRoofSegment): number {
  if (typeof segment.stats.groundAreaMeters2 === 'number' && segment.stats.groundAreaMeters2 > 0) {
    return segment.stats.groundAreaMeters2;
  }
  const pitchRad = (segment.pitchDegrees * Math.PI) / 180;
  return Math.max(0.5, segment.stats.areaMeters2 * Math.cos(pitchRad));
}

export function computeDominantAzimuth(segments: SolarRoofSegment[]): number | null {
  if (segments.length === 0) return null;
  const weighted = segments
    .filter(s => Number.isFinite(s.azimuthDegrees))
    .map(segment => ({
      area: Math.max(0.1, estimateGroundAreaMeters2(segment)),
      azimuthRad: (clampAzimuth(segment.azimuthDegrees) * Math.PI) / 180,
    }));
  if (weighted.length === 0) return null;
  const x = weighted.reduce((sum, item) => sum + Math.cos(item.azimuthRad) * item.area, 0);
  const y = weighted.reduce((sum, item) => sum + Math.sin(item.azimuthRad) * item.area, 0);
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return null;
  return clampAzimuth((Math.atan2(y, x) * 180) / Math.PI);
}

/** Convert Solar roof segments into better-fit map polygons (oriented when possible). */
export function segmentToBoundingPolygon(
  segment: SolarRoofSegment,
  options?: { dominantAzimuthDegrees?: number | null }
): Array<{ lat: number; lng: number }> {
  const { sw, ne } = segment.boundingBox;
  const centerLat = segment.center.latitude;
  const centerLng = segment.center.longitude;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const spanX = Math.max(1, (ne.longitude - sw.longitude) * metersPerDegLng);
  const spanY = Math.max(1, (ne.latitude - sw.latitude) * metersPerDegLat);
  const areaTarget = estimateGroundAreaMeters2(segment);
  const approxRectArea = spanX * spanY;
  const areaScale = Math.sqrt(Math.max(0.7, Math.min(1, areaTarget / Math.max(1, approxRectArea))));
  const width = spanX * areaScale;
  const height = spanY * areaScale;

  const preferredAzimuth = Number.isFinite(segment.azimuthDegrees)
    ? segment.azimuthDegrees
    : typeof options?.dominantAzimuthDegrees === 'number'
      ? options.dominantAzimuthDegrees
      : 0;
  const angleRad = (clampAzimuth(preferredAzimuth) * Math.PI) / 180;
  const ux = Math.sin(angleRad);
  const uy = Math.cos(angleRad);
  const vx = -uy;
  const vy = ux;

  const hw = width / 2;
  const hh = height / 2;
  const cornersMeters = [
    { x: -hw * ux - hh * vx, y: -hw * uy - hh * vy },
    { x: hw * ux - hh * vx, y: hw * uy - hh * vy },
    { x: hw * ux + hh * vx, y: hw * uy + hh * vy },
    { x: -hw * ux + hh * vx, y: -hw * uy + hh * vy },
  ];

  const rotated = cornersMeters.map(p => ({
    lat: centerLat + p.y / metersPerDegLat,
    lng: centerLng + p.x / metersPerDegLng,
  }));

  const insideBounds = rotated.every(
    point =>
      point.lat >= sw.latitude &&
      point.lat <= ne.latitude &&
      point.lng >= sw.longitude &&
      point.lng <= ne.longitude
  );
  if (insideBounds) return rotated;

  // Safety fallback: keep the facet within the API segment bbox.
  const halfLat = (height / 2) / metersPerDegLat;
  const halfLng = (width / 2) / metersPerDegLng;
  return [
    { lat: centerLat - halfLat, lng: centerLng - halfLng },
    { lat: centerLat + halfLat, lng: centerLng - halfLng },
    { lat: centerLat + halfLat, lng: centerLng + halfLng },
    { lat: centerLat - halfLat, lng: centerLng + halfLng },
  ].map(point => ({
    lat: Math.min(ne.latitude, Math.max(sw.latitude, point.lat)),
    lng: Math.min(ne.longitude, Math.max(sw.longitude, point.lng)),
  }));
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
