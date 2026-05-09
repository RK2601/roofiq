import { GoogleGenerativeAI } from '@google/generative-ai';
import { readGeminiApiKey } from './googleAiKey';

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

const ANALYSIS_PROMPT = `You are an expert roofing inspector analyzing a satellite image of a rooftop.
Analyze the visible roof condition and return ONLY a valid JSON object — no markdown, no explanation, no code block.

{
  "condition": "Excellent" | "Good" | "Fair" | "Poor" | "Critical",
  "condition_score": <integer 1-10, 10 is perfect>,
  "issues": [<up to 5 specific visible issues, empty array if none>],
  "urgency": "Low" | "Medium" | "High" | "Urgent",
  "estimated_remaining_life": "<e.g. '15-20 years', '5-10 years', '1-3 years', 'Immediate replacement needed'>",
  "recommendation": "<specific actionable recommendation in 1-2 sentences>",
  "marketing_message": "<compelling 1-2 sentence outreach message for the property owner about their roof condition>"
}

Assess based on: discoloration, missing/damaged shingles, moss/algae, sagging, flashing damage, debris, granule loss, storm damage. If image resolution is insufficient, use "Fair" as the condition.`;

const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/;

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

export async function analyzeRoofImage(imageUrl: string): Promise<RoofAnalysis> {
  const apiKey = readGeminiApiKey();
  if (!apiKey) throw new Error('GOOGLE_AI_KEY_MISSING');

  const imageData = await urlToBase64(imageUrl);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  let result;
  try {
    result = await model.generateContent([
      { inlineData: imageData },
      ANALYSIS_PROMPT,
    ]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/API[_ ]?key|API_KEY|403|401|permission|PERMISSION_DENIED/i.test(msg)) {
      throw new Error('GEMINI_AUTH_FAILED');
    }
    throw e;
  }

  const text = result.response.text();
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned) as RoofAnalysis;
  } catch {
    throw new Error('GEMINI_BAD_JSON');
  }
}
