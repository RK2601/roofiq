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
  'gemini-1.5-flash',
  'gemini-2.0-flash',
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

Return 3–8 planes maximum. If only one plane is visible (flat roof), return one plane.

Rules:
  - Only the MAIN building's roof. Ignore neighboring buildings, driveways, trees, ground.
  - Each polygon must have at least 4 vertices (rectangular roofs need all 4 corners).
  - Complex shapes (L-shaped, T-shaped) need more vertices to capture corners accurately.
  - Polygons must NOT overlap significantly.
  - "facing" must be one of: N, NE, E, SE, S, SW, W, NW, or FLAT
  - "pitchEstimate" must be in X/12 format e.g. "6/12", "4/12", "0/12"
  - "confidence" is 0.0–1.0: how confident you are this is a real distinct roof plane
  - "label" should be descriptive: "main south slope", "north back slope", "left dormer", "garage flat", etc.`;

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

  for (const modelId of GEMINI_MODEL_IDS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: AI_SEGMENT_SCHEMA,
          temperature: 0.15,
          maxOutputTokens: 3000,
        },
        safetySettings: SAFETY_RELAXED,
      });

      const result = await Promise.race([
        model.generateContent(parts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout:${modelId}`)), 35_000)
        ),
      ]);

      const text = result.response.text();
      const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      const parsed: GeminiSegmentResponse = JSON.parse(cleaned);

      if (!parsed.planes || !Array.isArray(parsed.planes) || parsed.planes.length === 0) {
        lastError = 'EMPTY_RESPONSE';
        continue;
      }

      // Convert normalized vertices → lat/lng paths
      const planes: AiSegmentedPlane[] = [];
      for (const plane of parsed.planes) {
        if (!plane.vertices || plane.vertices.length < 3) continue;
        // Filter to valid coords
        const validVerts = plane.vertices.filter(
          v => typeof v.x === 'number' && typeof v.y === 'number' &&
               v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1
        );
        if (validVerts.length < 3) continue;

        const path = validVerts.map(v =>
          normToLatLng(v.x, v.y, centerLat, centerLng, zoom, imageSize)
        );

        planes.push({
          path,
          label: plane.label || `Plane ${planes.length + 1}`,
          facingDirection: (plane.facing || 'FLAT').toUpperCase(),
          pitchEstimate: plane.pitchEstimate || '0/12',
          confidence: Math.max(0, Math.min(1, plane.confidence ?? 0.5)),
        });
      }

      if (planes.length === 0) {
        lastError = 'NO_VALID_PLANES';
        continue;
      }

      return planes;
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
  }

  throw new Error(`AI segmentation failed: ${lastError}`);
}
