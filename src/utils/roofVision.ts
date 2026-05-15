import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { GenerateContentResult, Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import { enqueueGeminiRequest } from './gemini429';
import { callOpenAiFallbackJson } from './openaiFallback';
import type { AiRoofCue, Vec2 } from './roofStructure';
import type { SolarBuildingInsights, SolarLatLng, SolarRoofSegment } from './solar';

const METERS_PER_DEG_LAT = 111_320;
const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/;
const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  // HARM_CATEGORY_CIVIC_INTEGRITY omitted — not supported on all model versions and causes 400 errors
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
            description: 'One of: ridge, hip, valley, eave, rake',
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

export interface RoofPhotoCueAnalysis {
  qualityScore: number; // 0..1
  cues: VisionCueRaw[];
  byType: Record<VisionCueRaw['type'], number>;
}

const ROOF_PHOTO_CUE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    qualityScore: { type: SchemaType.NUMBER },
    cues: ROOF_CUE_SCHEMA.properties?.cues,
  },
  required: ['qualityScore', 'cues'],
};

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT_${label}_${ms}ms`)), ms)
    ),
  ]);
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

function parsePhotoCueJson(text: string): RoofPhotoCueAnalysis {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as { qualityScore?: number; cues?: VisionCueRaw[] };
  const cues = Array.isArray(parsed.cues) ? parsed.cues : [];
  const byType: Record<VisionCueRaw['type'], number> = {
    ridge: 0,
    hip: 0,
    valley: 0,
    eave: 0,
    rake: 0,
  };
  cues.forEach(cue => {
    byType[cue.type] += 1;
  });
  const qualityScore = clamp(
    typeof parsed.qualityScore === 'number'
      ? parsed.qualityScore
      : (cues.reduce((sum, cue) => sum + cue.confidence, 0) / Math.max(cues.length, 1)),
    0,
    1
  );
  return { qualityScore, cues, byType };
}

function normalizeCueToMeters(
  cue: VisionCueRaw,
  solar: SolarBuildingInsights
): AiRoofCue | null {
  const { sw, ne } = solar.boundingBox;
  const x1 = clamp(cue.x1, 0, 1);
  const y1 = clamp(cue.y1, 0, 1);
  const x2 = clamp(cue.x2, 0, 1);
  const y2 = clamp(cue.y2, 0, 1);

  // Static maps are north-up: y=0 top => max latitude.
  const p1LatLng: SolarLatLng = {
    latitude: ne.latitude - y1 * (ne.latitude - sw.latitude),
    longitude: sw.longitude + x1 * (ne.longitude - sw.longitude),
  };
  const p2LatLng: SolarLatLng = {
    latitude: ne.latitude - y2 * (ne.latitude - sw.latitude),
    longitude: sw.longitude + x2 * (ne.longitude - sw.longitude),
  };
  const p1 = latLngToMeters(p1LatLng, solar.center);
  const p2 = latLngToMeters(p2LatLng, solar.center);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 0.8) return null;
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
Use 4-18 cues total, prioritize longer structural lines, and avoid tiny noisy segments.

Solar context:
imagery quality: ${solar.imageryQuality}
${segments}`;
}

/** Convert an array of raw photo cues (normalized 0-1 coords) to metric AiRoofCues
 *  using the Solar building bounding box to map image space → lat/lng → meters. */
export function mapPhotoCuesToAiCues(
  rawCues: VisionCueRaw[],
  solar: SolarBuildingInsights
): AiRoofCue[] {
  return rawCues
    .map(cue => normalizeCueToMeters(cue, solar))
    .filter((cue): cue is AiRoofCue => !!cue);
}

export async function deriveVisionRoofCuesFromStaticMap(
  staticMapUrl: string,
  solar: SolarBuildingInsights
): Promise<AiRoofCue[] | null> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) return null;

  const imageData = await urlToBase64(staticMapUrl).catch(() => null);
  if (!imageData) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const parts: Part[] = [
    { inlineData: { mimeType: imageData.mimeType || 'image/png', data: imageData.data } } as Part,
    { text: cuePrompt(solar) } as Part,
  ];

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
      const result = await model.generateContent(parts);
      const raw = parseVisionCueJson(readResponseText(result));
      const cues = raw
        .map(item => normalizeCueToMeters(item, solar))
        .filter((item): item is AiRoofCue => !!item);
      if (cues.length > 0) return cues;
    } catch {
      // Try next model.
    }
  }
  return null;
}

async function fileToBase64(file: File): Promise<{ data: string; mimeType: string }> {
  return blobToBase64(file);
}

export async function deriveVisionRoofCuesFromFile(
  file: File,
  slotLabel?: string
): Promise<RoofPhotoCueAnalysis | null> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) return null;

  const imageData = await fileToBase64(file).catch(() => null);
  if (!imageData) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const prompt = `Analyze this single roof photo and extract roof geometry cues.
Return strict JSON with:
- qualityScore: 0..1 overall usability of this photo for roof geometry
- cues: array of line cues in normalized image coordinates [0,1]
Cue types: ridge, hip, valley, eave, rake.
Keep 2-16 cues max. Skip tiny noisy lines.
${slotLabel ? `Capture slot: ${slotLabel}.` : ''}`;

  const parts: Part[] = [
    { inlineData: { mimeType: imageData.mimeType || 'image/jpeg', data: imageData.data } } as Part,
    { text: prompt } as Part,
  ];

  for (const modelId of GEMINI_MODEL_IDS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ROOF_PHOTO_CUE_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 1800,
        },
        safetySettings: SAFETY_RELAXED,
      });
      const result = await model.generateContent(parts);
      const analysis = parsePhotoCueJson(readResponseText(result));
      if (analysis.cues.length > 0 || analysis.qualityScore > 0.25) return analysis;
    } catch {
      // Try next model.
    }
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
  /** 0-based index matching input order (set by batch analysis) */
  index?: number;
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
    type: { type: SchemaType.STRING, description: 'Structural type: flat, gable, hip, shed, valley, dormer, or mansard' },
    facingDirection: { type: SchemaType.STRING, description: 'Cardinal direction this slope faces: N, NE, E, SE, S, SW, W, NW, or flat' },
    pitchEstimate: { type: SchemaType.STRING, description: 'Slope ratio: flat, 2/12, 3/12, 4/12, 5/12, 6/12, 8/12, 10/12, 12/12, or steep' },
    confidence: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['type', 'facingDirection', 'pitchEstimate', 'confidence', 'notes'],
};

/** Batch: classify ALL segments in one Gemini call (saves quota). */
const BATCH_SEGMENT_ANALYSIS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    segments: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          index: { type: SchemaType.NUMBER, description: '0-based segment index matching the input order' },
          type: { type: SchemaType.STRING, description: 'Structural type: flat, gable, hip, shed, valley, dormer, or mansard' },
          facingDirection: { type: SchemaType.STRING, description: 'Cardinal direction this slope faces: N, NE, E, SE, S, SW, W, NW, or flat' },
          pitchEstimate: { type: SchemaType.STRING, description: 'Slope ratio: flat, 2/12, 3/12, 4/12, 5/12, 6/12, 8/12, 10/12, 12/12, or steep' },
          confidence: { type: SchemaType.NUMBER },
          notes: { type: SchemaType.STRING },
        },
        required: ['index', 'type', 'facingDirection', 'pitchEstimate', 'confidence', 'notes'],
      },
    },
  },
  required: ['segments'],
};

/** Classify ALL drawn segments in a single API call (1 call instead of N). */
export async function analyzeAllRoofSegments(
  imageData: { data: string; mimeType: string } | null,
  allSegmentsNormalized: { x: number; y: number }[][],
  options?: { refinement?: boolean },
): Promise<SegmentAnalysis[] | null> {
  const segDesc = allSegmentsNormalized
    .map((seg, i) => {
      const pts = seg.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ');
      return `Segment ${i + 1}: ${pts}`;
    })
    .join('\n');
  const refinementStr = options?.refinement
    ? '\nPrioritize accurate pitch (ratio), slope-facing cardinal direction, and roof type for each segment; be specific to what the satellite image shows.'
    : '';
  const imgPart = buildImagePart(imageData);
  const textPart: Part = {
    text: `You are analyzing a north-up satellite image of a building rooftop.${imgPart ? '' : ' (No image provided — use coordinates only.)'}
The user has drawn ${allSegmentsNormalized.length} roof segments:
${segDesc}${refinementStr}

For EACH segment, classify:
- index: 0-based index matching input order
- type: the structural type (flat/gable/hip/shed/valley/dormer/mansard)
- facingDirection: which cardinal direction this slope faces (N/NE/E/SE/S/SW/W/NW/flat)
- pitchEstimate: slope ratio (flat/2/12/3/12/4/12/5/12/6/12/8/12/10/12/12/12/steep)
- confidence: 0-1 how confident you are
- notes: 1 sentence describing what you see

Return a JSON object with a "segments" array containing one entry per segment.
Return JSON only.`,
  } as Part;
  const parts: Part[] = [imgPart, textPart].filter(Boolean) as Part[];
  const { result, error } = await runGeminiWithSchema<{ segments: SegmentAnalysis[] }>(parts, BATCH_SEGMENT_ANALYSIS_SCHEMA, 0.25, 'segment_analysis');
  if (error) console.warn('[RoofVision] analyzeAllRoofSegments failed:', error);
  else if (!result) console.warn('[RoofVision] analyzeAllRoofSegments returned null');
  return result?.segments ?? null;
}

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
            description: 'One of: ridge, hip, valley, eave, rake, step',
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
      description: 'One of: Excellent, Good, Fair, Poor, Critical',
    },
    condition_score: { type: SchemaType.NUMBER },
    issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    urgency: {
      type: SchemaType.STRING,
      description: 'One of: Low, Medium, High, Urgent',
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
  const half = imageLogicalSize / 2;
  // Longitude is linear in Mercator
  const dx = (point.lng - center.lng) * (worldPx / 360);
  // Latitude uses Web Mercator (matches Google Static Maps tile projection)
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const dy = (mercY(center.lat) - mercY(point.lat)) * (worldPx / (2 * Math.PI));
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

type GeminiResult<T> = { result: T; error: null } | { result: null; error: string };

/** Extract text and image from Gemini Parts array for OpenAI fallback. */
function extractPartsForOpenAi(parts: Part[]): { prompt: string; image: { data: string; mimeType: string } | null } {
  let prompt = '';
  let image: { data: string; mimeType: string } | null = null;
  for (const part of parts) {
    if (!part) continue;
    if ('text' in part && typeof part.text === 'string') prompt += part.text + '\n';
    if ('inlineData' in part && part.inlineData) {
      image = { data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  return { prompt: prompt.trim(), image };
}

function is429orQuota(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('QuotaFailure');
}

function shouldTryOpenAiAfterGeminiFail(lastError: string, allQuotaErrors: boolean): boolean {
  if (allQuotaErrors) return true;
  const u = lastError.toUpperCase();
  return (
    u.includes('429') ||
    u.includes('RESOURCE_EXHAUSTED') ||
    u.includes('503') ||
    u.includes('UNAVAILABLE') ||
    u.includes('OVERLOADED')
  );
}

/** After repeated Gemini 429s on every model, pause client-side Gemini calls to stop quota spam in DevTools. */
const GEMINI_COOLDOWN_MS = 15 * 60 * 1000;
let geminiQuotaCooldownUntil = 0;


function preferOpenAiVisionFirst(): boolean {
  try {
    const v = import.meta.env.VITE_PREFER_OPENAI_VISION;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

async function routeOpenAiFallback<T>(
  validParts: Part[],
  task: 'segment_analysis' | 'roof_cues'
): Promise<GeminiResult<T>> {
  const { prompt, image } = extractPartsForOpenAi(validParts);
  if (!image || !prompt) return { result: null, error: 'OPENAI_MISSING_PARTS' };
  try {
    const result = await callOpenAiFallbackJson<T>({
      task,
      prompt: prompt + '\n\nReturn JSON only.',
      image,
    });
    return { result, error: null };
  } catch (e) {
    return {
      result: null,
      error: `OpenAI-fallback: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    };
  }
}

async function runGeminiWithSchemaImpl<T>(
  parts: Part[],
  schema: Schema,
  temperature = 0.25,
  openAiTask?: 'segment_analysis' | 'roof_cues'
): Promise<GeminiResult<T>> {
  const validParts = parts.filter(Boolean) as Part[];
  if (validParts.length === 0) return { result: null, error: 'NO_VALID_PARTS' };

  const apiKey = readGeminiApiKey();
  if (!apiKey) {
    if (openAiTask && (preferOpenAiVisionFirst() || Date.now() < geminiQuotaCooldownUntil)) {
      return routeOpenAiFallback<T>(validParts, openAiTask);
    }
    return { result: null, error: 'NO_API_KEY' };
  }

  // Skip Gemini during cooldown so DevTools is not flooded with 429s after quota exhaustion.
  if (openAiTask && Date.now() < geminiQuotaCooldownUntil) {
    console.warn('[RoofVision] Gemini cooldown active — using OpenAI only');
    return routeOpenAiFallback<T>(validParts, openAiTask);
  }

  if (openAiTask && preferOpenAiVisionFirst()) {
    const first = await routeOpenAiFallback<T>(validParts, openAiTask);
    if (first.result !== null && first.error === null) return first;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = 'ALL_MODELS_FAILED';
  let allQuotaErrors = true;

  for (const modelId of GEMINI_MODEL_IDS) {
    // Try with responseSchema first
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
      const raw = await withTimeout(model.generateContent(validParts), 45_000, modelId);
      const text = raw.response.text();
      if (text && text.trim().length > 0) {
        const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        geminiQuotaCooldownUntil = 0;
        return { result: JSON.parse(cleaned) as T, error: null };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = `${modelId}(schema): ${msg.slice(0, 200)}`;
      if (!is429orQuota(err)) allQuotaErrors = false;

      // On 400 (schema rejected) retry same model with JSON-only mode (no schema)
      if (msg.includes('400') || msg.includes('INVALID_ARGUMENT')) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelId,
            generationConfig: {
              responseMimeType: 'application/json',
              temperature,
              maxOutputTokens: 2000,
            },
            safetySettings: SAFETY_RELAXED,
          });
          const raw = await withTimeout(model.generateContent(validParts), 45_000, `${modelId}-json`);
          const text = raw.response.text();
          if (text && text.trim().length > 0) {
            const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
            geminiQuotaCooldownUntil = 0;
            return { result: JSON.parse(cleaned) as T, error: null };
          }
        } catch (fallbackErr) {
          lastError = `${modelId}(json): ${fallbackErr instanceof Error ? fallbackErr.message.slice(0, 200) : String(fallbackErr)}`;
          if (!is429orQuota(fallbackErr)) allQuotaErrors = false;
        }
      }

      // On 429 (rate limit), wait before trying next model
      if (is429orQuota(err)) {
        const delay = 30_000 + Math.random() * 15_000;
        console.warn(`[RoofVision] 429 rate limit on ${modelId} — waiting ${Math.round(delay)}ms before next model`);
        await new Promise<void>(r => setTimeout(r, delay));
      }
    }
  }

  if (allQuotaErrors) {
    geminiQuotaCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
    console.warn('[RoofVision] Gemini models rate-limited — pausing Gemini calls for 15 minutes.');
  }

  // ── OpenAI fallback: quota/capacity failures (or every attempt was rate-limited) ──
  if (openAiTask && shouldTryOpenAiAfterGeminiFail(lastError, allQuotaErrors)) {
    console.warn('[RoofVision] Gemini unavailable or rate-limited — falling back to OpenAI');
    const oai = await routeOpenAiFallback<T>(validParts, openAiTask);
    if (oai.result !== null && oai.error === null) return oai;
    if (oai.error) lastError = oai.error;
  }

  return { result: null, error: lastError };
}

async function runGeminiWithSchema<T>(
  parts: Part[],
  schema: Schema,
  temperature = 0.25,
  openAiTask?: 'segment_analysis' | 'roof_cues'
): Promise<GeminiResult<T>> {
  return enqueueGeminiRequest(() => runGeminiWithSchemaImpl<T>(parts, schema, temperature, openAiTask));
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
  const { result, error } = await runGeminiWithSchema<OutlineAnalysis>(parts, OUTLINE_ANALYSIS_SCHEMA);
  if (error) console.warn('[RoofVision] analyzeRoofOutline failed:', error);
  return result;
}

/** Step 1b: Analyze a single user-drawn roof segment against the satellite image. */
export async function analyzeRoofSegment(
  imageData: { data: string; mimeType: string } | null,
  segmentNormalized: { x: number; y: number }[],
  segmentIndex: number,
  existingSegmentsNormalized?: { x: number; y: number }[][],
  options?: { refinement?: boolean },
): Promise<SegmentAnalysis | null> {
  const segStr = segmentNormalized.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ');
  const contextStr = existingSegmentsNormalized && existingSegmentsNormalized.length > 0
    ? `\nPreviously mapped segments for context: ${existingSegmentsNormalized.length} segment(s) already identified.`
    : '';
  const refinementStr = options?.refinement
    ? '\nThe user re-ran this analysis after refining the polygon — prioritize accurate pitch (ratio), slope-facing cardinal direction, and roof type; be specific to what the satellite image shows.'
    : '';
  const imgPart = buildImagePart(imageData);
  const textPart: Part = {
    text: `You are analyzing a north-up satellite image of a building rooftop.${imgPart ? '' : ' (No image provided — use coordinates only.)'}
Segment ${segmentIndex + 1} has been drawn with these normalized image coordinates:
${segStr}${contextStr}${refinementStr}

Classify this roof segment:
- type: the structural type (flat/gable/hip/shed/valley/dormer/mansard)
- facingDirection: which cardinal direction this slope faces (N/NE/E/SE/S/SW/W/NW/flat)
- pitchEstimate: slope ratio (flat/2/12/3/12/4/12/5/12/6/12/8/12/10/12/12/12/steep)
- confidence: 0-1 how confident you are
- notes: 1 sentence describing what you see

Return JSON only.`,
  } as Part;
  const parts: Part[] = [imgPart, textPart].filter(Boolean) as Part[];
  const { result, error } = await runGeminiWithSchema<SegmentAnalysis>(parts, SEGMENT_ANALYSIS_SCHEMA, 0.25, 'segment_analysis');
  if (error) console.warn('[RoofVision] analyzeRoofSegment failed:', error);
  else if (!result) console.warn('[RoofVision] analyzeRoofSegment returned null (all models failed)');
  return result;
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
  const { result, error } = await runGeminiWithSchema<StructuralDetection>(parts, STRUCTURAL_DETECTION_SCHEMA, 0.25, 'segment_analysis');
  if (error) console.warn('[RoofVision] detectRoofStructure failed:', error);
  return result;
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

  const { result, error } = await runGeminiWithSchema<CombinedRoofAnalysis>(parts, COMBINED_ANALYSIS_SCHEMA, 0.3, 'segment_analysis');
  if (error) console.warn('[RoofVision] analyzeCombinedRoof failed:', error);
  return result;
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
