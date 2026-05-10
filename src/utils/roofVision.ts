import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { GenerateContentResult, Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import type { AiRoofCue, Vec2 } from './roofStructure';
import type { SolarBuildingInsights, SolarLatLng, SolarRoofSegment } from './solar';

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

export interface RoofPhotoCueAnalysis {
  qualityScore: number; // 0..1
  cues: VisionCueRaw[];
  byType: Record<VisionCueRaw['type'], number>;
}

export interface AutoMapViewCapture {
  id: string;
  label: string;
  url: string;
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

export function buildAutoMapViewCaptures(
  center: { lat: number; lng: number },
  apiKey: string
): AutoMapViewCapture[] {
  const metersToLat = (m: number) => m / 111_320;
  const metersToLng = (m: number, lat: number) => m / (111_320 * Math.cos((lat * Math.PI) / 180));
  const offset = 14;
  const dLat = metersToLat(offset);
  const dLng = metersToLng(offset, center.lat);

  const views = [
    { id: 'v-center', label: 'Center Zoom 20', lat: center.lat, lng: center.lng, zoom: 20 },
    { id: 'v-nw', label: 'NW Offset', lat: center.lat + dLat, lng: center.lng - dLng, zoom: 20 },
    { id: 'v-ne', label: 'NE Offset', lat: center.lat + dLat, lng: center.lng + dLng, zoom: 20 },
    { id: 'v-sw', label: 'SW Offset', lat: center.lat - dLat, lng: center.lng - dLng, zoom: 20 },
    { id: 'v-se', label: 'SE Offset', lat: center.lat - dLat, lng: center.lng + dLng, zoom: 20 },
    { id: 'v-wide', label: 'Wider Zoom 19', lat: center.lat, lng: center.lng, zoom: 19 },
  ] as const;

  return views.map(view => ({
    id: view.id,
    label: view.label,
    url:
      `https://maps.googleapis.com/maps/api/staticmap?center=${view.lat},${view.lng}` +
      `&zoom=${view.zoom}&size=640x640&maptype=satellite&scale=2&key=${apiKey}`,
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
