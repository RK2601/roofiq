/**
 * DSM (Digital Surface Model) analysis using Google Solar API GeoTIFF data.
 * Computes actual pitch, facing direction, true 3D area, and height measurements
 * from the 0.1 m/pixel elevation raster — far more accurate than AI estimates.
 */

export interface DsmSegmentMetrics {
  segmentIndex: number;
  pitchDeg: number;
  pitchRatio: string;
  aspectDeg: number;
  facingDirection: string;
  sloped3dAreaSqFt: number;
  groundAreaSqFt: number;
  ridgeElevationFt: number;
  eaveElevationFt: number;
  heightDiffFt: number;
  pixelCount: number;
}

export interface DsmAnalysisResult {
  segments: DsmSegmentMetrics[];
  overallPitchDeg: number;
  overallFacingDirection: string;
  totalSloped3dAreaSqFt: number;
  totalGroundAreaSqFt: number;
  dsmResolutionM: number;
}

function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function aspectToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) / 45) % 8];
}

export function pitchDegToRatio(deg: number): string {
  if (deg < 0.5) return 'flat';
  const rise = Math.tan((deg * Math.PI) / 180) * 12;
  const rounded = Math.max(1, Math.min(12, Math.round(rise)));
  return `${rounded}/12`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function analyzeDsmForSegments(
  dsmUrl: string,
  segments: Array<{ lat: number; lng: number }[]>,
  apiKey: string
): Promise<DsmAnalysisResult | null> {
  try {
    // Ensure API key is in URL
    const sep = dsmUrl.includes('?') ? '&' : '?';
    const urlWithKey = dsmUrl.includes('key=') ? dsmUrl : `${dsmUrl}${sep}key=${apiKey}`;
    const proxied = `/api/proxy-solar?u=${encodeURIComponent(urlWithKey)}`;

    // Fetch GeoTIFF with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let buffer: ArrayBuffer;
    try {
      const res = await fetch(proxied, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`DSM_HTTP_${res.status}`);
      buffer = await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }

    // Dynamic import keeps geotiff out of the initial bundle
    const { fromArrayBuffer } = await import('geotiff');
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    // getBoundingBox returns [minLng, minLat, maxLng, maxLat] for WGS84 GeoTIFFs
    const [minLng, minLat, maxLng, maxLat] = image.getBoundingBox() as [number, number, number, number];
    const width = image.getWidth();
    const height = image.getHeight();

    const rasters = (await image.readRasters({ interleave: false })) as { [key: number]: Float32Array };
    const elevBand = rasters[0];

    // Pixel resolution in metres
    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;
    const midLat = (minLat + maxLat) / 2;
    const resLng = (lngSpan * 111_320 * Math.cos((midLat * Math.PI) / 180)) / width;
    const resLat = (latSpan * 111_320) / height;
    const resM = (resLng + resLat) / 2;

    const lngToCol = (lng: number) => ((lng - minLng) / lngSpan) * width;
    const latToRow = (lat: number) => ((maxLat - lat) / latSpan) * height;

    const segmentMetrics: DsmSegmentMetrics[] = segments.map((path, segIdx) => {
      const pixelPoly: [number, number][] = path.map(p => [lngToCol(p.lng), latToRow(p.lat)]);
      const pxCols = pixelPoly.map(p => p[0]);
      const pxRows = pixelPoly.map(p => p[1]);
      const minCol = Math.max(0, Math.floor(Math.min(...pxCols)));
      const maxCol = Math.min(width - 1, Math.ceil(Math.max(...pxCols)));
      const minRow = Math.max(0, Math.floor(Math.min(...pxRows)));
      const maxRow = Math.min(height - 1, Math.ceil(Math.max(...pxRows)));

      const elevations: number[] = [];
      const slopeArr: number[] = [];
      const aspectArr: number[] = [];

      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          if (!pointInPolygon(col + 0.5, row + 0.5, pixelPoly)) continue;
          const idx = row * width + col;
          const elev = elevBand[idx];
          if (!Number.isFinite(elev) || elev < -500) continue;

          elevations.push(elev);

          // Finite-difference gradient in m/m
          const cL = Math.max(0, col - 1);
          const cR = Math.min(width - 1, col + 1);
          const rU = Math.max(0, row - 1);
          const rD = Math.min(height - 1, row + 1);
          const dxE = (elevBand[row * width + cR] - elevBand[row * width + cL]) / ((cR - cL) * resM);
          const dyS = (elevBand[rD * width + col] - elevBand[rU * width + col]) / ((rD - rU) * resM);

          slopeArr.push(Math.atan(Math.hypot(dxE, dyS)) * (180 / Math.PI));
          // Aspect: 0° = East, increasing CCW; convert to compass (0° = North CW)
          aspectArr.push((Math.atan2(-dyS, dxE) * (180 / Math.PI) + 360) % 360);
        }
      }

      if (elevations.length === 0) {
        return {
          segmentIndex: segIdx,
          pitchDeg: 0, pitchRatio: 'flat', aspectDeg: 0, facingDirection: 'N',
          sloped3dAreaSqFt: 0, groundAreaSqFt: 0,
          ridgeElevationFt: 0, eaveElevationFt: 0, heightDiffFt: 0,
          pixelCount: 0,
        };
      }

      const medSlope = median(slopeArr);
      const medAspect = median(aspectArr);
      const groundM2 = elevations.length * resM * resM;
      const groundSqFt = groundM2 * 10.7639;
      const sloped3dSqFt = groundSqFt / Math.max(Math.cos((medSlope * Math.PI) / 180), 0.05);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      const M_TO_FT = 3.28084;

      return {
        segmentIndex: segIdx,
        pitchDeg: Math.round(medSlope * 10) / 10,
        pitchRatio: pitchDegToRatio(medSlope),
        aspectDeg: Math.round(medAspect),
        facingDirection: aspectToCardinal(medAspect),
        sloped3dAreaSqFt: Math.round(sloped3dSqFt),
        groundAreaSqFt: Math.round(groundSqFt),
        ridgeElevationFt: Math.round(maxElev * M_TO_FT * 10) / 10,
        eaveElevationFt: Math.round(minElev * M_TO_FT * 10) / 10,
        heightDiffFt: Math.round((maxElev - minElev) * M_TO_FT * 10) / 10,
        pixelCount: elevations.length,
      };
    });

    const valid = segmentMetrics.filter(s => s.pixelCount > 0);
    const totalPx = valid.reduce((s, m) => s + m.pixelCount, 0);
    const wPitch = totalPx > 0
      ? valid.reduce((s, m) => s + m.pitchDeg * m.pixelCount, 0) / totalPx : 0;
    const wAspect = totalPx > 0
      ? valid.reduce((s, m) => s + m.aspectDeg * m.pixelCount, 0) / totalPx : 0;

    return {
      segments: segmentMetrics,
      overallPitchDeg: Math.round(wPitch * 10) / 10,
      overallFacingDirection: aspectToCardinal(wAspect),
      totalSloped3dAreaSqFt: Math.round(valid.reduce((s, m) => s + m.sloped3dAreaSqFt, 0)),
      totalGroundAreaSqFt: Math.round(valid.reduce((s, m) => s + m.groundAreaSqFt, 0)),
      dsmResolutionM: Math.round(resM * 100) / 100,
    };
  } catch (err) {
    console.warn('[RoofDSM] Analysis failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
