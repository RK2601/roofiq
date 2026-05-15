const KEY = 'roofiq_material_list_v1';

/** Stored row shapes mirror `MaterialEstimateReport` state (JSON-safe). */
export interface StoredBrandRow {
  id: string;
  name: string;
  unit: string;
  coverage: number;
  overrides: Partial<Record<number, number>>;
}

export interface StoredSection {
  key: string;
  title: string;
  isArea: boolean;
  baseQtyKey: string;
  brands: StoredBrandRow[];
}

export interface StoredOtherRow {
  id: string;
  label: string;
  unit: string;
  sheetLen: number;
  baseQtyKey: string;
  overrides: Partial<Record<number, number>>;
}

export interface MaterialListSnapshot {
  sections: StoredSection[];
  others: StoredOtherRow[];
}

function reviveOverrides(raw: unknown): Partial<Record<number, number>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<number, number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const nk = Number(k);
    if (!Number.isFinite(nk) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[nk] = v;
  }
  return out;
}

function reviveBrand(b: unknown): StoredBrandRow | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.unit !== 'string') return null;
  if (typeof o.coverage !== 'number' || !Number.isFinite(o.coverage)) return null;
  return {
    id: o.id,
    name: o.name,
    unit: o.unit,
    coverage: o.coverage,
    overrides: reviveOverrides(o.overrides),
  };
}

function reviveSection(s: unknown, expectedKey: string): StoredSection | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (o.key !== expectedKey || typeof o.title !== 'string' || typeof o.isArea !== 'boolean') return null;
  if (typeof o.baseQtyKey !== 'string') return null;
  if (!Array.isArray(o.brands)) return null;
  const brands: StoredBrandRow[] = [];
  for (const br of o.brands) {
    const row = reviveBrand(br);
    if (!row) return null;
    brands.push(row);
  }
  return { key: o.key as string, title: o.title, isArea: o.isArea, baseQtyKey: o.baseQtyKey, brands };
}

function reviveOther(r: unknown): StoredOtherRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.unit !== 'string') return null;
  if (typeof o.sheetLen !== 'number' || typeof o.baseQtyKey !== 'string') return null;
  return {
    id: o.id,
    label: o.label,
    unit: o.unit,
    sheetLen: o.sheetLen,
    baseQtyKey: o.baseQtyKey,
    overrides: reviveOverrides(o.overrides),
  };
}

/** Load saved list, or `defaults` if missing / invalid. */
export function loadMaterialListSnapshot(defaults: MaterialListSnapshot): MaterialListSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const data = JSON.parse(raw) as { sections?: unknown[]; others?: unknown[] };
    if (!Array.isArray(data.sections) || data.sections.length !== defaults.sections.length) return defaults;
    const sections: StoredSection[] = [];
    for (let i = 0; i < defaults.sections.length; i++) {
      const sec = reviveSection(data.sections[i], defaults.sections[i].key);
      if (!sec) return defaults;
      sections.push(sec);
    }
    if (!Array.isArray(data.others)) return defaults;
    const others: StoredOtherRow[] = [];
    for (const row of data.others) {
      const o = reviveOther(row);
      if (!o) return defaults;
      others.push(o);
    }
    return { sections, others };
  } catch {
    return defaults;
  }
}

export function saveMaterialListSnapshot(snapshot: MaterialListSnapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}
