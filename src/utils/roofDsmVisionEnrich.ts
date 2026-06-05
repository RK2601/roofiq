/**
 * DSM + satellite vision — Gemini labels DSM-derived roof planes using the same
 * static-map image (semantic labels, visual pitch/facing as a cross-check).
 * Plane geometry and DSM pitch/facing stay authoritative for measurements.
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import {
  enqueueGeminiRequest,
  GEMINI_QUOTA_ERROR,
  isGemini429OrQuotaError,
  readGeminiResponseText,
  triggerGeminiQuotaCooldown,
  withGemini429Retries,
} from './gemini429';
import { latLngToImageNorm } from './roofVision';
import type { SegmentAnalysis } from './roofVision';

const ROOF_TYPES: readonly SegmentAnalysis['type'][] = [
  'flat', 'gable', 'hip', 'shed', 'valley', 'dormer', 'mansard',
];

export interface DsmPlaneVisionInput {
  index: number;
  path: { lat: number; lng: number }[];
  dsmPitchDeg: number;
  dsmPitchRatio: string;
  dsmFacing: string;
}

export interface DsmVisionEnrichment {
  index: number;
  label: string;
  roofType: SegmentAnalysis['type'];
  visionPitchEstimate: string;
  visionFacing: string;
  visionConfidence: number;
  agreesWithDsm: boolean;
  notes: string;
}

const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,      threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const ENRICH_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    segments: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          index: { type: SchemaType.NUMBER },
          label: { type: SchemaType.STRING },
          roofType: { type: SchemaType.STRING },
          visionPitchEstimate: { type: SchemaType.STRING },
          visionFacing: { type: SchemaType.STRING },
          visionConfidence: { type: SchemaType.NUMBER },
          agreesWithDsm: { type: SchemaType.BOOLEAN },
          notes: { type: SchemaType.STRING },
        },
        required: [
          'index', 'label', 'roofType', 'visionPitchEstimate', 'visionFacing',
          'visionConfidence', 'agreesWithDsm', 'notes',
        ],
      },
    },
  },
  required: ['segments'],
};

function parseRoofType(raw: string): SegmentAnalysis['type'] {
  const t = (raw || 'gable').toLowerCase().trim();
  return (ROOF_TYPES as readonly string[]).includes(t) ? (t as SegmentAnalysis['type']) : 'gable';
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    return Number.isFinite(p) ? p : NaN;
  }
  return NaN;
}

function buildPrompt(
  planes: DsmPlaneVisionInput[],
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageSize: number,
): string {
  const center = { lat: centerLat, lng: centerLng };
  const lines = planes.map(p => {
    const norms = p.path.map(ll => latLngToImageNorm(ll, center, zoom, imageSize));
    const coordStr = norms.map(n => `(${n.x.toFixed(3)},${n.y.toFixed(3)})`).join(' → ');
    return (
      `Plane index ${p.index}: DSM pitch ${p.dsmPitchDeg}° (${p.dsmPitchRatio}), facing ${p.dsmFacing}. ` +
      `Polygon (normalized, x=left→right, y=top→bottom): ${coordStr}`
    );
  }).join('\n');

  return `You analyze north-up satellite imagery of a building roof.

The roof planes below were detected from elevation (DSM) data. Their footprints and DSM slope data are authoritative — do not invent extra planes or deny listed ones.

For EVERY plane index listed, describe what you see and return one JSON object per plane:
- label: short human name (e.g. "north parapet flat", "main south slope", "mechanical screen")
- roofType: one of: flat, gable, hip, shed, valley, dormer, mansard
- visionPitchEstimate: X/12 format (visual estimate; use 0/12 for clearly flat)
- visionFacing: N, NE, E, SE, S, SW, W, NW, or FLAT
- visionConfidence: 0.0–1.0
- agreesWithDsm: true if visual pitch/facing roughly matches DSM values given
- notes: one sentence (visible equipment, shadows, membrane color, parapet, etc.)

DSM planes:
${lines}

Return JSON {"segments":[...]} only — one entry per index in [${planes.map(p => p.index).join(', ')}].`;
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

function normalizeEnrichmentList(raw: { segments?: unknown }): DsmVisionEnrichment[] {
  const segs = raw.segments;
  if (!Array.isArray(segs)) return [];
  const out: DsmVisionEnrichment[] = [];
  for (const row of segs) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const index = num(r.index);
    if (!Number.isInteger(index) || index < 0) continue;
    const label = String(r.label ?? '').trim() || `Plane ${index}`;
    const roofType = parseRoofType(String(r.roofType ?? 'gable'));
    const visionPitchEstimate = String(r.visionPitchEstimate ?? '6/12').trim() || '6/12';
    const visionFacing = String(r.visionFacing ?? 'FLAT').trim().toUpperCase() || 'FLAT';
    const visionConfidence = Math.max(0, Math.min(1, num(r.visionConfidence) || 0.5));
    const agreesWithDsm = Boolean(r.agreesWithDsm);
    const notes = String(r.notes ?? '').trim() || '—';
    out.push({
      index,
      label,
      roofType,
      visionPitchEstimate,
      visionFacing,
      visionConfidence,
      agreesWithDsm,
      notes,
    });
  }
  return out;
}

/**
 * Label DSM-derived planes using Gemini + the same satellite frame used elsewhere (zoom 20, 640 logical).
 */
export async function enrichDsmSegmentsWithSatelliteVision(
  imageBase64: string,
  mimeType: string,
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageSize: number,
  planes: DsmPlaneVisionInput[],
): Promise<DsmVisionEnrichment[]> {
  if (!planes.length) return [];
  const apiKey = readGeminiApiKey();
  if (!apiKey) throw new Error('NO_GEMINI_KEY');
  if (!imageBase64 || imageBase64.length < 100) throw new Error('NO_IMAGE');

  const genAI = new GoogleGenerativeAI(apiKey);
  const textPrompt = buildPrompt(planes, centerLat, centerLng, zoom, imageSize);
  const parts: Part[] = [
    { inlineData: { mimeType: mimeType || 'image/png', data: imageBase64 } } as Part,
    { text: textPrompt } as Part,
  ];

  return enqueueGeminiRequest(async () => {
  let lastError = 'ALL_MODELS_FAILED';

  modelLoop: for (const modelId of GEMINI_MODEL_IDS) {
    for (const mode of ['structured', 'plain'] as const) {
      try {
        const generationConfig =
          mode === 'structured'
            ? {
                responseMimeType: 'application/json' as const,
                responseSchema: ENRICH_SCHEMA,
                temperature: 0.2,
                maxOutputTokens: 8192,
              }
            : {
                responseMimeType: 'application/json' as const,
                temperature: 0.2,
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
        const parsed = JSON.parse(cleaned) as { segments?: unknown };
        const enrichments = normalizeEnrichmentList(parsed);
        if (enrichments.length > 0) return enrichments;

        lastError = 'EMPTY_ENRICHMENT';
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
          triggerGeminiQuotaCooldown('[RoofDSM] Gemini rate-limited — pausing API calls for 15 minutes.');
          throw new Error(GEMINI_QUOTA_ERROR);
        }
      }
    }
  }

  throw new Error(`DSM vision enrichment failed: ${lastError}`);
  }); // enqueueGeminiRequest
}
