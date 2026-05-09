import { neon } from '@neondatabase/serverless';
import { Coordinates } from '../types';
import { QuoteData } from '../types';

function trimDatabaseUrl(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/^\uFEFF/, '');
  return t.length ? t : undefined;
}

const dbUrl = trimDatabaseUrl(__ROOFIQ_DATABASE_URL__ || import.meta.env.VITE_DATABASE_URL);
/** Undefined URL must not be passed to `neon()` — it throws immediately and breaks the whole app (e.g. Vercel without env). */
const neonSql = dbUrl
  ? neon(dbUrl, { disableWarningInBrowsers: true })
  : null;

function requireNeon() {
  if (!neonSql) {
    throw new Error(
      'Database is not configured. Add `VITE_DATABASE_URL` or `DATABASE_URL` (Neon connection string) to `.env`, or set either on the host at build time.'
    );
  }
  return neonSql;
}

export function isDbConfigured(): boolean {
  return Boolean(neonSql);
}

export async function initDb() {
  if (!neonSql) return;
  await neonSql`
    CREATE TABLE IF NOT EXISTS projects (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      address     TEXT NOT NULL,
      lat         DOUBLE PRECISION NOT NULL,
      lng         DOUBLE PRECISION NOT NULL,
      snapshot_url TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await neonSql`
    CREATE TABLE IF NOT EXISTS roof_sections (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      flat_area        DOUBLE PRECISION NOT NULL,
      pitch            TEXT NOT NULL,
      pitch_multiplier DOUBLE PRECISION NOT NULL,
      actual_area      DOUBLE PRECISION NOT NULL,
      color            TEXT NOT NULL,
      polygon_path     JSONB NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await neonSql`
    CREATE TABLE IF NOT EXISTS project_snapshots (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      snapshot_url TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await neonSql`
    CREATE TABLE IF NOT EXISTS quotes (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
      material_id      TEXT NOT NULL,
      material_name    TEXT NOT NULL,
      total_squares    DOUBLE PRECISION NOT NULL,
      material_cost    DOUBLE PRECISION NOT NULL,
      labor_cost       DOUBLE PRECISION NOT NULL,
      additional_costs JSONB NOT NULL,
      subtotal         DOUBLE PRECISION NOT NULL,
      tax              DOUBLE PRECISION NOT NULL,
      total            DOUBLE PRECISION NOT NULL,
      quote_address    TEXT,
      generated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await neonSql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quote_address TEXT`;
}

export interface SectionToSave {
  id: string;
  name: string;
  flatArea: number;
  pitch: string;
  pitchMultiplier: number;
  actualArea: number;
  color: string;
  polygonPath: Array<{ lat: number; lng: number }>;
}

export interface ProjectSnapshot {
  label: string;
  url: string;
}

export async function saveProject(
  address: string,
  coordinates: Coordinates,
  snapshots: ProjectSnapshot[],
  sections: SectionToSave[]
): Promise<string> {
  const sql = requireNeon();
  const primaryUrl = snapshots[0]?.url ?? null;

  const [project] = await sql`
    INSERT INTO projects (address, lat, lng, snapshot_url)
    VALUES (${address}, ${coordinates.lat}, ${coordinates.lng}, ${primaryUrl})
    RETURNING id
  `;
  const projectId = project.id as string;

  for (const snap of snapshots) {
    await sql`
      INSERT INTO project_snapshots (project_id, label, snapshot_url)
      VALUES (${projectId}, ${snap.label}, ${snap.url})
    `;
  }

  for (const s of sections) {
    await sql`
      INSERT INTO roof_sections
        (project_id, name, flat_area, pitch, pitch_multiplier, actual_area, color, polygon_path)
      VALUES (
        ${projectId},
        ${s.name},
        ${s.flatArea},
        ${s.pitch},
        ${s.pitchMultiplier},
        ${s.actualArea},
        ${s.color},
        ${JSON.stringify(s.polygonPath)}
      )
    `;
  }

  return projectId;
}

export async function getProjectSnapshots(projectId: string) {
  const sql = requireNeon();
  return await sql`
    SELECT id, label, snapshot_url, created_at
    FROM project_snapshots
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

export async function getProjectDetails(projectId: string) {
  const sql = requireNeon();
  const rows = await sql`
    SELECT p.id, p.address, p.lat, p.lng, p.snapshot_url, p.created_at,
           COUNT(rs.id)::int    AS section_count,
           COALESCE(SUM(rs.actual_area), 0)::float AS total_area
    FROM projects p
    LEFT JOIN roof_sections rs ON rs.project_id = p.id
    WHERE p.id = ${projectId}
    GROUP BY p.id
  `;
  return rows[0] as {
    id: string; address: string; lat: number; lng: number;
    snapshot_url: string | null; created_at: string;
    section_count: number; total_area: number;
  };
}

export async function getProjectSections(projectId: string) {
  const sql = requireNeon();
  return await sql`
    SELECT id, name, flat_area, pitch, pitch_multiplier, actual_area, color
    FROM roof_sections
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

export async function saveQuote(projectId: string | null, quote: QuoteData): Promise<string> {
  const sql = requireNeon();
  const addressSnapshot = quote.address?.trim() || null;
  const [row] = await sql`
    INSERT INTO quotes
      (project_id, material_id, material_name, total_squares,
       material_cost, labor_cost, additional_costs, subtotal, tax, total, quote_address)
    VALUES (
      ${projectId},
      ${quote.material.id},
      ${quote.material.name},
      ${quote.orderSquares},
      ${quote.materialCost},
      ${quote.laborCost},
      ${JSON.stringify(quote.additionalCosts)},
      ${quote.subtotal},
      ${quote.tax},
      ${quote.total},
      ${addressSnapshot}
    )
    RETURNING id
  `;
  return row.id as string;
}

export async function getStats() {
  const sql = requireNeon();
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM projects) as total_projects,
      (SELECT COUNT(*)::int FROM quotes) as total_quotes,
      (SELECT COALESCE(SUM(actual_area), 0)::float FROM roof_sections) as total_area,
      (SELECT COALESCE(SUM(total), 0)::float FROM quotes) as total_value
  `;
  return rows[0] as { total_projects: number; total_quotes: number; total_area: number; total_value: number };
}

export async function getRecentProjects(limit = 8) {
  const sql = requireNeon();
  return await sql`
    SELECT p.id, p.address, p.lat, p.lng, p.snapshot_url, p.created_at,
           COUNT(rs.id)::int as section_count,
           COALESCE(SUM(rs.actual_area), 0)::float as total_area
    FROM projects p
    LEFT JOIN roof_sections rs ON rs.project_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
}

export async function updateQuote(quoteId: string, updates: {
  material_cost: number; labor_cost: number;
  additional_costs: Array<{ label: string; amount: number }>;
  subtotal: number; tax: number; total: number;
}) {
  const sql = requireNeon();
  await sql`
    UPDATE quotes SET
      material_cost    = ${updates.material_cost},
      labor_cost       = ${updates.labor_cost},
      additional_costs = ${JSON.stringify(updates.additional_costs)},
      subtotal         = ${updates.subtotal},
      tax              = ${updates.tax},
      total            = ${updates.total}
    WHERE id = ${quoteId}
  `;
}

export async function getQuoteDetails(quoteId: string) {
  const sql = requireNeon();
  const rows = await sql`
    SELECT q.id, q.material_id, q.material_name, q.total_squares,
           q.material_cost, q.labor_cost, q.additional_costs,
           q.subtotal, q.tax, q.total, q.generated_at,
           COALESCE(p.address, q.quote_address) AS address,
           p.id as project_id
    FROM quotes q
    LEFT JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${quoteId}
  `;
  return rows[0] as {
    id: string; material_id: string; material_name: string;
    total_squares: number; material_cost: number; labor_cost: number;
    additional_costs: Array<{ label: string; amount: number }>;
    subtotal: number; tax: number; total: number;
    generated_at: string; address: string | null; project_id: string | null;
  };
}

export async function getRecentQuotes(limit = 8) {
  const sql = requireNeon();
  return await sql`
    SELECT q.id, q.material_name, q.total_squares, q.total, q.generated_at,
           COALESCE(p.address, q.quote_address) AS address
    FROM quotes q
    LEFT JOIN projects p ON p.id = q.project_id
    ORDER BY q.generated_at DESC
    LIMIT ${limit}
  `;
}
