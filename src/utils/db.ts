import { neon } from '@neondatabase/serverless';
import { Coordinates } from '../types';
import { QuoteData } from '../types';
import type { RoofStructureAnalysis } from './roofStructure';
import type { RoofAnalysis } from './ai';

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

/** Folder title in Projects: `name + address` when name is set; otherwise address only. */
export function buildProjectDisplayName(projectName: string | null | undefined, address: string): string {
  const n = (projectName ?? '').trim();
  const a = (address ?? '').trim();
  if (n && a) return `${n} ${a}`;
  return a || n || 'Untitled project';
}

/** Merge how analyses were run so one project row can hold quick map + wizard work. */
export function mergeProjectAnalysisEntry(
  previous: string | null | undefined,
  incoming: 'quick' | 'wizard'
): 'quick' | 'wizard' | 'both' {
  const p = (previous ?? '').trim().toLowerCase();
  if (p === 'both' || p === 'quick+wizard') return 'both';
  if (p === incoming) return incoming;
  if ((p === 'quick' && incoming === 'wizard') || (p === 'wizard' && incoming === 'quick')) return 'both';
  if (p === '') return incoming;
  return 'both';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    CREATE TABLE IF NOT EXISTS roof_structure_reports (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      analysis     JSONB NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
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
  await neonSql`
    CREATE TABLE IF NOT EXISTS roof_ai_workflow_reports (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      report       JSONB NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await neonSql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quote_address TEXT`;
  await neonSql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS analysis_entry TEXT`;
  await neonSql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_name TEXT`;
  await neonSql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_name TEXT`;
  await neonSql`ALTER TABLE project_snapshots ADD COLUMN IF NOT EXISTS ai_analysis JSONB`;
  await neonSql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_tag TEXT`;
  await neonSql`
    UPDATE projects
    SET display_name = address
    WHERE display_name IS NULL OR TRIM(display_name) = ''
  `;
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

export interface WizardWorkflowReportPayload {
  version: 'v1';
  source: 'roof-mapping-wizard';
  /** Optional user folder name; persisted with address as display_name on new project rows. */
  projectFolderName?: string | null;
  address: string;
  coordinates: Coordinates;
  outline: {
    points: Array<{ lat: number; lng: number }>;
    analysis: unknown | null;
  } | null;
  segments: Array<{
    id: string;
    index: number;
    color: string;
    path: Array<{ lat: number; lng: number }>;
    analysis: unknown | null;
  }>;
  structure: unknown | null;
  photos: Array<{
    id: string;
    label: string;
    description: string;
    status: string;
    qualityScore?: number | null;
    cueCount?: number;
    byType?: Record<string, number>;
    captureImageDataUrl?: string | null;
    capturedAtIso?: string | null;
    depthPitchDeg?: number | null;
    depthPitchRatio?: string | null;
    depthMapUrl?: string | null;
    notes?: string | null;
  }>;
  finalAnalysis: unknown | null;
  /** Base64 data-URL of the satellite map view — saved as project snapshot_url */
  satelliteSnapshot?: string | null;
  updatedAtIso: string;
}

export interface SaveProjectOptions {
  /** User folder label; stored with address as `display_name` = name + address. */
  projectName?: string | null;
  /** How the user entered this project (same row for quick vs wizard). */
  analysisEntry?: 'quick' | 'wizard' | null;
  /**
   * When set to an existing project id, this save updates that project folder instead of creating a new row:
   * map snapshots are appended, roof sections are replaced with the latest quick map, roof structure is upserted.
   */
  existingProjectId?: string | null;
}

export async function saveProject(
  address: string,
  coordinates: Coordinates,
  snapshots: ProjectSnapshot[],
  sections: SectionToSave[],
  roofStructure?: RoofStructureAnalysis | null,
  options?: SaveProjectOptions
): Promise<string> {
  const sql = requireNeon();
  const primaryUrl = snapshots[0]?.url ?? null;
  const incomingName = options?.projectName?.trim() ? options.projectName.trim() : null;
  const incomingEntry = options?.analysisEntry ?? 'quick';
  const rawExisting = options?.existingProjectId?.trim() ?? '';
  const existingId = rawExisting && UUID_RE.test(rawExisting) ? rawExisting : null;

  if (existingId) {
    const existingRows = await sql`
      SELECT id, project_name, analysis_entry
      FROM projects
      WHERE id = ${existingId}::uuid
      LIMIT 1
    `;
    const row = existingRows[0] as { id: string; project_name: string | null; analysis_entry: string | null } | undefined;
    if (row?.id) {
      const projectName = incomingName ?? row.project_name;
      const displayName = buildProjectDisplayName(projectName, address);
      const analysisEntry = mergeProjectAnalysisEntry(row.analysis_entry, incomingEntry);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

      await sql`
        UPDATE projects
        SET
          address = ${address},
          lat = ${coordinates.lat},
          lng = ${coordinates.lng},
          snapshot_url = ${primaryUrl},
          project_name = ${projectName},
          display_name = ${displayName},
          analysis_entry = ${analysisEntry}
        WHERE id = ${existingId}::uuid
      `;

      for (const snap of snapshots) {
        const label = `Quick ${stamp} · ${snap.label}`;
        await sql`
          INSERT INTO project_snapshots (project_id, label, snapshot_url)
          VALUES (${existingId}, ${label}, ${snap.url})
        `;
      }

      await sql`DELETE FROM roof_sections WHERE project_id = ${existingId}::uuid`;

      for (const s of sections) {
        await sql`
          INSERT INTO roof_sections
            (project_id, name, flat_area, pitch, pitch_multiplier, actual_area, color, polygon_path)
          VALUES (
            ${existingId},
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

      if (roofStructure) {
        await sql`
          INSERT INTO roof_structure_reports (project_id, analysis, updated_at)
          VALUES (${existingId}, ${JSON.stringify(roofStructure)}, NOW())
          ON CONFLICT (project_id)
          DO UPDATE SET analysis = EXCLUDED.analysis, updated_at = NOW()
        `;
      }

      return existingId;
    }
  }

  const projectName = incomingName;
  const displayName = buildProjectDisplayName(projectName, address);
  const analysisEntry = incomingEntry;

  const [project] = await sql`
    INSERT INTO projects (address, lat, lng, snapshot_url, project_name, display_name, analysis_entry)
    VALUES (
      ${address},
      ${coordinates.lat},
      ${coordinates.lng},
      ${primaryUrl},
      ${projectName},
      ${displayName},
      ${analysisEntry}
    )
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

  if (roofStructure) {
    await sql`
      INSERT INTO roof_structure_reports (project_id, analysis, updated_at)
      VALUES (${projectId}, ${JSON.stringify(roofStructure)}, NOW())
      ON CONFLICT (project_id)
      DO UPDATE SET analysis = EXCLUDED.analysis, updated_at = NOW()
    `;
  }

  return projectId;
}

export interface SaveWizardWorkflowReportOptions {
  /** When set, upsert workflow JSON to this project (must exist). Skips address-based project resolution. */
  projectId?: string | null;
  /**
   * When true and no `projectId` is set yet, always INSERT a new `projects` row instead of reusing an existing
   * project at the same address (e.g. user explicitly chose "new folder" in the wizard attach flow).
   */
  forceNewProject?: boolean;
}

export async function saveWizardWorkflowReport(
  report: WizardWorkflowReportPayload,
  options?: SaveWizardWorkflowReportOptions
): Promise<{ projectId: string; reportId: string }> {
  const sql = requireNeon();

  await sql`
    CREATE TABLE IF NOT EXISTS roof_ai_workflow_reports (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      report       JSONB NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  let projectId: string | undefined =
    options?.projectId && String(options.projectId).trim() !== '' ? String(options.projectId) : undefined;

  if (projectId) {
    const exists = await sql`
      SELECT id FROM projects WHERE id = ${projectId}::uuid LIMIT 1
    `;
    if (!exists[0]?.id) {
      projectId = undefined;
    } else {
      projectId = exists[0].id as string;
    }
  }

  if (!projectId) {
    const skipAddressDedup = options?.forceNewProject === true;

    if (!skipAddressDedup) {
      const existing = await sql`
        SELECT id
        FROM projects
        WHERE address = ${report.address}
          AND ABS(lat - ${report.coordinates.lat}) < 0.000001
          AND ABS(lng - ${report.coordinates.lng}) < 0.000001
        ORDER BY created_at DESC
        LIMIT 1
      `;
      projectId = existing[0]?.id as string | undefined;
    }

    if (!projectId) {
      const wfName = report.projectFolderName?.trim() ? report.projectFolderName.trim() : null;
      const displayName = buildProjectDisplayName(wfName, report.address);
      const bannerUrl = report.satelliteSnapshot ?? null;
      const [inserted] = await sql`
        INSERT INTO projects (address, lat, lng, snapshot_url, project_name, display_name, analysis_entry)
        VALUES (
          ${report.address},
          ${report.coordinates.lat},
          ${report.coordinates.lng},
          ${bannerUrl},
          ${wfName},
          ${displayName},
          'wizard'
        )
        RETURNING id
      `;
      projectId = inserted.id as string;
    }
  }

  // Update banner on existing project if we now have a satellite snapshot and they don't have one yet
  if (report.satelliteSnapshot) {
    await sql`
      UPDATE projects
      SET snapshot_url = COALESCE(snapshot_url, ${report.satelliteSnapshot})
      WHERE id = ${projectId}::uuid
    `;
  }

  const [entryRow] = await sql`
    SELECT analysis_entry FROM projects WHERE id = ${projectId}::uuid LIMIT 1
  `;
  const mergedEntry = mergeProjectAnalysisEntry(entryRow?.analysis_entry as string | undefined, 'wizard');
  await sql`
    UPDATE projects SET analysis_entry = ${mergedEntry} WHERE id = ${projectId}::uuid
  `;

  const rows = await sql`
    INSERT INTO roof_ai_workflow_reports (project_id, report, updated_at)
    VALUES (${projectId}, ${JSON.stringify(report)}, NOW())
    ON CONFLICT (project_id)
    DO UPDATE SET report = EXCLUDED.report, updated_at = NOW()
    RETURNING id
  `;

  const wfTrim = report.projectFolderName?.trim();
  if (wfTrim) {
    const displayName = buildProjectDisplayName(wfTrim, report.address);
    await sql`
      UPDATE projects
      SET project_name = ${wfTrim},
          display_name = ${displayName}
      WHERE id = ${projectId}::uuid
    `;
  }

  return {
    projectId,
    reportId: rows[0].id as string,
  };
}

export async function getWizardWorkflowReport(
  projectId: string
): Promise<WizardWorkflowReportPayload | null> {
  const sql = requireNeon();
  await sql`
    CREATE TABLE IF NOT EXISTS roof_ai_workflow_reports (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      report       JSONB NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  const rows = await sql`
    SELECT report
    FROM roof_ai_workflow_reports
    WHERE project_id = ${projectId}::uuid
    LIMIT 1
  `;
  if (!rows[0]?.report) return null;
  return rows[0].report as WizardWorkflowReportPayload;
}

export async function getProjectRoofStructure(projectId: string): Promise<RoofStructureAnalysis | null> {
  const sql = requireNeon();
  const rows = await sql`
    SELECT analysis
    FROM roof_structure_reports
    WHERE project_id = ${projectId}
    LIMIT 1
  `;
  if (!rows[0]?.analysis) return null;
  return rows[0].analysis as RoofStructureAnalysis;
}

export async function getProjectSnapshots(projectId: string) {
  const sql = requireNeon();
  return await sql`
    SELECT id, label, snapshot_url, created_at, ai_analysis
    FROM project_snapshots
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

/** Persist Gemini roof snapshot analysis so Project detail still shows it after close/reopen. */
export async function updateProjectSnapshotAiAnalysis(snapshotId: string, analysis: RoofAnalysis): Promise<void> {
  const sql = requireNeon();
  await sql`
    UPDATE project_snapshots
    SET ai_analysis = ${JSON.stringify(analysis)}
    WHERE id = ${snapshotId}::uuid
  `;
}

export async function getProjectDetails(projectId: string) {
  const sql = requireNeon();
  const rows = await sql`
    SELECT p.id, p.address, p.lat, p.lng, p.snapshot_url, p.created_at,
           p.project_name, p.display_name, p.analysis_entry, p.project_tag,
           COUNT(rs.id)::int    AS section_count,
           COALESCE(SUM(rs.actual_area), 0)::float AS total_area
    FROM projects p
    LEFT JOIN roof_sections rs ON rs.project_id = p.id
    WHERE p.id = ${projectId}
    GROUP BY p.id
  `;
  return rows[0] as {
    id: string;
    address: string;
    lat: number;
    lng: number;
    snapshot_url: string | null;
    created_at: string;
    project_name: string | null;
    display_name: string | null;
    analysis_entry: string | null;
    project_tag: string | null;
    section_count: number;
    total_area: number;
  };
}

export async function getProjectSections(projectId: string) {
  const sql = requireNeon();
  return await sql`
    SELECT id, name, flat_area, pitch, pitch_multiplier, actual_area, color, polygon_path
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

/** Preset status tags for projects (stored as `projects.project_tag`). */
export const PROJECT_TAG_OPTIONS = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'pending', label: 'Pending' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'closed', label: 'Closed' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const;

const PROJECT_TAG_VALUES = new Set(PROJECT_TAG_OPTIONS.map(o => o.value));

export function projectTagLabel(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const opt = PROJECT_TAG_OPTIONS.find(o => o.value === v);
  return opt?.label ?? v;
}

export async function updateProjectTag(projectId: string, tag: string | null): Promise<void> {
  const sql = requireNeon();
  if (tag !== null && !PROJECT_TAG_VALUES.has(tag as (typeof PROJECT_TAG_OPTIONS)[number]['value'])) {
    throw new Error('Invalid project tag');
  }
  await sql`
    UPDATE projects
    SET project_tag = ${tag}
    WHERE id = ${projectId}::uuid
  `;
}

export async function deleteProject(projectId: string): Promise<void> {
  const sql = requireNeon();
  await sql`DELETE FROM projects WHERE id = ${projectId}::uuid`;
}

export async function getRecentProjects(limit = 8) {
  const sql = requireNeon();
  return await sql`
    SELECT p.id, p.address, p.lat, p.lng, p.snapshot_url, p.created_at,
           p.project_name, p.display_name, p.project_tag,
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
