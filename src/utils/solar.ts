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
    const raw = await res.json() as SolarBuildingInsights & {
      solarPotential?: { roofSegmentStats?: SolarRoofSegment[] };
    };
    // The API nests roofSegmentStats inside solarPotential; hoist it to the top level.
    if (!raw.roofSegmentStats && raw.solarPotential?.roofSegmentStats) {
      raw.roofSegmentStats = raw.solarPotential.roofSegmentStats;
    }
    return raw;
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

/**
 * Convert a Solar roof segment into an azimuth-oriented polygon.
 * Instead of the axis-aligned bounding box (which creates overlapping N-S/E-W
 * rectangles for every segment regardless of slope direction), we build an
 * oriented rectangle whose long axis aligns with the segment's facing direction
 * and whose dimensions match the actual ground-projected area.
 */
export function segmentToBoundingPolygon(
  segment: SolarRoofSegment,
  buildingBox?: SolarBoundingBox
): Array<{ lat: number; lng: number }> {
  const center = segment.center;
  const { sw, ne } = segment.boundingBox;

  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos((center.latitude * Math.PI) / 180);

  // Bounding box dimensions in meters (used only to estimate aspect ratio)
  const bboxWidthM = (ne.longitude - sw.longitude) * metersPerLng;
  const bboxHeightM = (ne.latitude - sw.latitude) * metersPerLat;

  // Ground-projected area (prefer explicit value, fall back from sloped area + pitch)
  const pitchRad = (segment.pitchDegrees * Math.PI) / 180;
  const groundAreaM2 = segment.stats.groundAreaMeters2 ??
    segment.stats.areaMeters2 * Math.cos(pitchRad);
  const safeArea = Math.max(4, groundAreaM2);

  // Azimuth: direction the slope faces (clockwise from North)
  const azRad = (segment.azimuthDegrees * Math.PI) / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);

  // Project bounding box extents onto the azimuth-aligned frame to get aspect ratio
  // (extent_along = run from ridge to eave; extent_perp = width along ridge)
  const extentAlong = Math.abs(sinAz) * bboxWidthM + Math.abs(cosAz) * bboxHeightM;
  const extentPerp  = Math.abs(cosAz) * bboxWidthM + Math.abs(sinAz) * bboxHeightM;
  const aspect = extentPerp / Math.max(0.5, extentAlong); // width / run ratio

  // Size the polygon to the full Solar bbox extent — the per-segment bbox IS the footprint
  // that Solar computed for that facet. Using groundArea underestimates coverage.
  // The sidebar area value comes from segment.stats.areaMeters2 (not polygon geometry),
  // so measurements remain accurate regardless of visual polygon size.
  const hr = extentAlong / 2;
  const hw = extentPerp / 2;

  // Along-azimuth direction in (East, North) meter space: (sinAz, cosAz)
  // Perpendicular direction (90° CW from azimuth): (cosAz, -sinAz)
  // dx = East offset, dy = North offset
  const corners = [
    { dx:  sinAz * hr + cosAz * hw, dy:  cosAz * hr - sinAz * hw },
    { dx:  sinAz * hr - cosAz * hw, dy:  cosAz * hr + sinAz * hw },
    { dx: -sinAz * hr - cosAz * hw, dy: -cosAz * hr + sinAz * hw },
    { dx: -sinAz * hr + cosAz * hw, dy: -cosAz * hr - sinAz * hw },
  ];

  // Clamp each corner to the building-level bounding box so polygons never bleed
  // onto neighbouring properties, driveways, or yards.
  const bLat = buildingBox
    ? { min: buildingBox.sw.latitude, max: buildingBox.ne.latitude }
    : null;
  const bLng = buildingBox
    ? { min: buildingBox.sw.longitude, max: buildingBox.ne.longitude }
    : null;

  return corners.map(({ dx, dy }) => {
    let lat = center.latitude + dy / metersPerLat;
    let lng = center.longitude + dx / metersPerLng;
    if (bLat) lat = Math.min(bLat.max, Math.max(bLat.min, lat));
    if (bLng) lng = Math.min(bLng.max, Math.max(bLng.min, lng));
    return { lat, lng };
  });
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
