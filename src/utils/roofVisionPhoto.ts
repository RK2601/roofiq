/**
 * User-photo roof cue extraction (wizard Phase 2). Kept separate from `roofVision.ts`
 * so static-map / heuristic paths stay the default surface for quick analysis.
 */
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { GenerateContentResult, Part, Schema } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import { enqueueGeminiRequest, isGemini429OrQuotaError, withGemini429Retries } from './gemini429';
import { callOpenAiFallbackJson } from './openaiFallback';
import type { VisionCueRaw } from './roofVision';

const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const ROOF_PHOTO_CUE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    qualityScore: { type: SchemaType.NUMBER },
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
  required: ['qualityScore', 'cues'],
};

export interface RoofPhotoCueAnalysis {
  qualityScore: number;
  cues: VisionCueRaw[];
  byType: Record<VisionCueRaw['type'], number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readResponseText(result: GenerateContentResult): string {
  return result.response.text();
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

async function fileToBase64(file: File): Promise<{ data: string; mimeType: string }> {
  return blobToBase64(file);
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
      : cues.reduce((sum, cue) => sum + cue.confidence, 0) / Math.max(cues.length, 1),
    0,
    1
  );
  return { qualityScore, cues, byType };
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

  return enqueueGeminiRequest(async () => {
  let receivedApiOk = false;
  let everyFailureWas429 = true;
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
      const result = await withGemini429Retries(() => model.generateContent(parts));
      receivedApiOk = true;
      everyFailureWas429 = false;
      const analysis = parsePhotoCueJson(readResponseText(result));
      if (analysis.cues.length > 0 || analysis.qualityScore > 0.25) return analysis;
    } catch (e) {
      if (!isGemini429OrQuotaError(e)) everyFailureWas429 = false;
      // Try next model.
    }
  }

  if (!receivedApiOk && everyFailureWas429) {
    const fallbackPrompt = `${prompt}\n\nReturn JSON only: {\"qualityScore\":0..1,\"cues\":[{\"type\":\"ridge|hip|valley|eave|rake\",\"x1\":0..1,\"y1\":0..1,\"x2\":0..1,\"y2\":0..1,\"confidence\":0..1}]}`;
    const openAi = await callOpenAiFallbackJson<{ qualityScore?: number; cues?: VisionCueRaw[] }>({
      task: 'roof_cues',
      prompt: fallbackPrompt,
      image: { data: imageData.data, mimeType: imageData.mimeType || 'image/jpeg' },
    }).catch(() => null);

    if (!openAi) return null;
    const cues = Array.isArray(openAi.cues) ? openAi.cues : [];
    const qualityScore =
      typeof openAi.qualityScore === 'number'
        ? clamp(openAi.qualityScore, 0, 1)
        : cues.reduce((sum, cue) => sum + cue.confidence, 0) / Math.max(cues.length, 1);
    const byType: Record<VisionCueRaw['type'], number> = { ridge: 0, hip: 0, valley: 0, eave: 0, rake: 0 };
    cues.forEach(c => {
      if (c?.type in byType) byType[c.type] += 1;
    });
    return { qualityScore: clamp(qualityScore, 0, 1), cues, byType };
  }
  return null;
  }); // enqueueGeminiRequest
}
