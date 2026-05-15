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

/** Only Solar API download URLs need `key=`; signed storage.googleapis.com links must stay untouched. */
function appendSolarApiKeyToDownloadUrl(url: string, apiKey: string): string {
  if (!url.includes('solar.googleapis.com') || url.includes('key=')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${apiKey}`;
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
    const urlWithKey = appendSolarApiKeyToDownloadUrl(dsmUrl, apiKey);
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

// ─── Auto-segmentation ────────────────────────────────────────────────────────

export interface AutoDetectedSegment {
  path: { lat: number; lng: number }[];
  pitchDeg: number;
  pitchRatio: string;
  facingDirection: string;
  aspectDeg: number;
  pixelCount: number;
  /** 0–1: how tightly this cluster is grouped in slope/aspect space. */
  confidence: number;
}

/** Circular (angular) difference — returns value in [0, 180]. */
function circularDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * DBSCAN clustering on (slope, aspect) for roof-plane grouping.
 * Returns a label array (same length as `pixels`); -1 = noise.
 */
function dbscanCluster(
  pixels: Array<{ slope: number; aspect: number; col: number; row: number }>,
  slopeTolerance: number,
  aspectTolerance: number,
  minPoints: number,
): number[] {
  const n = pixels.length;
  const labels = new Array<number>(n).fill(-2); // -2 = unvisited
  let clusterId = 0;

  const neighbors = (idx: number): number[] => {
    const p = pixels[idx];
    const result: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      const q = pixels[j];
      if (
        Math.abs(p.slope - q.slope) <= slopeTolerance &&
        circularDiff(p.aspect, q.aspect) <= aspectTolerance
      ) {
        result.push(j);
      }
    }
    return result;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighbors(i);
    if (nb.length < minPoints) {
      labels[i] = -1; // noise
      continue;
    }
    labels[i] = clusterId;
    const seeds = [...nb];
    while (seeds.length > 0) {
      const s = seeds.shift()!;
      if (labels[s] === -1) labels[s] = clusterId; // was noise → border
      if (labels[s] !== -2) continue;
      labels[s] = clusterId;
      const sNb = neighbors(s);
      if (sNb.length >= minPoints) seeds.push(...sNb);
    }
    clusterId++;
  }

  return labels;
}

/**
 * Gift-wrapping (Jarvis march) convex hull on 2D points.
 * Input/output: [col, row] pairs.
 */
function convexHull(points: [number, number][]): [number, number][] {
  const n = points.length;
  if (n < 3) return points;

  // Find leftmost point
  let startIdx = 0;
  for (let i = 1; i < n; i++) {
    if (points[i][0] < points[startIdx][0]) startIdx = i;
  }

  const hull: [number, number][] = [];
  let current = startIdx;

  for (;;) {
    hull.push(points[current]);
    let next = 0;
    for (let i = 1; i < n; i++) {
      if (next === current) { next = i; continue; }
      const [cx, cy] = points[current];
      const [nx, ny] = points[next];
      const [ix, iy] = points[i];
      // Cross product: positive → i is more counter-clockwise than next
      const cross = (nx - cx) * (iy - cy) - (ny - cy) * (ix - cx);
      if (cross < 0) next = i;
    }
    current = next;
    if (current === startIdx) break;
    if (hull.length > n) break; // safety
  }

  return hull;
}

/**
 * Flood-fill connectivity check: splits a set of pixel (col,row) into
 * spatially connected components. Returns array of index-sets (one per component).
 */
function spatialComponents(
  pixelIndices: number[],
  pixels: Array<{ col: number; row: number }>,
): number[][] {
  const indexSet = new Set(pixelIndices);
  // Build a col,row → pixelIndex lookup for fast neighbor queries
  const lookup = new Map<string, number>();
  for (const idx of pixelIndices) lookup.set(`${pixels[idx].col},${pixels[idx].row}`, idx);

  const visited = new Set<number>();
  const components: number[][] = [];

  for (const start of pixelIndices) {
    if (visited.has(start)) continue;
    const comp: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      const { col, row } = pixels[cur];
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const key = `${col + dc},${row + dr}`;
        const nb = lookup.get(key);
        if (nb !== undefined && !visited.has(nb) && indexSet.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

/**
 * Automatically detects roof planes from a Google Solar DSM GeoTIFF.
 * Returns one polygon per detected plane, with pitch/aspect/area metadata.
 *
 * Algorithm:
 *  1. Fetch + parse the DSM raster (same as analyzeDsmForSegments)
 *  2. Compute slope + aspect per pixel using finite-difference gradient
 *  3. Filter to building bounding-box pixels with slope ≥ 5° (excludes ground/flat)
 *  4. DBSCAN cluster on (slope, aspect) — pixels on the same plane share both
 *  5. Split spatially disconnected clusters (e.g. front/back south-facing slopes)
 *  6. Convex hull per spatial component → polygon in lat/lng
 */
export async function autoSegmentRoofPlanes(
  dsmUrl: string,
  buildingBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  apiKey: string,
): Promise<AutoDetectedSegment[]> {
  try {
    const urlWithKey = appendSolarApiKeyToDownloadUrl(dsmUrl, apiKey);
    const proxied = `/api/proxy-solar?u=${encodeURIComponent(urlWithKey)}`;

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

    const { fromArrayBuffer } = await import('geotiff');
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const [minLng, minLat, maxLng, maxLat] = image.getBoundingBox() as [number, number, number, number];
    const width = image.getWidth();
    const height = image.getHeight();
    const rasters = (await image.readRasters({ interleave: false })) as { [key: number]: Float32Array };
    const elevBand = rasters[0];

    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;
    const midLat = (minLat + maxLat) / 2;
    const resLng = (lngSpan * 111_320 * Math.cos((midLat * Math.PI) / 180)) / width;
    const resLat = (latSpan * 111_320) / height;
    const resM = (resLng + resLat) / 2;

    // Clip to building bounding box in pixel space
    const bMinCol = Math.max(0, Math.floor(((buildingBounds.minLng - minLng) / lngSpan) * width));
    const bMaxCol = Math.min(width - 1, Math.ceil(((buildingBounds.maxLng - minLng) / lngSpan) * width));
    const bMinRow = Math.max(0, Math.floor(((maxLat - buildingBounds.maxLat) / latSpan) * height));
    const bMaxRow = Math.min(height - 1, Math.ceil(((maxLat - buildingBounds.minLat) / latSpan) * height));

    // Collect roof pixels: slope ≥ 5°, finite elevation
    type RoofPixel = { col: number; row: number; slope: number; aspect: number; lat: number; lng: number };
    const roofPixels: RoofPixel[] = [];

    for (let row = bMinRow; row <= bMaxRow; row++) {
      for (let col = bMinCol; col <= bMaxCol; col++) {
        const idx = row * width + col;
        const elev = elevBand[idx];
        if (!Number.isFinite(elev) || elev < -500) continue;

        const cL = Math.max(0, col - 1), cR = Math.min(width - 1, col + 1);
        const rU = Math.max(0, row - 1), rD = Math.min(height - 1, row + 1);
        const dxE = (elevBand[row * width + cR] - elevBand[row * width + cL]) / ((cR - cL) * resM);
        const dyS = (elevBand[rD * width + col] - elevBand[rU * width + col]) / ((rD - rU) * resM);
        const slope = Math.atan(Math.hypot(dxE, dyS)) * (180 / Math.PI);
        if (slope < 5) continue; // flat ground / noise

        const aspect = (Math.atan2(-dyS, dxE) * (180 / Math.PI) + 360) % 360;
        const lat = maxLat - (row + 0.5) * (latSpan / height);
        const lng = minLng + (col + 0.5) * (lngSpan / width);
        roofPixels.push({ col, row, slope, aspect, lat, lng });
      }
    }

    if (roofPixels.length < 30) return [];

    // DBSCAN: group by similar slope + aspect
    // Use subsampling for performance when raster is large
    const subsampleStep = Math.max(1, Math.floor(Math.sqrt(roofPixels.length / 2000)));
    const sample = roofPixels.filter((_, i) => i % subsampleStep === 0);
    const labels = dbscanCluster(sample, 4, 20, Math.max(5, Math.floor(30 / subsampleStep)));

    // Collect cluster index sets from the sample
    const clusterMap = new Map<number, number[]>();
    for (let i = 0; i < sample.length; i++) {
      const lbl = labels[i];
      if (lbl < 0) continue;
      if (!clusterMap.has(lbl)) clusterMap.set(lbl, []);
      clusterMap.get(lbl)!.push(i);
    }

    const results: AutoDetectedSegment[] = [];

    for (const [, indices] of clusterMap) {
      if (indices.length < 8) continue;

      // Split into spatially connected components
      const components = spatialComponents(indices, sample);

      for (const comp of components) {
        if (comp.length < 8) continue;

        const compPixels = comp.map(i => sample[i]);
        const slopes = compPixels.map(p => p.slope);
        const aspects = compPixels.map(p => p.aspect);
        const medSlope = median(slopes);
        const medAspect = median(aspects);

        // Confidence: inverse of slope stddev normalised to [0,1]
        const slopeMean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
        const slopeStd = Math.sqrt(slopes.reduce((s, v) => s + (v - slopeMean) ** 2, 0) / slopes.length);
        const confidence = Math.max(0.1, Math.min(1, 1 - slopeStd / 10));

        // Convex hull in pixel space → convert to lat/lng
        const hullPixels = convexHull(compPixels.map(p => [p.col, p.row] as [number, number]));
        const path = hullPixels.map(([col, row]) => ({
          lat: maxLat - (row + 0.5) * (latSpan / height),
          lng: minLng + (col + 0.5) * (lngSpan / width),
        }));

        if (path.length < 3) continue;

        results.push({
          path,
          pitchDeg: Math.round(medSlope * 10) / 10,
          pitchRatio: pitchDegToRatio(medSlope),
          facingDirection: aspectToCardinal(medAspect),
          aspectDeg: Math.round(medAspect),
          pixelCount: compPixels.length * subsampleStep,
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }

    // Sort by pixel count descending (largest planes first) and cap at 8 segments
    return results
      .sort((a, b) => b.pixelCount - a.pixelCount)
      .slice(0, 8);

  } catch (err) {
    console.warn('[RoofDSM] Auto-segmentation failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
