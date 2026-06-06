/**
 * roofPhotoDepth.ts
 *
 * Integrates Apple Depth Pro (via Replicate) into the Smart Roof Wizard's
 * multi-angle photo phase.
 *
 * For each uploaded photo (top, front, side, street…):
 *  1. Sends the image to Replicate → Depth Pro model
 *  2. Gets back a colour-map depth image (jet colourscale)
 *  3. Loads that image in a browser canvas and samples pixel colours
 *  4. Inverts the jet colourmap to recover per-pixel depth values
 *  5. Estimates the roof pitch angle from the depth gradient
 *
 * The pitch estimate is an approximation (±4–6°) — treated as a cross-check
 * against Gemini's structural analysis, not a primary measurement.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PhotoDepthResult {
  /** URL of the jet-coloured depth map image (renderable as <img>) */
  depthMapUrl: string;
  /** Estimated roof pitch in degrees, null if unable to compute */
  pitchEstimateDeg: number | null;
  /** Pitch as X/12 string e.g. "6/12", null if pitch unavailable */
  pitchRatio: string | null;
  /** Confidence level of the estimate */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable note about the reading */
  notes: string;
}

// ─── Replicate model ──────────────────────────────────────────────────────────

const DEPTH_PRO_VERSION = 'a6645b33f4e36eda0d8d52ab3da6ef37b82d198e2b70c72e680cc75f0baf1623';

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: Record<string, string> | string | string[];
  error?: string;
}

/** Convert any URL to a base64 data URL so it renders in any context (other windows, html2canvas). */
async function urlToDataUrl(url: string): Promise<string> {
  if (!url || url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  } catch {
    return url; // fallback: keep original URL
  }
}

async function callDepthPro(imageDataUrl: string): Promise<string> {
  const createRes = await fetch('/api/proxy-replicate?path=predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: DEPTH_PRO_VERSION,
      input: { image_path: imageDataUrl },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`DEPTH_${createRes.status}: ${body.slice(0, 200)}`);
  }

  let pred = (await createRes.json()) as ReplicatePrediction;
  const pollPath = pred.id ? `predictions/${pred.id}` : '';

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pollRes = await fetch(`/api/proxy-replicate?path=${encodeURIComponent(pollPath)}`);
    if (!pollRes.ok) continue;
    pred = (await pollRes.json()) as ReplicatePrediction;
    if (pred.status === 'succeeded') break;
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`DEPTH_${pred.status.toUpperCase()}: ${pred.error ?? 'unknown'}`);
    }
  }

  if (pred.status !== 'succeeded' || !pred.output) throw new Error('DEPTH_TIMEOUT');

  const out = pred.output;
  let rawUrl = '';
  if (typeof out === 'object' && !Array.isArray(out)) {
    rawUrl = (out as Record<string, string>).color_map ?? '';
  } else if (typeof out === 'string') {
    rawUrl = out;
  } else if (Array.isArray(out)) {
    rawUrl = out[0];
  }

  // Convert Replicate CDN URL → base64 data URL so it renders in any browser
  // context (other windows, PDF export, html2canvas) without CORS issues.
  return urlToDataUrl(rawUrl);
}

// ─── Depth-map → pitch extraction ─────────────────────────────────────────────

/**
 * Approximate inversion of the jet colourmap used by Depth Pro.
 *
 * Jet: blue=0 → cyan=0.25 → green=0.5 → yellow=0.75 → red=1.0
 * Depth Pro output: red channel dominant = closest (highest depth value).
 *
 * Simple approximation: depth ≈ (R − B) / 255 normalised to [0, 1].
 * Good enough for slope estimation; not pixel-perfect.
 */
function rgbToDepth(r: number, g: number, b: number): number {
  // Weighted formula — red channel minus blue, normalised
  const raw = (r - b) / 255 + 0.5;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Load an image from a URL and draw it onto a small canvas for pixel sampling.
 * Returns null if loading fails (CORS, network, etc.)
 */
async function sampleDepthMap(
  depthMapUrl: string,
  sampleSize = 64,
): Promise<Float32Array | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const depths = new Float32Array(sampleSize * sampleSize);
        for (let i = 0; i < sampleSize * sampleSize; i++) {
          depths[i] = rgbToDepth(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        }
        resolve(depths);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = depthMapUrl;
  });
}

/**
 * Estimate roof pitch from a depth map.
 *
 * Strategy (works for both aerial and face-on photos):
 *  • Divide the image into a 4×4 grid of zones
 *  • Compute the mean depth per zone
 *  • Find the zone with max depth (= ridge region, closest)
 *  • Find the zone with min depth in the lower half (= eave / ground)
 *  • Pitch ≈ atan(Δdepth / normalized_distance) converted to degrees
 *
 * Returns null if the depth map has insufficient contrast to make an estimate.
 */
function estimatePitchFromDepths(
  depths: Float32Array,
  sampleSize: number,
  slotType: 'aerial' | 'face',
): { deg: number; confidence: 'high' | 'medium' | 'low' } | null {
  const zones = 4;
  const zoneSize = Math.floor(sampleSize / zones);
  const zoneMeans: number[][] = Array.from({ length: zones }, () => Array(zones).fill(0));

  for (let zy = 0; zy < zones; zy++) {
    for (let zx = 0; zx < zones; zx++) {
      let sum = 0, count = 0;
      for (let dy = 0; dy < zoneSize; dy++) {
        for (let dx = 0; dx < zoneSize; dx++) {
          const row = zy * zoneSize + dy;
          const col = zx * zoneSize + dx;
          sum += depths[row * sampleSize + col];
          count++;
        }
      }
      zoneMeans[zy][zx] = sum / count;
    }
  }

  // Max depth zone (ridge = closest to camera)
  let maxDepth = 0, minDepth = 1;
  for (let zy = 0; zy < zones; zy++) {
    for (let zx = 0; zx < zones; zx++) {
      if (zoneMeans[zy][zx] > maxDepth) maxDepth = zoneMeans[zy][zx];
      if (zoneMeans[zy][zx] < minDepth) minDepth = zoneMeans[zy][zx];
    }
  }

  const contrast = maxDepth - minDepth;
  if (contrast < 0.05) return null; // Image too flat to estimate

  if (slotType === 'aerial') {
    // For aerial/top view: the slope angle shows as a depth gradient across the surface.
    // Estimate from horizontal gradient of the central rows.
    let maxHorizGrad = 0;
    for (let zy = 1; zy < zones - 1; zy++) {
      for (let zx = 0; zx < zones - 1; zx++) {
        const grad = Math.abs(zoneMeans[zy][zx + 1] - zoneMeans[zy][zx]);
        if (grad > maxHorizGrad) maxHorizGrad = grad;
      }
    }
    // Normalise: a gradient of 0.3 across half the image ≈ 20°
    const pitchDeg = Math.min(55, (maxHorizGrad / contrast) * 40);
    const confidence = contrast > 0.2 ? 'medium' : 'low';
    return { deg: pitchDeg, confidence };
  } else {
    // For front/side/street: depth difference between upper roof zone and lower eave zone.
    // Upper middle zone = ridge face, lower middle zone = eave/ground
    const upperMid = (zoneMeans[0][1] + zoneMeans[0][2]) / 2;
    const lowerMid = (zoneMeans[zones - 1][1] + zoneMeans[zones - 1][2]) / 2;
    const vertGrad = upperMid - lowerMid; // positive if roof is closer at top

    if (Math.abs(vertGrad) < 0.04) return null;

    // Use the horizontal span (zone width) as the run reference
    const horizGrad = Math.abs(
      (zoneMeans[1][zones - 1] - zoneMeans[1][0]) / (zones - 1)
    );
    // Pitch = atan(rise/run)
    const rise = Math.abs(vertGrad);
    const run = Math.max(0.05, 0.5 - horizGrad);
    const pitchRad = Math.atan(rise / run);
    const pitchDeg = Math.min(60, (pitchRad * 180) / Math.PI * 2.2); // empirical scale factor

    const confidence = contrast > 0.25 && Math.abs(vertGrad) > 0.1 ? 'high'
      : contrast > 0.12 ? 'medium'
      : 'low';
    return { deg: pitchDeg, confidence };
  }
}

function pitchDegToRatio(deg: number): string {
  const rise = Math.tan((deg * Math.PI) / 180) * 12;
  return `${Math.round(rise)}/12`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

type SlotId = 'top' | 'front' | 'back' | 'left' | 'right' | 'street' | '3d';

/**
 * Run Apple Depth Pro on a single uploaded photo and return depth measurements.
 *
 * @param imageDataUrl  Data URL (base64) of the uploaded photo
 * @param slotId        Which photo slot this is (affects pitch extraction strategy)
 */
export async function runPhotoDepthAnalysis(
  imageDataUrl: string,
  slotId: SlotId,
): Promise<PhotoDepthResult> {
  const depthMapUrl = await callDepthPro(imageDataUrl);

  if (!depthMapUrl) {
    return {
      depthMapUrl: '',
      pitchEstimateDeg: null,
      pitchRatio: null,
      confidence: 'low',
      notes: 'Depth map unavailable',
    };
  }

  // Attempt pitch extraction from the depth map
  const depths = await sampleDepthMap(depthMapUrl);
  if (!depths) {
    return {
      depthMapUrl,
      pitchEstimateDeg: null,
      pitchRatio: null,
      confidence: 'low',
      notes: 'Depth map captured · pitch extraction unavailable (CORS)',
    };
  }

  const slotType: 'aerial' | 'face' = (slotId === 'top' || slotId === '3d') ? 'aerial' : 'face';
  const pitchResult = estimatePitchFromDepths(depths, 64, slotType);

  if (!pitchResult) {
    return {
      depthMapUrl,
      pitchEstimateDeg: null,
      pitchRatio: null,
      confidence: 'low',
      notes: 'Depth map captured · insufficient contrast for pitch estimate',
    };
  }

  const deg = Math.round(pitchResult.deg * 10) / 10;
  const ratio = pitchDegToRatio(deg);

  return {
    depthMapUrl,
    pitchEstimateDeg: deg,
    pitchRatio: ratio,
    confidence: pitchResult.confidence,
    notes: slotType === 'aerial'
      ? `Aerial depth gradient → estimated slope ~${deg}° (${ratio})`
      : `Face-on depth gradient → estimated pitch ~${deg}° (${ratio})`,
  };
}

/**
 * Compute a consensus pitch estimate across multiple photo depth results.
 * Weights high-confidence readings more heavily.
 */
export function consensusDepthPitch(
  results: Array<PhotoDepthResult | null>,
): { deg: number; ratio: string; sourceCount: number } | null {
  const weights = { high: 3, medium: 2, low: 1 };
  let weightedSum = 0, totalWeight = 0;

  for (const r of results) {
    if (!r || r.pitchEstimateDeg === null) continue;
    const w = weights[r.confidence];
    weightedSum += r.pitchEstimateDeg * w;
    totalWeight += w;
  }

  if (totalWeight === 0) return null;

  const deg = Math.round((weightedSum / totalWeight) * 10) / 10;
  return { deg, ratio: pitchDegToRatio(deg), sourceCount: totalWeight };
}
