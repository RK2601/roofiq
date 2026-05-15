import type { RoofAnalysis } from './ai';
import {
  isDbConfigured,
  loadMarketingProspectsFromDb,
  saveMarketingProspectsToDb,
  type MarketingProspectStored,
} from './db';

export type { MarketingProspectStored };

const LS_KEY = 'roofiq_marketing_prospects_v1';

function reviveAnalysis(raw: unknown): RoofAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const condition = o.condition;
  if (
    condition !== 'Excellent' &&
    condition !== 'Good' &&
    condition !== 'Fair' &&
    condition !== 'Poor' &&
    condition !== 'Critical'
  ) {
    return null;
  }
  if (typeof o.condition_score !== 'number' || !Array.isArray(o.issues)) return null;
  if (typeof o.urgency !== 'string' || typeof o.estimated_remaining_life !== 'string') return null;
  if (typeof o.recommendation !== 'string' || typeof o.marketing_message !== 'string') return null;
  return {
    condition,
    condition_score: o.condition_score,
    issues: o.issues.filter((x): x is string => typeof x === 'string'),
    urgency: o.urgency as RoofAnalysis['urgency'],
    estimated_remaining_life: o.estimated_remaining_life,
    recommendation: o.recommendation,
    marketing_message: o.marketing_message,
  };
}

function reviveProspect(raw: unknown): MarketingProspectStored | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const latlng = o.latlng as { lat?: unknown; lng?: unknown } | undefined;
  if (!latlng || typeof latlng.lat !== 'number' || typeof latlng.lng !== 'number') return null;
  if (typeof o.address !== 'string' || typeof o.snapshot_url !== 'string') return null;
  const status = o.status;
  if (status !== 'analyzing' && status !== 'done' && status !== 'error') return null;
  return {
    id: o.id,
    latlng: { lat: latlng.lat, lng: latlng.lng },
    address: o.address,
    snapshot_url: o.snapshot_url,
    status,
    analysis: reviveAnalysis(o.analysis),
    error: typeof o.error === 'string' ? o.error : undefined,
    inCampaign: Boolean(o.inCampaign),
  };
}

function loadFromLocalStorage(): MarketingProspectStored[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: MarketingProspectStored[] = [];
    for (const item of parsed) {
      const p = reviveProspect(item);
      if (p) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

function saveToLocalStorage(prospects: MarketingProspectStored[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prospects));
  } catch {
    /* quota / private mode */
  }
}

/** Load saved prospects (DB when configured, else localStorage). */
export async function loadMarketingProspects(): Promise<MarketingProspectStored[]> {
  if (isDbConfigured()) {
    try {
      const rows = await loadMarketingProspectsFromDb();
      saveToLocalStorage(rows);
      return rows;
    } catch (e) {
      console.error('[RoofIQ] loadMarketingProspects db', e);
    }
  }
  return loadFromLocalStorage();
}

/** Persist prospects + campaign flags (localStorage always; DB when configured). */
export async function persistMarketingProspects(prospects: MarketingProspectStored[]): Promise<void> {
  saveToLocalStorage(prospects);
  if (!isDbConfigured()) return;
  try {
    await saveMarketingProspectsToDb(prospects);
  } catch (e) {
    console.error('[RoofIQ] persistMarketingProspects db', e);
    throw e;
  }
}
