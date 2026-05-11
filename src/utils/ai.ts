import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
} from '@google/generative-ai';
import type { GenerateContentResult, Schema, Part } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';
import { isGemini429OrQuotaError, withGemini429Retries } from './gemini429';
import { callOpenAiFallbackJson } from './openaiFallback';
import type { SolarBuildingInsights } from './solar';
import { azimuthLabel, formatImageryDate } from './solar';

export interface RoofAnalysis {
  condition: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Critical';
  condition_score: number;
  issues: string[];
  urgency: 'Low' | 'Medium' | 'High' | 'Urgent';
  estimated_remaining_life: string;
  recommendation: string;
  marketing_message: string;
}

export const CONDITION_COLORS: Record<RoofAnalysis['condition'], string> = {
  Excellent: '#22c55e',
  Good:      '#84cc16',
  Fair:      '#f59e0b',
  Poor:      '#ef4444',
  Critical:  '#991b1b',
};

export const CONDITION_BG: Record<RoofAnalysis['condition'], string> = {
  Excellent: 'bg-green-100 text-green-700',
  Good:      'bg-lime-100 text-lime-700',
  Fair:      'bg-amber-100 text-amber-700',
  Poor:      'bg-red-100 text-red-700',
  Critical:  'bg-red-900 text-red-100',
};

export const URGENCY_BG: Record<RoofAnalysis['urgency'], string> = {
  Low:    'bg-green-100 text-green-700',
  Medium: 'bg-amber-100 text-amber-700',
  High:   'bg-red-100 text-red-700',
  Urgent: 'bg-red-900 text-red-100',
};

const ANALYSIS_PROMPT = `You are an expert roofing inspector analyzing a high-resolution aerial image of a rooftop.
Analyze the visible roof condition and return a JSON object with the required fields (see schema).
Assess based on: discoloration, missing/damaged shingles, moss/algae, sagging, flashing damage, debris, granule loss, storm damage. If image resolution is insufficient, use "Fair" as the condition.`;

function buildSolarContext(solar: SolarBuildingInsights): string {
  const segments = (solar.roofSegmentStats ?? [])
    .map((s, i) => {
      const areaSqFt = Math.round(s.stats.areaMeters2 * 10.7639);
      return `  Segment ${i + 1}: ${areaSqFt} sq ft, pitch ~${Math.round(s.pitchDegrees)}°, facing ${azimuthLabel(s.azimuthDegrees)}`;
    })
    .join('\n');
  const date = formatImageryDate(solar.imageryDate);
  return `\n\nAdditional data from Google Solar API (imagery quality: ${solar.imageryQuality}, captured ${date}):\n${segments}\nUse this structural data alongside the image to improve accuracy of your assessment.`;
}

/** Forces valid JSON shape from the model (avoids markdown / prose around JSON). */
const ROOF_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    condition: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['Excellent', 'Good', 'Fair', 'Poor', 'Critical'],
    },
    condition_score: { type: SchemaType.INTEGER },
    issues: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      maxItems: 8,
    },
    urgency: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['Low', 'Medium', 'High', 'Urgent'],
    },
    estimated_remaining_life: { type: SchemaType.STRING },
    recommendation: { type: SchemaType.STRING },
    marketing_message: { type: SchemaType.STRING },
  },
  required: [
    'condition',
    'condition_score',
    'issues',
    'urgency',
    'estimated_remaining_life',
    'recommendation',
    'marketing_message',
  ],
};

/** Prefer current models; `gemini-2.0-flash` is deprecated but kept last as a fallback. */
const GEMINI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
] as const;

const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/;

const SAFETY_RELAXED = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

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

/** Fetch image bytes; retry via same-origin proxy (dev + Vercel `/api`) when Static Maps blocks browser CORS. */
async function urlToBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const fetchOne = async (u: string) => {
    const response = await fetch(u);
    if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
    const blob = await response.blob();
    if (blob.size < 400) throw new Error('IMAGE_TOO_SMALL');
    const ct = blob.type || '';
    if (ct.includes('html') || ct.includes('json') || ct.includes('text/')) {
      throw new Error('IMAGE_NOT_MAP');
    }
    return blobToBase64(blob);
  };

  try {
    return await fetchOne(url);
  } catch (first) {
    const proxied = staticMapProxyUrl(url);
    if (proxied === url) throw first;
    return await fetchOne(proxied);
  }
}

function readResponseText(result: GenerateContentResult): string {
  const res = result.response;
  try {
    return res.text();
  } catch (first) {
    const pf = res.promptFeedback;
    if (pf?.blockReason) {
      throw new Error(`GEMINI_BLOCKED:${pf.blockReason}`);
    }
    const c0 = res.candidates?.[0];
    if (c0?.finishReason && c0.finishReason !== 'STOP') {
      throw new Error(`GEMINI_FINISH:${c0.finishReason}`);
    }
    throw first instanceof Error ? first : new Error(String(first));
  }
}

function parseRoofJson(text: string): RoofAnalysis {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as RoofAnalysis;
  if (!parsed || typeof parsed.condition !== 'string' || typeof parsed.urgency !== 'string') {
    throw new Error('GEMINI_BAD_JSON');
  }
  return parsed;
}

function isGeminiAuthError(msg: string): boolean {
  return /API[_ ]?key|API_KEY|403|401|permission|PERMISSION_DENIED|API key not valid/i.test(msg);
}

function isModelOrEndpointUnavailable(msg: string): boolean {
  return /\[404\b|\b404\b|not found|NOT_FOUND|UNIMPLEMENTED|invalid model|Model .* not found|does not exist|is not supported for generateContent/i.test(
    msg
  );
}

function structuredOutputUnsupported(msg: string): boolean {
  return /responseSchema|responseMimeType|JSON schema|invalid argument|400\b|Unsupported/i.test(msg);
}

/** Shared Gemini model loop — accepts pre-built parts array. */
async function runGeminiLoop(parts: Part[]): Promise<RoofAnalysis> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) throw new Error('GOOGLE_AI_KEY_MISSING');

  const genAI = new GoogleGenerativeAI(apiKey);

  const structuredConfig = {
    responseMimeType: 'application/json' as const,
    responseSchema: ROOF_RESPONSE_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 2048,
  };
  const plainJsonConfig = {
    responseMimeType: 'application/json' as const,
    temperature: 0.2,
    maxOutputTokens: 2048,
  };

  let lastError: unknown;

  for (const modelId of GEMINI_MODEL_IDS) {
    for (const mode of ['structured', 'plain'] as const) {
      try {
        const generationConfig = mode === 'structured' ? structuredConfig : plainJsonConfig;
        const model = genAI.getGenerativeModel({
          model: modelId,
          generationConfig,
          safetySettings: SAFETY_RELAXED,
        });
        const result = await withGemini429Retries(() => model.generateContent(parts));
        const text = readResponseText(result);
        return parseRoofJson(text);
      } catch (e: unknown) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('GEMINI_BLOCKED') || msg.startsWith('GEMINI_FINISH')) throw e;
        if (isGeminiAuthError(msg)) throw new Error('GEMINI_AUTH_FAILED');
        if (mode === 'structured' && structuredOutputUnsupported(msg)) continue;
        if (isModelOrEndpointUnavailable(msg)) break;
        if (isGemini429OrQuotaError(e)) continue;
        throw e;
      }
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('GEMINI_MODEL_UNAVAILABLE');
}

/** Analyse a roof from a satellite/static-map URL (existing flow). */
export async function analyzeRoofImage(
  imageUrl: string,
  solarInsights?: SolarBuildingInsights | null
): Promise<RoofAnalysis> {
  const imageData = await urlToBase64(imageUrl);
  const prompt = solarInsights
    ? ANALYSIS_PROMPT + buildSolarContext(solarInsights)
    : ANALYSIS_PROMPT;
  const parts: Part[] = [
    { inlineData: { mimeType: imageData.mimeType || 'image/png', data: imageData.data } } as Part,
    { text: prompt } as Part,
  ];
  try {
    return await runGeminiLoop(parts);
  } catch (e) {
    if (!isGemini429OrQuotaError(e)) throw e;
    const fallbackPrompt =
      `${prompt}\n\nReturn JSON only with keys: condition, condition_score, issues, urgency, estimated_remaining_life, recommendation, marketing_message.`;
    return callOpenAiFallbackJson<RoofAnalysis>({
      task: 'roof_analysis',
      prompt: fallbackPrompt,
      image: { data: imageData.data, mimeType: imageData.mimeType || 'image/png' },
    });
  }
}

/** Analyse a roof from a user-uploaded File (drone photo, site photo, etc.). */
export async function analyzeRoofImageFromFile(
  file: File,
  solarInsights?: SolarBuildingInsights | null
): Promise<RoofAnalysis> {
  const { data, mimeType } = await blobToBase64(file);
  const prompt =
    `${ANALYSIS_PROMPT}\n\nNote: This image was uploaded directly by the user (e.g. a drone photo or on-site photo). Analyze it with the same criteria — the image may show the roof at an angle or from street level; do your best to assess visible condition.` +
    (solarInsights ? buildSolarContext(solarInsights) : '');
  const parts: Part[] = [
    { inlineData: { mimeType: mimeType || 'image/jpeg', data } } as Part,
    { text: prompt } as Part,
  ];
  try {
    return await runGeminiLoop(parts);
  } catch (e) {
    if (!isGemini429OrQuotaError(e)) throw e;
    const fallbackPrompt =
      `${prompt}\n\nReturn JSON only with keys: condition, condition_score, issues, urgency, estimated_remaining_life, recommendation, marketing_message.`;
    return callOpenAiFallbackJson<RoofAnalysis>({
      task: 'roof_analysis',
      prompt: fallbackPrompt,
      image: { data, mimeType: mimeType || 'image/jpeg' },
    });
  }
}

/** Structured Gemini read on a max-res static capture (often with user-drawn overlays). */
export interface RoofGeometryDetail {
  summary: string;
  steep_slopes: string[];
  valleys: string[];
  ridges_hips: string[];
  perimeters_eaves_rakes: string[];
  caveats: string[];
}

const GEOMETRY_PROMPT = `You are a senior roofing estimator viewing a MAXIMUM-RESOLUTION north-up satellite capture of a rooftop (Static Maps at high zoom, scale=2). The image may include semi-transparent colored polygons from field tracing — treat them as approximate facet boundaries, not survey-grade.
Act as if you had a sharper inspection pass: infer likely ridges, hips, valleys, eaves, rakes, and steeper pitches from shadows, texture breaks, and edges. Note uncertainty where pixels blur.
Return JSON only matching the schema. Use short phrases in arrays (max 6 items each).`;

const GEOMETRY_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    steep_slopes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: 8 },
    valleys: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: 8 },
    ridges_hips: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: 8 },
    perimeters_eaves_rakes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: 8 },
    caveats: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, maxItems: 6 },
  },
  required: ['summary', 'steep_slopes', 'valleys', 'ridges_hips', 'perimeters_eaves_rakes', 'caveats'],
};

function parseGeometryJson(text: string): RoofGeometryDetail {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as RoofGeometryDetail;
  if (!parsed || typeof parsed.summary !== 'string') throw new Error('GEMINI_BAD_JSON');
  return {
    summary: parsed.summary,
    steep_slopes: Array.isArray(parsed.steep_slopes) ? parsed.steep_slopes : [],
    valleys: Array.isArray(parsed.valleys) ? parsed.valleys : [],
    ridges_hips: Array.isArray(parsed.ridges_hips) ? parsed.ridges_hips : [],
    perimeters_eaves_rakes: Array.isArray(parsed.perimeters_eaves_rakes) ? parsed.perimeters_eaves_rakes : [],
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
  };
}

async function runGeminiGeometryLoop(parts: Part[]): Promise<RoofGeometryDetail> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) throw new Error('GOOGLE_AI_KEY_MISSING');

  const genAI = new GoogleGenerativeAI(apiKey);
  const structuredConfig = {
    responseMimeType: 'application/json' as const,
    responseSchema: GEOMETRY_RESPONSE_SCHEMA,
    temperature: 0.15,
    maxOutputTokens: 2048,
  };
  const plainJsonConfig = {
    responseMimeType: 'application/json' as const,
    temperature: 0.15,
    maxOutputTokens: 2048,
  };

  let lastError: unknown;
  for (const modelId of GEMINI_MODEL_IDS) {
    for (const mode of ['structured', 'plain'] as const) {
      try {
        const generationConfig = mode === 'structured' ? structuredConfig : plainJsonConfig;
        const model = genAI.getGenerativeModel({
          model: modelId,
          generationConfig,
          safetySettings: SAFETY_RELAXED,
        });
        const result = await withGemini429Retries(() => model.generateContent(parts));
        const text = readResponseText(result);
        return parseGeometryJson(text);
      } catch (e: unknown) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('GEMINI_BLOCKED') || msg.startsWith('GEMINI_FINISH')) throw e;
        if (isGeminiAuthError(msg)) throw new Error('GEMINI_AUTH_FAILED');
        if (mode === 'structured' && structuredOutputUnsupported(msg)) continue;
        if (isModelOrEndpointUnavailable(msg)) break;
        if (isGemini429OrQuotaError(e)) continue;
        throw e;
      }
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('GEMINI_MODEL_UNAVAILABLE');
}

/**
 * Second-pass Gemini vision on the same HD static capture used for condition checks:
 * explicit slopes, valleys, ridges/hips, and perimeters (complements line-cue detection).
 */
export async function analyzeRoofGeometryFromCapture(
  imageUrl: string,
  solarInsights?: SolarBuildingInsights | null
): Promise<RoofGeometryDetail> {
  const imageData = await urlToBase64(imageUrl);
  const prompt =
    GEOMETRY_PROMPT + (solarInsights ? `\n\nSolar context for alignment:\n${buildSolarContext(solarInsights)}` : '');
  const parts: Part[] = [
    { inlineData: { mimeType: imageData.mimeType || 'image/png', data: imageData.data } } as Part,
    { text: prompt } as Part,
  ];
  try {
    return await runGeminiGeometryLoop(parts);
  } catch (e) {
    if (!isGemini429OrQuotaError(e)) throw e;
    const fallbackPrompt =
      `${prompt}\n\nReturn JSON only with keys: summary, steep_slopes, valleys, ridges_hips, perimeters_eaves_rakes, caveats.`;
    return callOpenAiFallbackJson<RoofGeometryDetail>({
      task: 'roof_geometry',
      prompt: fallbackPrompt,
      image: { data: imageData.data, mimeType: imageData.mimeType || 'image/png' },
    });
  }
}
