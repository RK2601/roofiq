import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { GenerateContentResult, Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import { isGemini429OrQuotaError, withGemini429Retries } from './gemini429';
import type { AiRoofCue, Vec2 } from './roofStructure';
import type { SolarBuildingInsights, SolarLatLng, SolarRoofSegment } from './solar';
import { filterUsableRoofSegments } from './solar';
import { callOpenAiFallbackJson } from './openaiFallback';

const METERS_PER_DEG_LAT = 111_320;
const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/;
const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
] as const;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const ROOF_CUE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    cues: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: ['ridge', 'hip', 'valley', 'eave', 'rake'],
          },
          x1: { type: SchemaType.NUMBER },
          y1: { type: SchemaType.NUMBER },
          x2: { type: SchemaType.NUMBER },
          y2: { type: SchemaType.NUMBER },
          confidence: { type: SchemaType.NUMBER },
        },
        required: ['type', 'x1', 'y1', 'x2', 'y2', 'confidence'],
      },
    },
  },
  required: ['cues'],
};

export interface VisionCueRaw {
  type: 'ridge' | 'hip' | 'valley' | 'eave' | 'rake';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

/** Geographic corners of the static map image (north-up). Used to map Gemini [0,1] cues to meters. */
export interface StaticMapImageBounds {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
}

export interface AutoMapViewCapture {
  id: string;
  label: string;
  url: string;
  /** When set (visible= captures), normalized image coords map to this rectangle instead of Solar boundingBox. */
  imageBounds?: StaticMapImageBounds | null;
}

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

function latLngToMeters(point: SolarLatLng, origin: SolarLatLng): Vec2 {
  return {
    x: (point.longitude - origin.longitude) * metersPerDegLng(origin.latitude),
    y: (point.latitude - origin.latitude) * METERS_PER_DEG_LAT,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function staticMapProxyUrl(original: string): string {
  if (typeof window === 'undefined') return original;
  if (!STATIC_MAP_URL_RE.test(original)) return original;
  return `${window.location.origin}/api/proxy-static-map?u=${encodeURIComponent(original)}`;
}

async function blobToBase64(blob: Blob): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const raw = reader.result as string;
      const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
      if (!base64) reject(new Error('IMAGE_EMPTY'));
      else resolve({ data: base64, mimeType: blob.type || 'image/png' });
    };
    reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
    reader.readAsDataURL(blob);
  });
}

async function urlToBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const fetchOne = async (u: string) => {
    const response = await fetch(u);
    if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
    const blob = await response.blob();
    if (blob.size < 400) throw new Error('IMAGE_TOO_SMALL');
    return blobToBase64(blob);
  };
  try {
    return await fetchOne(url);
  } catch (first) {
    const proxied = staticMapProxyUrl(url);
    if (proxied === url) throw first;
    return fetchOne(proxied);
  }
}

function readResponseText(result: GenerateContentResult): string {
  return result.response.text();
}

function parseVisionCueJson(text: string): VisionCueRaw[] {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as { cues?: VisionCueRaw[] };
  return Array.isArray(parsed.cues) ? parsed.cues : [];
}

function normalizeCueToMeters(
  cue: VisionCueRaw,
  solar: SolarBuildingInsights,
  imageBounds?: StaticMapImageBounds | null
): AiRoofCue | null {
  const swLat = imageBounds?.swLat ?? solar.boundingBox.sw.latitude;
  const swLng = imageBounds?.swLng ?? solar.boundingBox.sw.longitude;
  const neLat = imageBounds?.neLat ?? solar.boundingBox.ne.latitude;
  const neLng = imageBounds?.neLng ?? solar.boundingBox.ne.longitude;
  const x1 = clamp(cue.x1, 0, 1);
  const y1 = clamp(cue.y1, 0, 1);
  const x2 = clamp(cue.x2, 0, 1);
  const y2 = clamp(cue.y2, 0, 1);

  // Static maps are north-up: y=0 top => max latitude.
  const p1LatLng: SolarLatLng = {
    latitude: neLat - y1 * (neLat - swLat),
    longitude: swLng + x1 * (neLng - swLng),
  };
  const p2LatLng: SolarLatLng = {
    latitude: neLat - y2 * (neLat - swLat),
    longitude: swLng + x2 * (neLng - swLng),
  };
  const p1 = latLngToMeters(p1LatLng, solar.center);
  const p2 = latLngToMeters(p2LatLng, solar.center);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 0.22) return null;
  return {
    type: cue.type,
    p1,
    p2,
    confidence: clamp(cue.confidence, 0.2, 1),
  };
}

function cuePrompt(solar: SolarBuildingInsights): string {
  const segments = (solar.roofSegmentStats ?? [])
    .map((s, i) => `Segment ${i + 1}: pitch ${Math.round(s.pitchDegrees)} azimuth ${Math.round(s.azimuthDegrees)}`)
    .join('\n');

  return `You are detecting roofing geometry cues from a north-up satellite image.
Return only JSON matching schema with line cues normalized to [0,1] image coordinates.
Interpretation:
- ridge: roof peaks
- valley: inward channels
- hip: outward sloping intersections
- eave: lower perimeter edges
- rake: sloped gable perimeter edges
Return at least 4 cues whenever roof edges or traced overlays are visible. Use 4-18 cues total; prioritize longer structural lines.

Solar context:
imagery quality: ${solar.imageryQuality}
${segments}`;
}

/** Appended to Gemini vision prompt when the static map shows user-drawn section overlays. */
export const DRAWN_OVERLAY_VISION_HINT =
  'The image includes semi-transparent colored polygons marking user-traced roof facets. Prioritize structural line cues along these traced boundaries and visible ridges, hips, valleys, eaves, and rakes within or adjacent to those overlays.';

function latLngInImageBounds(lat: number, lng: number, b: StaticMapImageBounds, padFrac = 0.1): boolean {
  const dLat = Math.max(1e-9, b.neLat - b.swLat);
  const dLng = Math.max(1e-9, b.neLng - b.swLng);
  return (
    lat >= b.swLat - dLat * padFrac &&
    lat <= b.neLat + dLat * padFrac &&
    lng >= b.swLng - dLng * padFrac &&
    lng <= b.neLng + dLng * padFrac
  );
}

/**
 * When vision models return nothing, use the traced roof rings as real line cues (perimeter edges in meters).
 * If `imageBounds` is set, only edges that intersect that tile are kept so multi-angle slots differ slightly.
 */
export function deriveRingTraceCuesForStaticView(
  rings: RoofCaptureRing[],
  solar: SolarBuildingInsights,
  imageBounds: StaticMapImageBounds | null
): AiRoofCue[] {
  const origin = solar.center;
  const kinds: Array<'eave' | 'rake'> = ['eave', 'rake'];
  let k = 0;
  const cues: AiRoofCue[] = [];

  const pushEdge = (
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
    force: boolean
  ) => {
    const midLat = (a.lat + b.lat) / 2;
    const midLng = (a.lng + b.lng) / 2;
    if (
      !force &&
      imageBounds &&
      !latLngInImageBounds(midLat, midLng, imageBounds, 0.12) &&
      !latLngInImageBounds(a.lat, a.lng, imageBounds, 0.06) &&
      !latLngInImageBounds(b.lat, b.lng, imageBounds, 0.06)
    ) {
      return;
    }
    const p1 = latLngToMeters({ latitude: a.lat, longitude: a.lng }, origin);
    const p2 = latLngToMeters({ latitude: b.lat, longitude: b.lng }, origin);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 0.12) return;
    cues.push({
      type: kinds[k++ % kinds.length]!,
      p1,
      p2,
      confidence: 0.52,
    });
  };

  for (const ring of rings) {
    let path = ring.points.map(p => ({ lat: p.lat, lng: p.lng }));
    if (path.length < 2) continue;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    if (path.length >= 4 && first.lat === last.lat && first.lng === last.lng) {
      path = path.slice(0, -1);
    }
    const n = path.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      pushEdge(path[i]!, path[(i + 1) % n]!, false);
    }
  }

  if (cues.length === 0 && rings.some(r => r.points.length >= 2) && imageBounds) {
    return deriveRingTraceCuesForStaticView(rings, solar, null);
  }
  return cues.slice(0, 40);
}

function deriveSolarHeuristicCuesForViewport(
  solar: SolarBuildingInsights,
  imageBounds: StaticMapImageBounds | null
): AiRoofCue[] | null {
  const { segments } = filterUsableRoofSegments(solar.roofSegmentStats ?? []);
  if (segments.length === 0) return null;
  let subset = segments;
  if (imageBounds) {
    const inView = segments.filter(s =>
      latLngInImageBounds(s.center.latitude, s.center.longitude, imageBounds, 0.16)
    );
    if (inView.length > 0) subset = inView;
  }
  const cues = deriveHeuristicRoofCues(subset, solar.center);
  return cues.length ? cues : null;
}

function geometricVisionFallback(
  solar: SolarBuildingInsights,
  imageBounds: StaticMapImageBounds | null | undefined,
  captureRings: RoofCaptureRing[] | null | undefined
): AiRoofCue[] | null {
  const b = imageBounds ?? null;
  if (captureRings?.length) {
    const ringCues = deriveRingTraceCuesForStaticView(captureRings, solar, b);
    if (ringCues.length > 0) return ringCues;
  }
  return deriveSolarHeuristicCuesForViewport(solar, b);
}

export async function deriveVisionRoofCuesFromStaticMap(
  staticMapUrl: string,
  solar: SolarBuildingInsights,
  extraPrompt?: string,
  imageBounds?: StaticMapImageBounds | null,
  captureRings?: RoofCaptureRing[] | null
): Promise<AiRoofCue[] | null> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) return null;

  const imageData = await urlToBase64(staticMapUrl).catch(() => null);
  if (!imageData) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const text =
    cuePrompt(solar) +
    (extraPrompt ? `\n\n${extraPrompt}` : '');
  const parts: Part[] = [
    { inlineData: { mimeType: imageData.mimeType || 'image/png', data: imageData.data } } as Part,
    { text } as Part,
  ];

  let receivedApiOk = false;
  let everyFailureWas429 = true;
  for (const modelId of GEMINI_MODEL_IDS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ROOF_CUE_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 1800,
        },
        safetySettings: SAFETY_RELAXED,
      });
      const result = await withGemini429Retries(() => model.generateContent(parts));
      receivedApiOk = true;
      everyFailureWas429 = false;
      const raw = parseVisionCueJson(readResponseText(result));
      const cues = raw
        .map(item => normalizeCueToMeters(item, solar, imageBounds))
        .filter((item): item is AiRoofCue => !!item);
      if (cues.length > 0) return cues;
    } catch (e) {
      if (!isGemini429OrQuotaError(e)) everyFailureWas429 = false;
    }
  }

  if (!receivedApiOk && everyFailureWas429) {
    // Quota fallback: try OpenAI via server proxy so UI keeps working.
    const boundsHint = imageBounds
      ? `\nImage bounds (lat/lng corners): sw(${imageBounds.swLat},${imageBounds.swLng}) ne(${imageBounds.neLat},${imageBounds.neLng}).`
      : '';
    const fallbackPrompt = `${cuePrompt(solar)}${extraPrompt ? `\n\n${extraPrompt}` : ''}${boundsHint}

Return JSON only: { "cues": [ { "type":"ridge|hip|valley|eave|rake", "x1":0..1,"y1":0..1,"x2":0..1,"y2":0..1,"confidence":0..1 } ] }`;

    const openAi = await callOpenAiFallbackJson<{ cues?: VisionCueRaw[] }>({
      task: 'roof_cues',
      prompt: fallbackPrompt,
      image: { data: imageData.data, mimeType: imageData.mimeType || 'image/png' },
    }).catch(() => null);
    const raw = Array.isArray(openAi?.cues) ? openAi!.cues! : [];
    const cues = raw
      .map(item => normalizeCueToMeters(item, solar, imageBounds))
      .filter((item): item is AiRoofCue => !!item);
    if (cues.length > 0) return cues;
  }

  const geoLast = geometricVisionFallback(solar, imageBounds, captureRings);
  if (geoLast && geoLast.length > 0) return geoLast;

  if (!receivedApiOk && everyFailureWas429) {
    throw new Error(
      'Gemini quota exceeded (429) and OpenAI fallback did not return usable cues. Please retry shortly.'
    );
  }
  return null;
}

// ─── Wizard Analysis Types ────────────────────────────────────────────────────

export interface OutlineAnalysis {
  qualityScore: number;   // 0..1 how well the outline matches the actual roof
  coverage: number;       // 0..1 fraction of roof covered
  areaEstimateSqFt: number;
  notes: string;
}

export interface SegmentAnalysis {
  type: 'flat' | 'gable' | 'hip' | 'shed' | 'valley' | 'dormer' | 'mansard';
  facingDirection: string; // N|NE|E|SE|S|SW|W|NW|flat
  pitchEstimate: string;   // flat|2/12|3/12|4/12|6/12|8/12|10/12|12/12|steep
  confidence: number;      // 0..1
  notes: string;
}

export interface StructuralLine {
  type: 'ridge' | 'hip' | 'valley' | 'eave' | 'rake' | 'step';
  x1: number; y1: number;
  x2: number; y2: number;
  confidence: number;
  estimatedLengthFt: number;
}

export interface StructuralDetection {
  cues: StructuralLine[];
  roofType: string;
  predominantPitch: string;
  totalAreaSqFt: number;
  notes: string;
}

export interface CombinedRoofAnalysis {
  condition: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Critical';
  condition_score: number;
  issues: string[];
  urgency: 'Low' | 'Medium' | 'High' | 'Urgent';
  estimated_remaining_life: string;
  recommendation: string;
  marketing_message: string;
  structuralSummary: string;
  photoSummary: string;
}

// ─── Wizard Schemas ───────────────────────────────────────────────────────────

const OUTLINE_ANALYSIS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    qualityScore: { type: SchemaType.NUMBER },
    coverage: { type: SchemaType.NUMBER },
    areaEstimateSqFt: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['qualityScore', 'coverage', 'areaEstimateSqFt', 'notes'],
};

const SEGMENT_ANALYSIS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    type: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['flat', 'gable', 'hip', 'shed', 'valley', 'dormer', 'mansard'],
    },
    facingDirection: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'flat'],
    },
    pitchEstimate: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['flat', '2/12', '3/12', '4/12', '5/12', '6/12', '8/12', '10/12', '12/12', 'steep'],
    },
    confidence: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['type', 'facingDirection', 'pitchEstimate', 'confidence', 'notes'],
};

const STRUCTURAL_DETECTION_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    cues: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: ['ridge', 'hip', 'valley', 'eave', 'rake', 'step'],
          },
          x1: { type: SchemaType.NUMBER },
          y1: { type: SchemaType.NUMBER },
          x2: { type: SchemaType.NUMBER },
          y2: { type: SchemaType.NUMBER },
          confidence: { type: SchemaType.NUMBER },
          estimatedLengthFt: { type: SchemaType.NUMBER },
        },
        required: ['type', 'x1', 'y1', 'x2', 'y2', 'confidence', 'estimatedLengthFt'],
      },
    },
    roofType: { type: SchemaType.STRING },
    predominantPitch: { type: SchemaType.STRING },
    totalAreaSqFt: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['cues', 'roofType', 'predominantPitch', 'totalAreaSqFt', 'notes'],
};

const COMBINED_ANALYSIS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    condition: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['Excellent', 'Good', 'Fair', 'Poor', 'Critical'],
    },
    condition_score: { type: SchemaType.NUMBER },
    issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    urgency: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['Low', 'Medium', 'High', 'Urgent'],
    },
    estimated_remaining_life: { type: SchemaType.STRING },
    recommendation: { type: SchemaType.STRING },
    marketing_message: { type: SchemaType.STRING },
    structuralSummary: { type: SchemaType.STRING },
    photoSummary: { type: SchemaType.STRING },
  },
  required: [
    'condition', 'condition_score', 'issues', 'urgency',
    'estimated_remaining_life', 'recommendation', 'marketing_message',
    'structuralSummary', 'photoSummary',
  ],
};

// ─── Coordinate helpers for wizard ───────────────────────────────────────────

/** Convert a lat/lng point to normalized [0,1] image coordinates for a static map
 *  at the given center/zoom. y=0 is the top (north). Approximation valid at zoom ≥18. */
export function latLngToImageNorm(
  point: { lat: number; lng: number },
  center: { lat: number; lng: number },
  zoom: number,
  imageLogicalSize: number
): { x: number; y: number } {
  const worldPx = 256 * Math.pow(2, zoom);
  const pixelsPerDeg = worldPx / 360;
  const half = imageLogicalSize / 2;
  const dx = (point.lng - center.lng) * pixelsPerDeg;
  const dy = -(point.lat - center.lat) * pixelsPerDeg; // y flips (north = top)
  return {
    x: Math.max(0, Math.min(1, (dx + half) / imageLogicalSize)),
    y: Math.max(0, Math.min(1, (dy + half) / imageLogicalSize)),
  };
}

function polygonToNormString(
  path: { lat: number; lng: number }[],
  center: { lat: number; lng: number },
  zoom: number
): string {
  return path
    .map(p => {
      const n = latLngToImageNorm(p, center, zoom, 640);
      return `(${n.x.toFixed(3)},${n.y.toFixed(3)})`;
    })
    .join(' → ');
}

function buildImagePart(imageData: { data: string; mimeType: string } | null | undefined): Part | null {
  if (!imageData || !imageData.data || imageData.data.length < 100) return null;
  return { inlineData: { mimeType: imageData.mimeType || 'image/png', data: imageData.data } } as Part;
}

async function runGeminiWithSchema<T>(
  parts: Part[],
  schema: Schema,
  temperature = 0.25
): Promise<T | null> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) return null;
  // Remove any null/falsy parts (e.g., missing image)
  const validParts = parts.filter(Boolean) as Part[];
  if (validParts.length === 0) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  for (const modelId of GEMINI_MODEL_IDS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature,
          maxOutputTokens: 2000,
        },
        safetySettings: SAFETY_RELAXED,
      });
      const result = await withGemini429Retries(() => model.generateContent(validParts));
      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned) as T;
    } catch {
      // try next model
    }
  }
  return null;
}

// ─── Wizard Gemini Calls ──────────────────────────────────────────────────────

/** Step 1a: Analyze the user's drawn roof outline against the satellite image. */
export async function analyzeRoofOutline(
  imageData: { data: string; mimeType: string } | null,
  outlineNormalized: { x: number; y: number }[],
): Promise<OutlineAnalysis | null> {
  const outlineStr = outlineNormalized.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ');
  const imgPart = buildImagePart(imageData);
  const textPart: Part = {
    text: `You are analyzing a north-up satellite image of a building rooftop.${imgPart ? '' : ' (No image provided — use coordinates only.)'}
The user has drawn a boundary polygon with these normalized image coordinates (x=0 left, y=0 top):
${outlineStr}

Evaluate:
1. qualityScore (0-1): How well does the polygon appear to trace a roof boundary?
2. coverage (0-1): Estimate what fraction of a typical roof the polygon covers.
3. areaEstimateSqFt: Estimate total roof area in square feet.
4. notes: Brief feedback (≤2 sentences) on the outline.

Return JSON only.`,
  } as Part;
  const parts: Part[] = [imgPart, textPart].filter(Boolean) as Part[];
  return runGeminiWithSchema<OutlineAnalysis>(parts, OUTLINE_ANALYSIS_SCHEMA);
}

/** Step 1b: Analyze a single user-drawn roof segment against the satellite image. */
export async function analyzeRoofSegment(
  imageData: { data: string; mimeType: string } | null,
  segmentNormalized: { x: number; y: number }[],
  segmentIndex: number,
  existingSegmentsNormalized?: { x: number; y: number }[][],
): Promise<SegmentAnalysis | null> {
  const segStr = segmentNormalized.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ');
  const contextStr = existingSegmentsNormalized && existingSegmentsNormalized.length > 0
    ? `\nPreviously mapped segments for context: ${existingSegmentsNormalized.length} segment(s) already identified.`
    : '';
  const imgPart = buildImagePart(imageData);
  const textPart: Part = {
    text: `You are analyzing a north-up satellite image of a building rooftop.${imgPart ? '' : ' (No image provided — use coordinates only.)'}
Segment ${segmentIndex + 1} has been drawn with these normalized image coordinates:
${segStr}${contextStr}

Classify this roof segment:
- type: the structural type (flat/gable/hip/shed/valley/dormer/mansard)
- facingDirection: which cardinal direction this slope faces (N/NE/E/SE/S/SW/W/NW/flat)
- pitchEstimate: slope ratio (flat/2/12/3/12/4/12/5/12/6/12/8/12/10/12/12/12/steep)
- confidence: 0-1 how confident you are
- notes: 1 sentence describing what you see

Return JSON only.`,
  } as Part;
  const parts: Part[] = [imgPart, textPart].filter(Boolean) as Part[];
  return runGeminiWithSchema<SegmentAnalysis>(parts, SEGMENT_ANALYSIS_SCHEMA);
}

/** Step 1c: Detect structural roof lines across all user-drawn segments. */
export async function detectRoofStructure(
  imageData: { data: string; mimeType: string } | null,
  allSegmentsNormalized: { x: number; y: number }[][],
): Promise<StructuralDetection | null> {
  const segDesc = allSegmentsNormalized
    .map((seg, i) => `Segment ${i + 1}: ${seg.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ')}`)
    .join('\n');
  const imgPart = buildImagePart(imageData);
  const textPart: Part = {
    text: `You are analyzing a north-up satellite image of a building rooftop where the user has traced ${allSegmentsNormalized.length} roof segment(s).${imgPart ? '' : ' (No image provided — infer structure from segment coordinates only.)'}

${segDesc}

Detect ALL structural lines (ridge, hip, valley, eave, rake, step) using the segment boundaries.
For each cue:
- type: MUST be one of: ridge, hip, valley, eave, rake, step
- x1,y1,x2,y2: normalized image coords [0,1] of the line endpoints
- confidence: 0-1
- estimatedLengthFt: estimated length in feet (use 10-60 as typical range)

Also return:
- roofType: e.g. "gable", "hip", "complex hip-gable", "flat", "mansard"
- predominantPitch: e.g. "4/12", "6/12"
- totalAreaSqFt: estimated total roof area (positive number)
- notes: key observations (1-2 sentences)

Return 4-20 cues total. Return JSON only.`,
  } as Part;
  const parts: Part[] = [imgPart, textPart].filter(Boolean) as Part[];
  return runGeminiWithSchema<StructuralDetection>(parts, STRUCTURAL_DETECTION_SCHEMA);
}

/** Step 3: Combined final analysis from structural map + multi-angle photos. */
export async function analyzeCombinedRoof(
  structuralData: {
    roofType: string;
    predominantPitch: string;
    totalAreaSqFt: number;
    segmentCount: number;
    ridgeFt: number;
    hipFt: number;
    valleyFt: number;
    eaveFt: number;
    notes: string;
  },
  photoSummaries: Array<{
    slot: string;
    qualityScore: number;
    cueCount: number;
    byType: Record<string, number>;
  }>,
  topImageData?: { data: string; mimeType: string },
): Promise<CombinedRoofAnalysis | null> {
  const structStr = `Roof type: ${structuralData.roofType}
Predominant pitch: ${structuralData.predominantPitch}
Total area: ${Math.round(structuralData.totalAreaSqFt)} sq ft (${Math.round(structuralData.totalAreaSqFt / 100)} squares)
Segments mapped: ${structuralData.segmentCount}
Ridge: ${Math.round(structuralData.ridgeFt)} ft | Hip: ${Math.round(structuralData.hipFt)} ft | Valley: ${Math.round(structuralData.valleyFt)} ft | Eave: ${Math.round(structuralData.eaveFt)} ft
Structural notes: ${structuralData.notes}`;

  const photoStr = photoSummaries.length > 0
    ? photoSummaries.map(p => `${p.slot}: quality=${(p.qualityScore * 100).toFixed(0)}%, ${p.cueCount} cues detected`).join('\n')
    : 'No additional photos analyzed.';

  const parts: Part[] = [];
  if (topImageData) {
    parts.push({ inlineData: { mimeType: topImageData.mimeType, data: topImageData.data } } as Part);
  }
  parts.push({
    text: `You are an expert roofing inspector performing a comprehensive roof assessment.

STRUCTURAL ANALYSIS (from mapped segments):
${structStr}

MULTI-ANGLE PHOTO ANALYSIS:
${photoStr}

Based on all available data, provide a complete roof assessment:
- condition: Excellent/Good/Fair/Poor/Critical
- condition_score: 0-100 numeric score
- issues: list of specific issues identified (empty array if none)
- urgency: Low/Medium/High/Urgent for service recommendation
- estimated_remaining_life: e.g. "8-12 years"
- recommendation: specific actionable recommendation for the homeowner
- marketing_message: compelling 1-sentence pitch for roofing services
- structuralSummary: 1-2 sentence summary of structural findings
- photoSummary: 1-2 sentence summary of photo analysis findings

Return JSON only.`,
  } as Part);

  return runGeminiWithSchema<CombinedRoofAnalysis>(parts, COMBINED_ANALYSIS_SCHEMA, 0.3);
}

// ─── Legacy helpers (unchanged below) ────────────────────────────────────────

function cueTypeFromPitchAndAzimuth(
  pitchDegrees: number,
  azimuthDegrees: number
): AiRoofCue['type'] {
  if (pitchDegrees < 2) return 'eave';
  const mod = ((azimuthDegrees % 180) + 180) % 180;
  if (mod < 22.5 || mod > 157.5) return 'ridge';
  if (mod > 67.5 && mod < 112.5) return 'valley';
  return 'hip';
}

/** Closed rings in WGS84 for Static Maps path=… (roof highlight). */
export interface RoofCaptureRing {
  points: { lat: number; lng: number }[];
  /** Fill/stroke color #RRGGBB (section color). */
  color: string;
}

function simplifyRingForStaticMap(
  points: { lat: number; lng: number }[],
  maxVertices: number
): { lat: number; lng: number }[] {
  if (points.length <= maxVertices) return points.map(p => ({ ...p }));
  const out: { lat: number; lng: number }[] = [];
  const step = (points.length - 1) / (maxVertices - 1);
  for (let i = 0; i < maxVertices - 1; i++) {
    const idx = Math.min(points.length - 1, Math.round(i * step));
    out.push({ ...points[idx] });
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

function encodeRingPathParam(ring: RoofCaptureRing): string | null {
  const pts = simplifyRingForStaticMap(ring.points, 28);
  if (pts.length < 3) return null;
  const stroke = ring.color.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(stroke)) return null;
  const pathPts = pts.map(p => `${p.lat},${p.lng}`);
  if (pathPts[0] !== pathPts[pathPts.length - 1]) pathPts.push(pathPts[0]);
  return `fillcolor:0x${stroke}40|color:0x${stroke}FF|weight:2|${pathPts.join('|')}`;
}

function roofRingsRawBounds(rings: RoofCaptureRing[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} | null {
  if (!rings.length) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const r of rings) {
    for (const p of r.points) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng);
      maxLng = Math.max(maxLng, p.lng);
    }
  }
  return { minLat, maxLat, minLng, maxLng };
}

const STATIC_CAPTURE_SIZE = 640;

/** Geographic footprint of a Static Map at `center` + `zoom` (logical `size` px, north-up). */
export function computeStaticMapImageBoundsFromCenterZoom(
  center: { lat: number; lng: number },
  zoom: number,
  imageLogicalSize: number
): StaticMapImageBounds {
  const worldPx = 256 * Math.pow(2, zoom);
  const pixelsPerDeg = worldPx / 360;
  const half = imageLogicalSize / 2;
  const corner = (nx: number, ny: number) => {
    const dx = nx * imageLogicalSize - half;
    const dy = ny * imageLogicalSize - half;
    return {
      lat: center.lat - dy / pixelsPerDeg,
      lng: center.lng + dx / pixelsPerDeg,
    };
  };
  const c = [
    corner(0, 0),
    corner(1, 0),
    corner(0, 1),
    corner(1, 1),
  ];
  const lats = c.map(p => p.lat);
  const lngs = c.map(p => p.lng);
  return {
    swLat: Math.min(...lats),
    swLng: Math.min(...lngs),
    neLat: Math.max(...lats),
    neLng: Math.max(...lngs),
  };
}

function ringPointsAllInsideImage(
  rings: RoofCaptureRing[],
  center: { lat: number; lng: number },
  zoom: number,
  padNorm: number,
  imageLogicalSize: number
): boolean {
  const lo = padNorm;
  const hi = 1 - padNorm;
  for (const r of rings) {
    for (const p of r.points) {
      const n = latLngToImageNorm(p, center, zoom, imageLogicalSize);
      if (n.x < lo || n.x > hi || n.y < lo || n.y > hi) return false;
    }
  }
  return true;
}

/** Highest zoom so every ring vertex sits inside the image with margin (equirectangular, good at z≥18). */
function maxZoomFittingRings(
  rings: RoofCaptureRing[],
  center: { lat: number; lng: number },
  padNorm: number,
  minZ: number,
  maxZ: number,
  imageLogicalSize: number
): number {
  for (let z = maxZ; z >= minZ; z--) {
    if (ringPointsAllInsideImage(rings, center, z, padNorm, imageLogicalSize)) return z;
  }
  return minZ;
}

/** Bounding span (m) and centroid from all ring vertices — drives zoom + capture anchor. */
export function ringsAnchorAndSpanMeters(rings: RoofCaptureRing[]): {
  center: { lat: number; lng: number };
  spanM: number;
} | null {
  const box = roofRingsRawBounds(rings);
  if (!box) return null;
  const { minLat, maxLat, minLng, maxLng } = box;
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  const dLatM = (maxLat - minLat) * METERS_PER_DEG_LAT;
  const dLngM = (maxLng - minLng) * metersPerDegLng(center.lat);
  const spanM = Math.max(dLatM, dLngM, 5);
  return { center, spanM };
}

function zoomPairFromRoofSpanM(spanM: number): { tight: number; wide: number } {
  if (spanM <= 10) return { tight: 21, wide: 20 };
  if (spanM <= 18) return { tight: 20, wide: 19 };
  if (spanM <= 32) return { tight: 20, wide: 18 };
  if (spanM <= 52) return { tight: 19, wide: 18 };
  return { tight: 19, wide: 17 };
}

function buildStaticCaptureUrl(
  centerLat: number,
  centerLng: number,
  zoom: number,
  apiKey: string,
  rings: RoofCaptureRing[] | null
): string {
  const params = new URLSearchParams({
    center: `${centerLat},${centerLng}`,
    zoom: String(zoom),
    size: '640x640',
    maptype: 'satellite',
    scale: '2',
    key: apiKey,
  });
  let url = `https://maps.googleapis.com/maps/api/staticmap?${params}`;
  if (rings?.length) {
    for (const ring of rings.slice(0, 8)) {
      const enc = encodeRingPathParam(ring);
      if (enc) url += `&path=${encodeURIComponent(enc)}`;
    }
  }
  return url;
}

/**
 * Six Static Map viewpoints (center + diagonal offsets + wider).
 * With user-drawn `roofRings`, uses **center + zoom** fit so the traced roof fills the frame (Static Maps often
 * refits when `visible` + `path` disagree — that produced huge, identical neighborhood tiles). Paths stay on the
 * URL for Gemini; `imageBounds` match the chosen center/zoom for cue normalization.
 */
export function buildAutoMapViewCaptures(
  centerFallback: { lat: number; lng: number },
  apiKey: string,
  roofRings?: RoofCaptureRing[] | null
): AutoMapViewCapture[] {
  const metersToLat = (m: number) => m / METERS_PER_DEG_LAT;
  const metersToLng = (m: number, lat: number) => m / metersPerDegLng(lat);
  const rings = roofRings?.length ? roofRings : null;
  const bbox = rings ? roofRingsRawBounds(rings) : null;

  if (rings && bbox) {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const midLng = (bbox.minLng + bbox.maxLng) / 2;
    const geo = ringsAnchorAndSpanMeters(rings);
    const spanM = geo?.spanM ?? 12;
    /** Pan the map center a few meters so each slot shows a slightly different crop while the roof stays in frame. */
    const panM = Math.min(12, Math.max(4.5, spanM * 0.14));
    const n = (m: number) => metersToLat(m);
    const e = (m: number) => metersToLng(m, midLat);

    const slotDefs = [
      { id: 'v-center', label: 'Center (roof)', northM: 0, eastM: 0, wide: false },
      { id: 'v-nw', label: 'NW pan', northM: panM, eastM: -panM, wide: false },
      { id: 'v-ne', label: 'NE pan', northM: panM, eastM: panM, wide: false },
      { id: 'v-sw', label: 'SW pan', northM: -panM, eastM: -panM, wide: false },
      { id: 'v-se', label: 'SE pan', northM: -panM, eastM: panM, wide: false },
      { id: 'v-wide', label: 'Wider context', northM: 0, eastM: 0, wide: true },
    ] as const;

    return slotDefs.map(slot => {
      const center = {
        lat: midLat + n(slot.northM),
        lng: midLng + e(slot.eastM),
      };
      const padTight = 0.07;
      let zoom = maxZoomFittingRings(rings, center, padTight, 18, 22, STATIC_CAPTURE_SIZE);
      if (slot.wide) {
        zoom = Math.max(18, zoom - 2);
        if (!ringPointsAllInsideImage(rings, center, zoom, 0.04, STATIC_CAPTURE_SIZE)) {
          zoom = Math.max(18, zoom - 1);
        }
      }
      const imageBounds = computeStaticMapImageBoundsFromCenterZoom(center, zoom, STATIC_CAPTURE_SIZE);
      const url = buildStaticCaptureUrl(center.lat, center.lng, zoom, apiKey, rings);
      return { id: slot.id, label: slot.label, url, imageBounds };
    });
  }

  const geo = roofRings?.length ? ringsAnchorAndSpanMeters(roofRings) : null;
  const anchor = geo?.center ?? centerFallback;
  const spanM = geo?.spanM ?? 22;
  const { tight: zTight, wide: zWide } = zoomPairFromRoofSpanM(spanM);
  const offsetM = Math.min(42, Math.max(18, spanM * 0.62));
  const dLat = metersToLat(offsetM);
  const dLng = metersToLng(offsetM, anchor.lat);

  const views = [
    { id: 'v-center', label: 'Center (roof)', lat: anchor.lat, lng: anchor.lng, zoom: zTight },
    { id: 'v-nw', label: 'NW offset', lat: anchor.lat + dLat, lng: anchor.lng - dLng, zoom: zTight },
    { id: 'v-ne', label: 'NE offset', lat: anchor.lat + dLat, lng: anchor.lng + dLng, zoom: zTight },
    { id: 'v-sw', label: 'SW offset', lat: anchor.lat - dLat, lng: anchor.lng - dLng, zoom: zTight },
    { id: 'v-se', label: 'SE offset', lat: anchor.lat - dLat, lng: anchor.lng + dLng, zoom: zTight },
    { id: 'v-wide', label: 'Wider context', lat: anchor.lat, lng: anchor.lng, zoom: zWide },
  ] as const;

  return views.map(view => ({
    id: view.id,
    label: view.label,
    url: buildStaticCaptureUrl(view.lat, view.lng, view.zoom, apiKey, null),
    imageBounds: null,
  }));
}

/**
 * Sprint-3 AI cue bootstrap:
 * Generates deterministic line cues from Solar segments so the reconstruction pipeline
 * can consume `aiCues` immediately. This can later be replaced with Gemini/CV outputs.
 */
export function deriveHeuristicRoofCues(
  segments: SolarRoofSegment[],
  center: SolarLatLng
): AiRoofCue[] {
  if (segments.length === 0) return [];
  return segments.map(segment => {
    const centroid = latLngToMeters(segment.center, center);
    const azRad = (segment.azimuthDegrees * Math.PI) / 180;
    const dir: Vec2 = { x: Math.sin(azRad), y: Math.cos(azRad) };
    const halfLengthMeters = Math.max(1.5, Math.sqrt(Math.max(1, segment.stats.areaMeters2)) * 0.35);
    const p1: Vec2 = {
      x: centroid.x - dir.x * halfLengthMeters,
      y: centroid.y - dir.y * halfLengthMeters,
    };
    const p2: Vec2 = {
      x: centroid.x + dir.x * halfLengthMeters,
      y: centroid.y + dir.y * halfLengthMeters,
    };
    return {
      type: cueTypeFromPitchAndAzimuth(segment.pitchDegrees, segment.azimuthDegrees),
      p1,
      p2,
      confidence: 0.58,
    };
  });
}
