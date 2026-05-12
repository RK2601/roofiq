/**
 * roofAiSegment.ts
 *
 * AI Visual Segmentation — inspired by the DeepLabv3+ aerial imagery paper.
 *
 * Instead of running a local deep-learning model (which would require a GPU server),
 * we use Gemini's multimodal vision as the segmentation backbone:
 *   1. Feed the Google Maps satellite image to Gemini
 *   2. Ask it to identify every distinct roof plane as a normalized polygon
 *   3. Convert normalized [0,1] coordinates → lat/lng using the image center + zoom
 *
 * This achieves the same outcome as DeepLabv3+:
 *   • Visual boundary detection from aerial imagery
 *   • Per-plane semantic label (south slope, dormer, flat section, etc.)
 *   • Pitch + facing estimates
 *   • Pixel-level polygon precision
 *
 * Complementary to the DSM DBSCAN route (which clusters by slope/aspect values).
 * The two approaches agree on clear multi-pitch roofs and disagree on ambiguous cases —
 * giving the roofer a confidence signal.
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import { isGemini429OrQuotaError, readGeminiResponseText, withGemini429Retries } from './gemini429';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface AiSegmentedPlane {
  /** Ordered polygon vertices in lat/lng */
  path: { lat: number; lng: number }[];
  /** Human-readable label e.g. "main south slope" */
  label: string;
  /** Compass facing direction e.g. "SW" */
  facingDirection: string;
  /** Pitch estimate e.g. "6/12" */
  pitchEstimate: string;
  /** Gemini confidence 0–1 */
  confidence: number;
}

// ─── Internal Gemini types ─────────────────────────────────────────────────────

interface RawVertex { x: number; y: number }

interface RawPlane {
  label: string;
  facing: string;
  pitchEstimate: string;
  confidence: number;
  vertices: RawVertex[];
}

interface GeminiSegmentResponse {
  planes: RawPlane[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
] as const;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,      threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const AI_SEGMENT_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    planes: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          label:         { type: SchemaType.STRING },
          facing:        { type: SchemaType.STRING },
          pitchEstimate: { type: SchemaType.STRING },
          confidence:    { type: SchemaType.NUMBER },
          vertices: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
              },
              required: ['x', 'y'],
            },
          },
        },
        required: ['label', 'facing', 'pitchEstimate', 'confidence', 'vertices'],
      },
    },
  },
  required: ['planes'],
};

const SEGMENT_PROMPT = `You are a precision rooftop segmentation AI trained on aerial satellite imagery.

Your task: analyze this satellite image of a building and identify EVERY distinct roof plane visible on the main building.

A "roof plane" is a single, flat-angled surface — e.g. a south-facing slope, a north-facing slope, a dormer face, a flat section.

For each plane, provide its boundary as a polygon using NORMALIZED coordinates:
  - x = 0.0 means left edge, x = 1.0 means right edge
  - y = 0.0 means top edge, y = 1.0 means bottom edge
  - Clockwise vertex order
  - All x and y values MUST stay within 0.0 and 1.0 inclusive (clip if needed).

Return 3–8 planes maximum. If only one plane is visible (flat roof), return exactly one plane.

Rules:
  - Only the MAIN building's roof. Ignore neighboring buildings, driveways, trees, ground.
  - Each polygon must have at least 4 vertices (rectangular roofs need all 4 corners).
  - Complex shapes (L-shaped, T-shaped) need more vertices to capture corners accurately.
  - Polygons must NOT overlap significantly.
  - "facing" must be one of: N, NE, E, SE, S, SW, W, NW, or FLAT
  - "pitchEstimate" must be in X/12 format e.g. "6/12", "4/12", "0/12"
  - "confidence" is 0.0–1.0: how confident you are this is a real distinct roof plane
  - "label" should be descriptive: "main south slope", "north back slope", "left dormer", "garage flat", etc.

Return a single JSON object with key "planes" (array) only. No markdown.`;

// ─── Coordinate Conversion ─────────────────────────────────────────────────────

/**
 * Convert a normalized image coordinate (0–1 range) to lat/lng.
 *
 * The satellite image was captured at center (lat, lng) with zoom=20, size 640×640 px.
 * We use the inverse of the Web Mercator pixel formula.
 */
function normToLatLng(
  nx: number,
  ny: number,
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageSize: number,
): { lat: number; lng: number } {
  // pixels per degree longitude at this zoom (Web Mercator)
  const pixelsPerDegLng = (256 * Math.pow(2, zoom)) / 360;

  // degrees per pixel in longitude direction
  const degLngPerPx = 1 / pixelsPerDegLng;

  // degrees per pixel in latitude direction (Mercator compression at center lat)
  const degLatPerPx = degLngPerPx * Math.cos((centerLat * Math.PI) / 180);

  // pixel offsets from center (positive right/up)
  const dx = (nx - 0.5) * imageSize;
  const dy = (ny - 0.5) * imageSize;

  return {
    lat: centerLat - dy * degLatPerPx,   // y flipped: positive dy → south
    lng: centerLng + dx * degLngPerPx,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  return Math.max(0, Math.min(1, n));
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    return Number.isFinite(p) ? p : NaN;
  }
  return NaN;
}

function structuredOutputUnsupported(msg: string): boolean {
  return /responseSchema|responseMimeType|JSON schema|invalid argument|\b400\b|Unsupported|JSON mode|schema/i.test(msg);
}

function isModelOrEndpointUnavailable(msg: string): boolean {
  return /\[404\b|\b404\b|not found|NOT_FOUND|UNIMPLEMENTED|invalid model|Model .* not found|does not exist|is not supported for generateContent/i.test(
    msg,
  );
}

function isGeminiAuthError(msg: string): boolean {
  return /API[_ ]?key|API_KEY|403|401|permission|PERMISSION_DENIED|API key not valid/i.test(msg);
}

function planesFromParsed(
  parsed: GeminiSegmentResponse,
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageSize: number,
): AiSegmentedPlane[] {
  const planes: AiSegmentedPlane[] = [];
  if (!parsed.planes || !Array.isArray(parsed.planes)) return planes;

  for (const plane of parsed.planes) {
    if (!plane.vertices || plane.vertices.length < 3) continue;
    const clamped = plane.vertices
      .map(v => {
        const vx = typeof (v as { x?: unknown }).x !== 'undefined' ? num((v as { x: unknown }).x) : NaN;
        const vy = typeof (v as { y?: unknown }).y !== 'undefined' ? num((v as { y: unknown }).y) : NaN;
        return { x: clamp01(vx), y: clamp01(vy) };
      })
      .filter(v => Number.isFinite(v.x) && Number.isFinite(v.y));

    if (clamped.length < 3) continue;

    const path = clamped.map(v =>
      normToLatLng(v.x, v.y, centerLat, centerLng, zoom, imageSize),
    );

    const confRaw = num(plane.confidence);
    const confidence = Number.isFinite(confRaw)
      ? Math.max(0, Math.min(1, confRaw))
      : 0.5;

    planes.push({
      path,
      label: plane.label || `Plane ${planes.length + 1}`,
      facingDirection: String(plane.facing || 'FLAT').toUpperCase(),
      pitchEstimate: plane.pitchEstimate || '0/12',
      confidence,
    });
  }
  return planes;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Segment roof planes from a satellite image using Gemini vision.
 *
 * @param imageBase64  Base64-encoded satellite image (PNG/JPEG)
 * @param mimeType     MIME type of the image (e.g. 'image/png')
 * @param centerLat    Latitude of the image center
 * @param centerLng    Longitude of the image center
 * @param zoom         Google Maps zoom level used to capture the image (typically 20)
 * @param imageSize    Logical image size in pixels (typically 640)
 * @returns            Array of detected roof planes with lat/lng paths
 */
export async function segmentRoofFromSatellite(
  imageBase64: string,
  mimeType: string,
  centerLat: number,
  centerLng: number,
  zoom = 20,
  imageSize = 640,
): Promise<AiSegmentedPlane[]> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) throw new Error('NO_GEMINI_KEY');
  if (!imageBase64 || imageBase64.length < 100) throw new Error('NO_IMAGE');

  const genAI = new GoogleGenerativeAI(apiKey);

  const parts: Part[] = [
    { inlineData: { mimeType: mimeType || 'image/png', data: imageBase64 } } as Part,
    { text: SEGMENT_PROMPT } as Part,
  ];

  let lastError = 'ALL_MODELS_FAILED';

  modelLoop: for (const modelId of GEMINI_MODEL_IDS) {
    for (const mode of ['structured', 'plain'] as const) {
      try {
        const generationConfig =
          mode === 'structured'
            ? {
                responseMimeType: 'application/json' as const,
                responseSchema: AI_SEGMENT_SCHEMA,
                temperature: 0.15,
                maxOutputTokens: 8192,
              }
            : {
                responseMimeType: 'application/json' as const,
                temperature: 0.15,
                maxOutputTokens: 8192,
              };

        const model = genAI.getGenerativeModel({
          model: modelId,
          generationConfig,
          safetySettings: SAFETY_RELAXED,
        });

        const result = await Promise.race([
          withGemini429Retries(() => model.generateContent(parts)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout:${modelId}`)), 60_000),
          ),
        ]);

        const text = readGeminiResponseText(result);
        const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        const parsed: GeminiSegmentResponse = JSON.parse(cleaned);

        const planes = planesFromParsed(parsed, centerLat, centerLng, zoom, imageSize);
        if (planes.length > 0) return planes;

        lastError = 'NO_VALID_PLANES';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg.slice(0, 320);

        if (msg.startsWith('GEMINI_BLOCKED') || msg.startsWith('GEMINI_FINISH')) {
          throw err;
        }
        if (isGeminiAuthError(msg)) {
          throw new Error('NO_GEMINI_KEY');
        }
        if (mode === 'structured' && structuredOutputUnsupported(msg)) {
          continue;
        }
        if (isModelOrEndpointUnavailable(msg)) {
          continue modelLoop;
        }
        if (isGemini429OrQuotaError(err)) {
          continue;
        }
      }
    }
  }

  throw new Error(`AI segmentation failed: ${lastError}`);
}
