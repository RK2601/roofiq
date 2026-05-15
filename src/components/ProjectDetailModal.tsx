import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import { X, MapPin, Layers, Ruler, Calendar, ZoomIn, ChevronLeft, ChevronRight, Image, Brain, Loader2, AlertTriangle, FileText, DollarSign, History, Trash2, Pencil, Check, Plus, ChevronDown, ChevronUp, Printer, Upload, Palette, Download } from 'lucide-react';
import {
  getProjectDetails,
  getProjectSnapshots,
  getProjectSections,
  getWizardWorkflowReport,
  isDbConfigured,
  pitchMultiplierFromString,
  projectTagLabel,
  updateProjectSnapshotAiAnalysis,
  listWizardRunHistory,
  getWizardRunById,
  updateWizardRunLabel,
  deleteWizardRun,
  fetchProjectQuotes,
  saveProjectQuote,
  deleteProjectQuote,
  type WizardWorkflowReportPayload,
  type WizardRunSummary,
  type ProjectQuoteRow,
} from '../utils/db';
import WizardWorkflowReportView from './WizardWorkflowReportView';
import MaterialEstimateReport from './MaterialEstimateReport';
import QuoteDocumentView from './QuoteDocumentView';
import { loadBranding, saveBranding, DEFAULT_CLIENT, type QuoteBranding, type QuoteClient } from '../utils/quoteBranding';
import { downloadQuoteDocumentPdf } from '../utils/quotePdfExport';
import { printElementIsolated } from '../utils/printIsolated';
import ProjectTagMenu, { projectTagTone } from './ProjectTagMenu';
import { analyzeRoofImage, RoofAnalysis, CONDITION_BG, URGENCY_BG, CONDITION_COLORS } from '../utils/ai';
import { readGeminiApiKey } from '../utils/googleAiKey';
import { readMapsApiKey } from '../utils/googleMapsKey';
import { MATERIALS } from '../utils/roofCalculations';
import type { Material } from '../types';

type ProjectDetailTab = 'overview' | 'wizard' | 'quote' | 'materials' | 'history';

interface Props {
  projectId: string;
  onClose: () => void;
  /** When true on mount, open the Smart Roof Mapping wizard report tab first. */
  defaultWizardTab?: boolean;
  onDefaultWizardTabConsumed?: () => void;
  /** Opens full quote view with sections loaded from this project. */
  onOpenQuoteFromProject?: (projectId: string) => void | Promise<void>;
  /** After the project row is deleted from the database (modal should close). */
  onProjectDeleted?: (projectId: string) => void;
  /**
   * `layer` — absolute inset-0 inside a relative parent (e.g. Projects list shell).
   * `column` — fixed to the main content column below the app header, beside the sidebar (dashboard home).
   */
  layout?: 'layer' | 'column';
}

interface ProjectDetail {
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
}

function analysisEntryLabel(entry: string | null | undefined): string | null {
  const e = (entry ?? '').trim().toLowerCase();
  if (e === 'both' || e === 'quick+wizard') return 'Quick map + Wizard';
  if (e === 'wizard') return 'Wizard';
  if (e === 'quick') return 'Quick map';
  if (!e) return null;
  return 'Mixed analyses';
}

interface Snapshot {
  id: string;
  label: string;
  snapshot_url: string;
  ai_analysis?: RoofAnalysis | null;
}

interface Section {
  id: string;
  name: string;
  flat_area: number;
  pitch: string;
  pitch_multiplier: number;
  actual_area: number;
  color: string;
}

/** Compute flat area in sq ft from lat/lng path using the Shoelace formula.
 *  Used as fallback when flatAreaSqFt was not stored (saved as 0 or missing). */
function areaFromPath(path: Array<{ lat: number; lng: number }>): number {
  if (path.length < 3) return 0;
  const METERS_PER_DEG_LAT = 111320;
  const cosLat = Math.cos((path[0].lat * Math.PI) / 180);
  const pts = path.map(p => [
    (p.lng - path[0].lng) * METERS_PER_DEG_LAT * cosLat,
    (p.lat - path[0].lat) * METERS_PER_DEG_LAT,
  ]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return (Math.abs(area) / 2) * 10.7639; // sq m → sq ft
}

/** Extract the best available total roof area (sq ft) from a wizard report.
 *  Priority: Solar API measurements → AI structure total → segment sum. */
function bestTotalAreaSqFt(wizard: WizardWorkflowReportPayload | null): number | null {
  if (!wizard) return null;
  // Solar API measurements (most accurate — satellite DSM derived)
  const solar = wizard.solarStructure as { measurements?: { totalRoofAreaSqFt?: number } } | null;
  if (solar?.measurements?.totalRoofAreaSqFt && solar.measurements.totalRoofAreaSqFt > 0) {
    return Math.round(solar.measurements.totalRoofAreaSqFt);
  }
  // AI structure detection total
  const structure = wizard.structure as { totalAreaSqFt?: number } | null;
  if (structure?.totalAreaSqFt && structure.totalAreaSqFt > 0) {
    return Math.round(structure.totalAreaSqFt);
  }
  return null;
}

/** Derive overview sections from Solar API facets (most accurate — DSM-derived areas + pitch). */
function parseSolarForOverview(wizard: WizardWorkflowReportPayload | null): Section[] {
  if (!wizard) return [];
  type SolarFacet = { pitchLabel?: string; actualAreaSqFt?: number; groundAreaSqFt?: number };
  const solar = wizard.solarStructure as { facets?: SolarFacet[] } | null | undefined;
  const facets = solar?.facets?.filter(f => typeof f.actualAreaSqFt === 'number' && f.actualAreaSqFt > 0) ?? [];
  if (facets.length === 0) return [];
  const paletteColors = ['#3b82f6','#06b6d4','#8b5cf6','#ec4899','#f97316','#22c55e','#eab308','#ef4444'];
  return facets.map((facet, i) => {
    const pitch = facet.pitchLabel?.trim() || 'flat';
    const mult = pitchMultiplierFromString(pitch);
    const flatArea = Math.max(0, Math.round(facet.groundAreaSqFt ?? 0));
    const actualArea = Math.max(0, Math.round(facet.actualAreaSqFt ?? 0));
    const color = wizard.segments[i]?.color ?? paletteColors[i % paletteColors.length];
    return {
      id: `solar-facet-${i}`,
      name: `Facet ${i + 1}`,
      flat_area: flatArea,
      pitch,
      pitch_multiplier: mult,
      actual_area: actualArea,
      color,
    };
  });
}

/** When `roof_sections` is empty (legacy save or sync miss), derive rows from wizard workflow JSON. */
function overviewSectionsFromWizardReport(wizard: WizardWorkflowReportPayload | null): Section[] {
  if (!wizard?.segments?.length) return [];
  return wizard.segments.map((seg, i) => {
    const analysis = seg.analysis as { pitchEstimate?: string } | null;
    const segExt = seg as typeof seg & { dsmPitchRatio?: string };
    // Prefer DSM pitch (depth-sensor derived, more accurate) over AI photo estimate
    let pitch = (segExt.dsmPitchRatio || analysis?.pitchEstimate || 'flat').trim() || 'flat';
    if (pitch === 'steep') pitch = '10/12';
    const mult = pitchMultiplierFromString(pitch);
    const rawFlat = seg.flatAreaSqFt;
    // Use stored value when valid and non-zero; otherwise recompute from path
    const flatArea = Math.max(
      0,
      Math.round(
        typeof rawFlat === 'number' && Number.isFinite(rawFlat) && rawFlat > 0
          ? rawFlat
          : areaFromPath(seg.path)
      )
    );
    const actualArea = Math.max(0, Math.round(flatArea * mult));
    return {
      id: seg.id?.trim() || `wizard-seg-${i}`,
      name: `Segment ${i + 1}`,
      flat_area: flatArea,
      pitch,
      pitch_multiplier: mult,
      actual_area: actualArea,
      color: seg.color || '#64748b',
    };
  });
}

interface SnapAI {
  status: 'analyzing' | 'done' | 'error';
  result?: RoofAnalysis;
  error?: string;
}

function isPersistableSnapshotId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function snapAiFromRows(rows: Snapshot[]): Record<string, SnapAI> {
  const out: Record<string, SnapAI> = {};
  for (const r of rows) {
    const a = r.ai_analysis;
    if (a && typeof a === 'object' && 'condition' in a && 'urgency' in a) {
      out[r.id] = { status: 'done', result: a as RoofAnalysis };
    }
  }
  return out;
}

const SHELL_LAYER =
  'absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-white shadow-xl ring-1 ring-slate-200/60 motion-safe:animate-fade-in';
/** Fixed below dashboard header, to the right of the lg sidebar (w-64).
 *  Uses max-h instead of bottom-0 so short content doesn't leave blank space. */
const SHELL_COLUMN =
  'fixed right-0 left-0 top-[max(3.25rem,env(safe-area-inset-top,0px))] z-[60] flex flex-col overflow-hidden bg-white shadow-xl ring-1 ring-slate-200/60 motion-safe:animate-fade-in sm:top-16 lg:left-64 max-h-[calc(100vh-max(3.25rem,env(safe-area-inset-top,0px)))] sm:max-h-[calc(100vh-4rem)]';

function isQuoteBrandingEqual(a: QuoteBranding, b: QuoteBranding): boolean {
  return (
    a.companyName === b.companyName &&
    a.tagline === b.tagline &&
    a.address === b.address &&
    a.city === b.city &&
    a.phone === b.phone &&
    a.email === b.email &&
    a.website === b.website &&
    a.licenseNo === b.licenseNo &&
    a.logoDataUrl === b.logoDataUrl &&
    a.signatureDataUrl === b.signatureDataUrl &&
    a.accentColor === b.accentColor &&
    a.terms === b.terms
  );
}

export default function ProjectDetailModal({
  projectId,
  onClose,
  defaultWizardTab,
  onDefaultWizardTabConsumed,
  onOpenQuoteFromProject,
  onProjectDeleted,
  layout = 'column',
}: Props) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [snapAI, setSnapAI] = useState<Record<string, SnapAI>>({});
  const hasGeminiKey = !!readGeminiApiKey();

  const [activeTab, setActiveTab] = useState<ProjectDetailTab>(() => (defaultWizardTab ? 'wizard' : 'overview'));
  const [wizardReport, setWizardReport] = useState<WizardWorkflowReportPayload | null>(null);
  const [wizardReportLoading, setWizardReportLoading] = useState(false);
  const [wizardReportError, setWizardReportError] = useState<string | null>(null);

  // ── History tab state ──────────────────────────────────────────────────────
  const [historyRuns, setHistoryRuns] = useState<WizardRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunReport, setSelectedRunReport] = useState<WizardWorkflowReportPayload | null>(null);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState('');
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  // ── Quote tab state ────────────────────────────────────────────────────────
  const [savedQuotes, setSavedQuotes] = useState<ProjectQuoteRow[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [selectedMaterial, setSelectedMaterial] = useState<Material>(MATERIALS[0]);
  const [wastePct, setWastePct] = useState(12);
  const [taxRate, setTaxRate] = useState(8.5);
  const [quoteNotes, setQuoteNotes] = useState('');
  const [quoteRunLabel, setQuoteRunLabel] = useState('');
  const [customCosts, setCustomCosts] = useState<Array<{ label: string; amount: number }>>([]);
  const [savingQuote, setSavingQuote] = useState(false);
  const [quoteSaved, setQuoteSaved] = useState(false);
  const [quotePdfExporting, setQuotePdfExporting] = useState(false);
  const [quotePdfError, setQuotePdfError] = useState<string | null>(null);
  // Editable unit prices (reset when material changes)
  const [matPricePerSq, setMatPricePerSq] = useState(MATERIALS[0].pricePerSquare);
  const [laborPricePerSq, setLaborPricePerSq] = useState(MATERIALS[0].laborPerSquare);
  // Per-line-item amount overrides (key → user-set $); deleted items tracked
  const [lineAmtEdits, setLineAmtEdits] = useState<Record<string, number>>({});
  const [deletedLineKeys, setDeletedLineKeys] = useState<Set<string>>(new Set());
  const [addingItem, setAddingItem] = useState(false);
  const [newItemLabel, setNewItemLabel] = useState('');
  const [newItemAmt, setNewItemAmt] = useState('');
  // Branding: draft edits vs last-saved snapshot (Save branding → localStorage)
  const [savedBranding, setSavedBranding] = useState<QuoteBranding>(() => loadBranding());
  const [draftBranding, setDraftBranding] = useState<QuoteBranding>(() => loadBranding());
  const [client, setClient] = useState<QuoteClient>(DEFAULT_CLIENT);
  const [quoteNo, setQuoteNo] = useState(() => `Q-${Date.now().toString(36).toUpperCase()}`);
  const [validDays, setValidDays] = useState(30);
  const [showBrandPanel, setShowBrandPanel] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  const quoteDocRef = useRef<HTMLDivElement>(null);

  const brandingDirty = useMemo(
    () => !isQuoteBrandingEqual(draftBranding, savedBranding),
    [draftBranding, savedBranding]
  );

  function patchDraftBranding(patch: Partial<QuoteBranding>) {
    setDraftBranding(prev => ({ ...prev, ...patch }));
  }

  function persistBranding() {
    const next = { ...draftBranding };
    saveBranding(next);
    setSavedBranding(next);
  }

  function discardBrandingDraft() {
    setDraftBranding({ ...savedBranding });
  }

  function handleSignatureFileSelect(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => patchDraftBranding({ signatureDataUrl: (e.target?.result as string) ?? null });
    reader.readAsDataURL(file);
  }

  function handleLogoFileSelect(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      patchDraftBranding({ logoDataUrl: (e.target?.result as string) ?? null });
      if (logoFileInputRef.current) logoFileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  }

  useLayoutEffect(() => {
    if (defaultWizardTab) {
      onDefaultWizardTabConsumed?.();
    }
    // Intentionally once per modal mount (parent resets defaultWizardTab after this).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWizardReport = useCallback(async () => {
    if (!isDbConfigured()) {
      setWizardReportError('Database not configured.');
      setWizardReport(null);
      return;
    }
    setWizardReportLoading(true);
    setWizardReportError(null);
    try {
      const row = await getWizardWorkflowReport(projectId);
      setWizardReport(row);
    } catch (e: unknown) {
      setWizardReportError(e instanceof Error ? e.message : 'Failed to load wizard report');
      setWizardReport(null);
    } finally {
      setWizardReportLoading(false);
    }
  }, [projectId]);

  // Load wizard report on mount so Quotation and Material list tabs always have data,
  // regardless of which tab the user opens first.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isDbConfigured()) {
        setWizardReportError('Database not configured.');
        setWizardReport(null);
        setWizardReportLoading(false);
        return;
      }
      setWizardReportLoading(true);
      setWizardReportError(null);
      try {
        const row = await getWizardWorkflowReport(projectId);
        if (cancelled) return;
        setWizardReport(row);
      } catch (e: unknown) {
        if (!cancelled) {
          setWizardReportError(e instanceof Error ? e.message : 'Failed to load wizard report');
          setWizardReport(null);
        }
      } finally {
        if (!cancelled) setWizardReportLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [projectId]);

  // While the Wizard tab is active, poll for live updates during an ongoing analysis run.
  useEffect(() => {
    if (activeTab !== 'wizard') return;
    let cancelled = false;

    const interval = window.setInterval(async () => {
      if (cancelled || !isDbConfigured()) return;
      try {
        const row = await getWizardWorkflowReport(projectId);
        if (cancelled) return;
        setWizardReport(row);
        if (row?.finalAnalysis != null) {
          window.clearInterval(interval);
        }
      } catch {
        /* keep last good payload */
      }
    }, 2000);

    const stop = window.setTimeout(() => window.clearInterval(interval), 48_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [activeTab, projectId]);

  // Load history list when tab opens
  useEffect(() => {
    if (activeTab !== 'history' || !isDbConfigured()) return;
    let cancelled = false;
    setHistoryLoading(true);
    listWizardRunHistory(projectId)
      .then(runs => { if (!cancelled) { setHistoryRuns(runs); if (runs.length > 0 && !selectedRunId) setSelectedRunId(runs[0].id); } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load a run's report when selection changes
  useEffect(() => {
    if (!selectedRunId) { setSelectedRunReport(null); return; }
    let cancelled = false;
    setSelectedRunLoading(true);
    getWizardRunById(selectedRunId)
      .then(r => { if (!cancelled) setSelectedRunReport(r); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSelectedRunLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  // Load saved quotes when quote tab opens
  useEffect(() => {
    if (activeTab !== 'quote' || !isDbConfigured()) return;
    let cancelled = false;
    setQuotesLoading(true);
    fetchProjectQuotes(projectId)
      .then(q => { if (!cancelled) setSavedQuotes(q); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setQuotesLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, projectId]);

  // Compute quote from wizard report roof area + edges
  const quoteComputed = useMemo(() => {
    const report = wizardReport;
    let totalSqFt = 0;
    if (typeof google !== 'undefined' && google.maps?.geometry?.spherical && report?.segments) {
      try {
        totalSqFt = report.segments.reduce((sum, seg) => {
          if (seg.path.length < 3) return sum;
          const poly = new google.maps.Polygon({ paths: seg.path.map(p => new google.maps.LatLng(p.lat, p.lng)) });
          return sum + google.maps.geometry.spherical.computeArea(poly.getPath()) * 10.7639;
        }, 0);
      } catch { totalSqFt = 0; }
    }
    if (!totalSqFt && (report as any)?.structure?.totalAreaSqFt) totalSqFt = (report as any).structure.totalAreaSqFt;
    const orderSquares = Math.max(1, Math.ceil(totalSqFt * (1 + wastePct / 100) / 100));
    const cues = (report as any)?.structure?.cues ?? [];
    const ridgeFt = Math.round(cues.filter((c: any) => c.type === 'ridge').reduce((s: number, c: any) => s + (c.estimatedLengthFt ?? 0), 0));
    const hipFt = Math.round(cues.filter((c: any) => c.type === 'hip').reduce((s: number, c: any) => s + (c.estimatedLengthFt ?? 0), 0));
    const valleyFt = Math.round(cues.filter((c: any) => c.type === 'valley').reduce((s: number, c: any) => s + (c.estimatedLengthFt ?? 0), 0));
    const eaveFt = Math.round(cues.filter((c: any) => c.type === 'eave').reduce((s: number, c: any) => s + (c.estimatedLengthFt ?? 0), 0));
    const rakeFt = Math.round(cues.filter((c: any) => c.type === 'rake').reduce((s: number, c: any) => s + (c.estimatedLengthFt ?? 0), 0));

    // All line items with stable keys so user overrides persist across re-renders
    type KeyedItem = { key: string; label: string; baseAmount: number; deletable: boolean };
    const allItems: KeyedItem[] = [
      { key: 'underlayment', label: 'Underlayment & ice shield', baseAmount: orderSquares * 15, deletable: true },
      { key: 'flashing',     label: 'Flashing & ridge cap',      baseAmount: orderSquares * 10, deletable: true },
      { key: 'tearoff',      label: 'Tear-off & disposal',       baseAmount: orderSquares * 20, deletable: true },
      { key: 'permits',      label: 'Permits & inspection',      baseAmount: 350,               deletable: true },
      ...(ridgeFt > 0  ? [{ key: 'ridge',  label: `Ridge cap (${ridgeFt} ft)`,           baseAmount: Math.round(ridgeFt * 4.25),          deletable: true }] : []),
      ...(hipFt > 0    ? [{ key: 'hip',    label: `Hip treatment (${hipFt} ft)`,          baseAmount: Math.round(hipFt * 4.25),            deletable: true }] : []),
      ...(valleyFt > 0 ? [{ key: 'valley', label: `Valley waterproofing (${valleyFt} ft)`,baseAmount: Math.round(valleyFt * 6.5),         deletable: true }] : []),
      ...((eaveFt + rakeFt) > 0 ? [{ key: 'eave', label: `Eave + rake finishing (${eaveFt + rakeFt} ft)`, baseAmount: Math.round((eaveFt + rakeFt) * 2.1), deletable: true }] : []),
      ...customCosts.map((c, i) => ({ key: `custom_${i}`, label: c.label, baseAmount: c.amount, deletable: true })),
    ];

    const materialCost = lineAmtEdits['material'] ?? (orderSquares * matPricePerSq);
    const laborCost    = lineAmtEdits['labor']    ?? (orderSquares * laborPricePerSq);

    const visibleItems = allItems
      .filter(item => !deletedLineKeys.has(item.key))
      .map(item => ({ ...item, amount: lineAmtEdits[item.key] ?? item.baseAmount }));

    const addTotal = visibleItems.reduce((s, c) => s + c.amount, 0);
    const subtotal = materialCost + laborCost + addTotal;
    const taxAmt = subtotal * (taxRate / 100);
    return {
      totalSqFt: Math.round(totalSqFt),
      orderSquares,
      materialCost,
      laborCost,
      visibleItems,
      subtotal,
      taxAmt,
      total: subtotal + taxAmt,
    };
  }, [wizardReport, matPricePerSq, laborPricePerSq, wastePct, taxRate, customCosts, lineAmtEdits, deletedLineKeys]);

  const handleSaveQuote = async () => {
    setSavingQuote(true);
    try {
      await saveProjectQuote(projectId, {
        materialId: selectedMaterial.id,
        materialName: selectedMaterial.name,
        totalSquares: quoteComputed.orderSquares,
        materialCost: quoteComputed.materialCost,
        laborCost: quoteComputed.laborCost,
        additionalCosts: quoteComputed.visibleItems.map(i => ({ label: i.label, amount: i.amount })),
        subtotal: quoteComputed.subtotal,
        tax: quoteComputed.taxAmt,
        total: quoteComputed.total,
        runLabel: quoteRunLabel.trim() || null,
        notes: quoteNotes.trim() || null,
      });
      setQuoteSaved(true);
      const q = await fetchProjectQuotes(projectId);
      setSavedQuotes(q);
      setQuoteRunLabel('');
      setQuoteNotes('');
      setTimeout(() => setQuoteSaved(false), 2500);
    } catch { /* silently fail */ } finally { setSavingQuote(false); }
  };

  const handleDeleteQuote = async (id: string) => {
    await deleteProjectQuote(id);
    setSavedQuotes(q => q.filter(x => x.id !== id));
  };

  const handleRenameRun = async (id: string) => {
    if (!editingLabelValue.trim()) return;
    await updateWizardRunLabel(id, editingLabelValue);
    setHistoryRuns(r => r.map(x => x.id === id ? { ...x, run_label: editingLabelValue } : x));
    setEditingLabelId(null);
  };

  const handleDeleteRun = async (id: string) => {
    setDeletingRunId(id);
    try {
      await deleteWizardRun(id);
      const remaining = historyRuns.filter(r => r.id !== id);
      setHistoryRuns(remaining);
      if (selectedRunId === id) {
        setSelectedRunId(remaining[0]?.id ?? null);
        setSelectedRunReport(null);
      }
    } finally { setDeletingRunId(null); }
  };

  const analyzeSnap = async (snapId: string, url: string) => {
    setSnapAI(prev => ({ ...prev, [snapId]: { status: 'analyzing' } }));
    try {
      const result = await analyzeRoofImage(url);
      setSnapAI(prev => ({ ...prev, [snapId]: { status: 'done', result } }));
      if (isPersistableSnapshotId(snapId) && isDbConfigured()) {
        try {
          await updateProjectSnapshotAiAnalysis(snapId, result);
        } catch (e) {
          console.error('[ProjectDetail] persist snapshot AI', e);
        }
      }
      setSnapshots(prev =>
        prev.map(s => (s.id === snapId ? { ...s, ai_analysis: result } : s))
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Analysis failed';
      setSnapAI(prev => ({ ...prev, [snapId]: { status: 'error', error: msg } }));
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getProjectDetails(projectId),
      getProjectSnapshots(projectId),
      getProjectSections(projectId),
      isDbConfigured() ? getWizardWorkflowReport(projectId) : Promise.resolve(null),
    ])
      .then(([proj, snaps, sects, wizard]) => {
        if (!proj) {
          setProject(null);
          setSections([]);
          setSnapshots([]);
          setSnapAI({});
          return;
        }
        const dbSections = (sects as Section[]) ?? [];
        const wizardPayload = wizard as WizardWorkflowReportPayload | null;
        // Priority: Solar API facets → DB sections → wizard segment fallback
        // Solar facets are always more accurate than DB rows (which may be stale from old saves)
        const fromSolar = parseSolarForOverview(wizardPayload);
        const fromWizard = overviewSectionsFromWizardReport(wizardPayload);
        const merged = fromSolar.length > 0 ? fromSolar : dbSections.length > 0 ? dbSections : fromWizard;
        const segmentTotal = merged.reduce((s, r) => s + (Number(r.actual_area) || 0), 0);
        // Prefer solar API or AI structure total (more accurate than summing
        // user-drawn segment polygons which may have gaps/overlaps)
        const totalArea = bestTotalAreaSqFt(wizardPayload) ?? segmentTotal;

        setProject({
          ...(proj as ProjectDetail),
          section_count: merged.length,
          total_area: totalArea,
        });
        // Fall back to the primary snapshot_url on the project row if no dedicated snapshots exist
        const snapList = snaps as Snapshot[];
        if (snapList.length === 0 && proj.snapshot_url) {
          setSnapshots([{ id: 'primary', label: 'Satellite View', snapshot_url: proj.snapshot_url }]);
          setSnapAI({});
        } else {
          setSnapshots(snapList);
          setSnapAI(snapAiFromRows(snapList));
        }
        setSections(merged);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  const totalActual = sections.reduce((s, r) => s + r.actual_area, 0);
  const totalFlat = sections.reduce((s, r) => s + r.flat_area, 0);

  const prevImage = () => setLightboxIdx(i => (i !== null ? (i - 1 + snapshots.length) % snapshots.length : 0));
  const nextImage = () => setLightboxIdx(i => (i !== null ? (i + 1) % snapshots.length : 0));

  const shellClass = layout === 'layer' ? SHELL_LAYER : SHELL_COLUMN;

  return (
    <div className={shellClass}>
        {/* Header */}
        <div className="flex flex-shrink-0 items-start justify-between border-b border-slate-200 bg-slate-50 px-4 py-4 sm:px-8 sm:py-5">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2 text-blue-600 text-xs font-semibold uppercase tracking-wider mb-1">
              <MapPin size={12} />
              Project Detail
            </div>
            {loading ? (
              <div className="h-6 w-64 bg-slate-200 rounded animate-pulse" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900 leading-snug break-words">
                    {(project?.display_name?.trim() || project?.address) ?? '—'}
                  </h2>
                  {project && projectTagLabel(project.project_tag) && (
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${projectTagTone(project.project_tag)}`}
                    >
                      {projectTagLabel(project.project_tag)}
                    </span>
                  )}
                </div>
                {analysisEntryLabel(project?.analysis_entry) && (
                  <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Project folder · {analysisEntryLabel(project?.analysis_entry)}
                  </p>
                )}
                {project?.address && (
                  <p className="text-xs text-slate-500 mt-1.5 leading-snug" title={project.address}>
                    {project.address}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-start gap-1 sm:gap-2">
            {!loading && project && (
              <ProjectTagMenu
                projectId={project.id}
                currentTag={project.project_tag}
                onTagUpdated={tag => setProject(prev => (prev ? { ...prev, project_tag: tag } : null))}
                onProjectDeleted={
                  onProjectDeleted
                    ? deletedId => {
                        onProjectDeleted(deletedId);
                        onClose();
                      }
                    : undefined
                }
              />
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 border-b border-slate-200 bg-white px-4 sm:px-8">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'overview'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Layers size={16} aria-hidden />
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('wizard')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'wizard'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FileText size={16} aria-hidden />
            Wizard report
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('quote')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'quote'
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <DollarSign size={16} aria-hidden />
            Quotation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('materials')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'materials'
                ? 'border-orange-500 text-orange-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Layers size={16} aria-hidden />
            Material list
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === 'history'
                ? 'border-violet-600 text-violet-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <History size={16} aria-hidden />
            Analysis history
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch] bg-slate-50">
          <div className="mx-auto w-full max-w-6xl px-4 pb-4 sm:px-8 bg-slate-50">
          {loading ? (
            <div className="space-y-4 py-6">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-40 bg-slate-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : activeTab === 'wizard' ? (
            <div className="py-4 sm:py-6">
              {wizardReportLoading && !wizardReport && (
                <div className="flex flex-col items-center py-12 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-500" aria-hidden />
                  <p className="text-sm text-slate-600">Loading wizard report…</p>
                </div>
              )}
              {wizardReport && wizardReport.finalAnalysis == null && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Final AI fusion is not in the saved report yet. Data will refresh automatically while the wizard finishes saving.
                </div>
              )}
              {wizardReportError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 mb-4">
                  {wizardReportError}
                  <button
                    type="button"
                    onClick={() => void loadWizardReport()}
                    className="block mt-2 text-xs font-semibold text-red-700 underline"
                  >
                    Retry
                  </button>
                </div>
              )}
              {wizardReport && (
                <WizardWorkflowReportView
                  report={wizardReport}
                  savedSectionCount={project?.section_count ?? 0}
                  onOpenQuoteBuilder={
                    onOpenQuoteFromProject ? () => void onOpenQuoteFromProject(projectId) : undefined
                  }
                  mapsApiKey={readMapsApiKey()}
                />
              )}
              {!wizardReportLoading && !wizardReport && !wizardReportError && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500 text-sm">
                  No Smart Roof Mapping wizard data saved for this project yet.
                </div>
              )}
            </div>
          ) : activeTab === 'quote' ? (
            <div className="py-4 sm:py-6 space-y-6">

              {/* ── Branding & sender panel ───────────────────────────────── */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowBrandPanel(p => !p)}
                  className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Palette size={15} className="text-indigo-500" />
                    <span className="text-sm font-bold text-slate-800">Branding &amp; Sender Info</span>
                    {draftBranding.companyName && (
                      <span className="text-xs text-slate-400 font-normal ml-1">— {draftBranding.companyName}</span>
                    )}
                    {brandingDirty && (
                      <span className="text-[10px] font-semibold rounded-full bg-amber-100 text-amber-900 px-2 py-0.5">Unsaved</span>
                    )}
                  </div>
                  {showBrandPanel ? <ChevronUp size={15} className="text-slate-400 shrink-0" /> : <ChevronDown size={15} className="text-slate-400 shrink-0" />}
                </button>

                {showBrandPanel && (
                  <div className="px-6 pb-6 border-t border-slate-100 space-y-5">
                    {/* Logo + accent color row */}
                    <div className="flex flex-wrap gap-4 pt-4">
                      {/* Logo upload — draft only until Save branding */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-slate-600">Company logo</span>
                        <label className="cursor-pointer group">
                          {draftBranding.logoDataUrl ? (
                            <div className="relative w-28 h-16 rounded-lg border-2 border-dashed border-indigo-200 overflow-hidden">
                              <img
                                src={draftBranding.logoDataUrl}
                                alt="Logo"
                                className="w-full h-full object-contain"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                <Upload size={14} className="text-white" />
                              </div>
                            </div>
                          ) : (
                            <div
                              className="w-28 h-16 rounded-lg border-2 border-dashed border-indigo-200 bg-indigo-50/50 flex flex-col items-center justify-center gap-1 hover:bg-indigo-100 transition-colors"
                            >
                              <Upload size={14} className="text-indigo-400" />
                              <span className="text-[10px] text-indigo-400">Upload logo</span>
                            </div>
                          )}
                          <input
                            ref={logoFileInputRef}
                            type="file"
                            accept="image/*"
                            className="sr-only"
                            onChange={e => handleLogoFileSelect(e.target.files?.[0] ?? null)}
                          />
                        </label>
                        <div className="flex flex-col gap-1.5">
                          {draftBranding.logoDataUrl && (
                            <button
                              type="button"
                              onClick={() => patchDraftBranding({ logoDataUrl: null })}
                              className="text-[10px] text-red-400 hover:text-red-600 self-start"
                            >
                              Remove logo
                            </button>
                          )}
                          <p className="text-[10px] text-slate-400 max-w-[14rem] leading-snug">
                            Logo and all fields below update the quote preview immediately; click Save branding to store everything on this device for future quotes.
                          </p>
                        </div>
                      </div>

                      {/* Signature upload */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-slate-600">Signature</span>
                        <label className="cursor-pointer group">
                          {draftBranding.signatureDataUrl ? (
                            <div className="relative w-28 h-16 rounded-lg border-2 border-dashed border-purple-200 overflow-hidden bg-white">
                              <img src={draftBranding.signatureDataUrl} alt="Signature" className="w-full h-full object-contain" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                <Upload size={14} className="text-white" />
                              </div>
                            </div>
                          ) : (
                            <div className="w-28 h-16 rounded-lg border-2 border-dashed border-purple-200 bg-purple-50/50 flex flex-col items-center justify-center gap-1 hover:bg-purple-100 transition-colors">
                              <Pencil size={13} className="text-purple-400" />
                              <span className="text-[10px] text-purple-400">Upload signature</span>
                            </div>
                          )}
                          <input type="file" accept="image/*" className="sr-only" onChange={e => handleSignatureFileSelect(e.target.files?.[0] ?? null)} />
                        </label>
                        {draftBranding.signatureDataUrl && (
                          <button type="button" onClick={() => patchDraftBranding({ signatureDataUrl: null })} className="text-[10px] text-red-400 hover:text-red-600">Remove</button>
                        )}
                      </div>

                      {/* Brand color */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-slate-600">Brand color</span>
                        <div className="flex items-center gap-2">
                          <label className="cursor-pointer">
                            <div className="w-10 h-10 rounded-lg border-2 border-slate-200 overflow-hidden" style={{ backgroundColor: draftBranding.accentColor }}>
                              <input type="color" value={draftBranding.accentColor} onChange={e => patchDraftBranding({ accentColor: e.target.value })} className="opacity-0 w-full h-full cursor-pointer" />
                            </div>
                          </label>
                          <input
                            type="text"
                            value={draftBranding.accentColor}
                            onChange={e => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && patchDraftBranding({ accentColor: e.target.value })}
                            className="w-24 rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-700 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          />
                        </div>
                        {/* Preset palette */}
                        <div className="flex gap-1.5 flex-wrap">
                          {['#1e40af','#0f766e','#7c3aed','#b91c1c','#b45309','#1d4ed8','#0e7490','#15803d'].map(c => (
                            <button key={c} type="button" onClick={() => patchDraftBranding({ accentColor: c })}
                              className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                              style={{ backgroundColor: c, borderColor: draftBranding.accentColor === c ? '#1e293b' : 'transparent' }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Company details */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {[
                        { label: 'Company name', key: 'companyName', placeholder: 'Best Roofing Co.' },
                        { label: 'Tagline', key: 'tagline', placeholder: 'Quality you can trust' },
                        { label: 'Address', key: 'address', placeholder: '123 Main St' },
                        { label: 'City, State, ZIP', key: 'city', placeholder: 'Vancouver, BC V6B 1A1' },
                        { label: 'Phone', key: 'phone', placeholder: '+1 (604) 555-0100' },
                        { label: 'Email', key: 'email', placeholder: 'info@bestroofing.com' },
                        { label: 'Website', key: 'website', placeholder: 'www.bestroofing.com' },
                        { label: 'License / ROC #', key: 'licenseNo', placeholder: 'ROC-123456' },
                      ].map(({ label, key, placeholder }) => (
                        <div key={key}>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
                          <input
                            type="text"
                            value={(draftBranding as unknown as Record<string, string>)[key] ?? ''}
                            onChange={e => patchDraftBranding({ [key]: e.target.value } as Partial<QuoteBranding>)}
                            placeholder={placeholder}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Terms */}
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">Terms &amp; Conditions</label>
                      <textarea
                        rows={3}
                        value={draftBranding.terms}
                        onChange={e => patchDraftBranding({ terms: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={persistBranding}
                        disabled={!brandingDirty}
                        className="text-xs font-semibold rounded-lg bg-indigo-600 text-white px-4 py-2 hover:bg-indigo-700 disabled:opacity-40 disabled:pointer-events-none"
                      >
                        Save branding
                      </button>
                      <button
                        type="button"
                        onClick={discardBrandingDraft}
                        disabled={!brandingDirty}
                        className="text-xs font-medium text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline disabled:opacity-40 disabled:pointer-events-none"
                      >
                        Discard changes
                      </button>
                    </div>

                    <p className="text-[10px] text-slate-400">
                      Edits update the quote preview above; click Save branding to store everything in this browser so new quotes stay uniform. Open this panel anytime to change it again.
                    </p>
                  </div>
                )}
              </div>

              {/* ── Client / recipient ──────────────────────────────────── */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <MapPin size={14} className="text-emerald-500" />
                    Client / Recipient
                  </h3>
                </div>
                <div className="px-6 py-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: 'Client name', key: 'name', placeholder: 'John Smith' },
                    { label: 'Address', key: 'address', placeholder: '456 Oak Ave' },
                    { label: 'City, State, ZIP', key: 'city', placeholder: 'Kamloops, BC V2B 0A6' },
                    { label: 'Phone', key: 'phone', placeholder: '+1 (250) 555-0199' },
                    { label: 'Email', key: 'email', placeholder: 'john@example.com' },
                  ].map(({ label, key, placeholder }) => (
                    <div key={key}>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
                      <input
                        type="text"
                        value={(client as unknown as Record<string, string>)[key] ?? ''}
                        onChange={e => setClient(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder={placeholder}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      />
                    </div>
                  ))}
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Quote #</label>
                    <input
                      type="text"
                      value={quoteNo}
                      onChange={e => setQuoteNo(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Valid for (days)</label>
                    <input
                      type="number"
                      min={1}
                      value={validDays}
                      onChange={e => setValidDays(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                </div>
              </div>

              {/* Material selector */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <DollarSign size={15} className="text-emerald-600" />
                    Material Selection
                  </h3>
                </div>
                <div className="px-6 py-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {MATERIALS.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setSelectedMaterial(m);
                        setMatPricePerSq(m.pricePerSquare);
                        setLaborPricePerSq(m.laborPerSquare);
                        setLineAmtEdits({});
                        setDeletedLineKeys(new Set());
                      }}
                      className={`rounded-lg border-2 p-3 text-left transition-all ${
                        selectedMaterial.id === m.id
                          ? 'border-emerald-500 bg-emerald-50'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="text-xs font-bold text-slate-800 mb-1">{m.name}</div>
                      <div className="text-[11px] text-slate-500">${m.pricePerSquare}/sq material</div>
                      <div className="text-[11px] text-slate-400">${m.laborPerSquare}/sq labor</div>
                    </button>
                  ))}
                </div>
                <div className="px-6 pb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Material $/sq</label>
                    <input
                      type="number"
                      min={0}
                      value={matPricePerSq}
                      onChange={e => setMatPricePerSq(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Labor $/sq</label>
                    <input
                      type="number"
                      min={0}
                      value={laborPricePerSq}
                      onChange={e => setLaborPricePerSq(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Waste %</label>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={wastePct}
                      onChange={e => setWastePct(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Tax rate %</label>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      step={0.1}
                      value={taxRate}
                      onChange={e => setTaxRate(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-4">
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Quote label (optional)</label>
                    <input
                      type="text"
                      value={quoteRunLabel}
                      onChange={e => setQuoteRunLabel(e.target.value)}
                      placeholder="e.g. Option A — premium shingles"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>
                </div>
              </div>

              {/* Line items breakdown — fully editable */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800">Cost Breakdown</h3>
                  {quoteComputed.totalSqFt === 0 && (
                    <p className="text-xs text-amber-700 mt-1">Roof area not yet available — open the Wizard report tab first to load measurements.</p>
                  )}
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {/* Material row — editable via $/sq above */}
                    <tr className="bg-slate-50">
                      <td className="px-6 py-3 font-semibold text-slate-700">
                        Material — {selectedMaterial.name}
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          {quoteComputed.orderSquares} sq × ${matPricePerSq} ({quoteComputed.totalSqFt} sq ft + {wastePct}% waste)
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right w-36">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-slate-400 text-xs">$</span>
                          <input
                            type="number"
                            min={0}
                            value={lineAmtEdits['material'] ?? quoteComputed.materialCost}
                            onChange={e => setLineAmtEdits(prev => ({ ...prev, material: Number(e.target.value) }))}
                            className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                          />
                        </div>
                      </td>
                      <td className="w-8" />
                    </tr>
                    {/* Labor row */}
                    <tr>
                      <td className="px-6 py-3 text-slate-600">
                        Labor
                        <span className="ml-2 text-xs text-slate-400">{quoteComputed.orderSquares} sq × ${laborPricePerSq}</span>
                      </td>
                      <td className="px-4 py-2 text-right w-36">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-slate-400 text-xs">$</span>
                          <input
                            type="number"
                            min={0}
                            value={lineAmtEdits['labor'] ?? quoteComputed.laborCost}
                            onChange={e => setLineAmtEdits(prev => ({ ...prev, labor: Number(e.target.value) }))}
                            className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                          />
                        </div>
                      </td>
                      <td className="w-8" />
                    </tr>
                    {/* Additional line items — each editable and deletable */}
                    {quoteComputed.visibleItems.map(item => (
                      <tr key={item.key}>
                        <td className="px-6 py-2 text-slate-600">{item.label}</td>
                        <td className="px-4 py-2 text-right w-36">
                          <div className="flex items-center justify-end gap-1">
                            <span className="text-slate-400 text-xs">$</span>
                            <input
                              type="number"
                              min={0}
                              value={item.amount}
                              onChange={e => setLineAmtEdits(prev => ({ ...prev, [item.key]: Number(e.target.value) }))}
                              className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                            />
                          </div>
                        </td>
                        <td className="w-8 pr-3">
                          <button
                            type="button"
                            onClick={() => setDeletedLineKeys(prev => new Set([...prev, item.key]))}
                            className="p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                            title="Remove line item"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {/* Add item row */}
                    {addingItem ? (
                      <tr className="bg-slate-50">
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            placeholder="Item description"
                            value={newItemLabel}
                            onChange={e => setNewItemLabel(e.target.value)}
                            autoFocus
                            className="w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                          />
                        </td>
                        <td className="px-4 py-2 w-36">
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 text-xs">$</span>
                            <input
                              type="number"
                              min={0}
                              placeholder="0"
                              value={newItemAmt}
                              onChange={e => setNewItemAmt(e.target.value)}
                              className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                            />
                          </div>
                        </td>
                        <td className="w-8 pr-2">
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (!newItemLabel.trim()) return;
                                setCustomCosts(prev => [...prev, { label: newItemLabel.trim(), amount: Number(newItemAmt) || 0 }]);
                                setNewItemLabel('');
                                setNewItemAmt('');
                                setAddingItem(false);
                              }}
                              className="p-1 rounded text-emerald-600 hover:bg-emerald-50 transition-colors"
                              title="Confirm"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setAddingItem(false); setNewItemLabel(''); setNewItemAmt(''); }}
                              className="p-1 rounded text-slate-400 hover:bg-slate-100 transition-colors"
                              title="Cancel"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr>
                        <td colSpan={3} className="px-6 py-2">
                          <button
                            type="button"
                            onClick={() => setAddingItem(true)}
                            className="flex items-center gap-1.5 text-xs text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
                          >
                            <Plus size={13} />
                            Add line item
                          </button>
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-slate-200 bg-slate-50">
                      <td className="px-6 py-3 font-semibold text-slate-700">Subtotal</td>
                      <td className="px-6 py-3 text-right font-semibold text-slate-900">${Math.round(quoteComputed.subtotal).toLocaleString()}</td>
                      <td className="w-8" />
                    </tr>
                    <tr>
                      <td className="px-6 py-3 text-slate-600">Tax ({taxRate}%)</td>
                      <td className="px-6 py-3 text-right text-slate-900">${Math.round(quoteComputed.taxAmt).toLocaleString()}</td>
                      <td className="w-8" />
                    </tr>
                    <tr className="border-t-2 border-emerald-200 bg-emerald-50">
                      <td className="px-6 py-3 font-bold text-emerald-800 text-base">Total Estimate</td>
                      <td className="px-6 py-3 text-right font-bold text-emerald-900 text-base">${Math.round(quoteComputed.total).toLocaleString()}</td>
                      <td className="w-8" />
                    </tr>
                  </tbody>
                </table>
                <div className="px-6 py-4 border-t border-slate-100">
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Notes</label>
                  <textarea
                    rows={3}
                    value={quoteNotes}
                    onChange={e => setQuoteNotes(e.target.value)}
                    placeholder="Any additional notes for this quote…"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveQuote()}
                    disabled={savingQuote}
                    className="mt-3 flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 transition-colors"
                  >
                    {savingQuote ? <Loader2 size={14} className="animate-spin" /> : quoteSaved ? <Check size={14} /> : <Plus size={14} />}
                    {quoteSaved ? 'Saved!' : 'Save Quote'}
                  </button>
                </div>
              </div>

              {/* Saved quotes list */}
              {(quotesLoading || savedQuotes.length > 0) && (
                <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-800">Saved Quotes ({savedQuotes.length})</h3>
                    {quotesLoading && <Loader2 size={14} className="animate-spin text-slate-400" />}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {savedQuotes.map(q => (
                      <div key={q.id} className="px-6 py-4 flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-800 truncate">{q.run_label ?? q.material_name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{q.material_name} · {q.total_squares} sq</div>
                          {q.notes && <div className="text-xs text-slate-400 mt-1 italic">{q.notes}</div>}
                          <div className="text-xs text-slate-400 mt-1">{new Date(q.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-base font-bold text-emerald-700">${Math.round(q.total).toLocaleString()}</span>
                          <button
                            type="button"
                            onClick={() => void handleDeleteQuote(q.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Quote document preview ─────────────────────────────── */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowPreview(p => !p)}
                  className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Printer size={15} className="text-slate-500" />
                    <span className="text-sm font-bold text-slate-800">Quote Document Preview</span>
                  </div>
                  {showPreview ? <ChevronUp size={15} className="text-slate-400" /> : <ChevronDown size={15} className="text-slate-400" />}
                </button>

                {showPreview && (
                  <div className="border-t border-slate-100">
                    <div className="px-6 py-3 bg-slate-50 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="text-xs text-slate-500">This is exactly what your client will see when printed.</p>
                        {quotePdfError && <p className="text-xs text-red-600">{quotePdfError}</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            const el = quoteDocRef.current;
                            if (!el) {
                              window.print();
                              return;
                            }
                            const container = document.querySelector('.quote-doc-container');
                            printElementIsolated(el, container);
                          }}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-white text-xs font-semibold hover:bg-slate-700 transition-colors"
                        >
                          <Printer size={13} />
                          Print / Save PDF
                        </button>
                        <button
                          type="button"
                          disabled={quotePdfExporting}
                          onClick={async () => {
                            const el = quoteDocRef.current;
                            if (!el) return;
                            setQuotePdfExporting(true);
                            setQuotePdfError(null);
                            try {
                              const slug = quoteNo.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
                              await downloadQuoteDocumentPdf(el, {
                                fileName: `RoofIQ-quote-${slug || 'draft'}-${Date.now()}.pdf`,
                              });
                            } catch (e) {
                              setQuotePdfError(e instanceof Error ? e.message : 'Could not download PDF');
                            } finally {
                              setQuotePdfExporting(false);
                            }
                          }}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                        >
                          {quotePdfExporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                          Download PDF
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-100">
                      <div className="quote-doc-container shadow-xl rounded overflow-hidden max-w-3xl mx-auto">
                        <QuoteDocumentView
                          ref={quoteDocRef}
                          branding={draftBranding}
                          client={client}
                          quoteNo={quoteNo}
                          quoteDate={new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}
                          validDays={validDays}
                          materialName={selectedMaterial.name}
                          orderSquares={quoteComputed.orderSquares}
                          totalSqFt={quoteComputed.totalSqFt}
                          wastePct={wastePct}
                          matPricePerSq={matPricePerSq}
                          laborPricePerSq={laborPricePerSq}
                          materialCost={quoteComputed.materialCost}
                          laborCost={quoteComputed.laborCost}
                          lineItems={quoteComputed.visibleItems.map(i => ({ label: i.label, amount: i.amount }))}
                          subtotal={quoteComputed.subtotal}
                          taxRate={taxRate}
                          taxAmt={quoteComputed.taxAmt}
                          total={quoteComputed.total}
                          notes={quoteNotes}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

          ) : activeTab === 'materials' ? (
            <MaterialEstimateReport report={wizardReport} />

          ) : activeTab === 'history' ? (
            <div className="py-4 sm:py-6 space-y-4">
              {historyLoading && (
                <div className="flex items-center justify-center py-10 gap-3 text-slate-500 text-sm">
                  <Loader2 size={18} className="animate-spin text-violet-500" />
                  Loading analysis history…
                </div>
              )}
              {!historyLoading && historyRuns.length === 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500 text-sm">
                  No saved analysis runs yet. Complete the Roof Mapping Wizard to create a history entry.
                </div>
              )}
              {!historyLoading && historyRuns.length > 0 && (
                <>
                  {/* Run selector */}
                  <div className="rounded-xl border border-slate-200 bg-white shadow-sm px-5 py-4 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Analysis run</label>
                      <div className="relative">
                        <select
                          value={selectedRunId ?? ''}
                          onChange={e => setSelectedRunId(e.target.value || null)}
                          className="w-full appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-400"
                        >
                          {historyRuns.map(r => (
                            <option key={r.id} value={r.id}>{r.run_label}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      </div>
                    </div>

                    {selectedRunId && (
                      <div className="flex items-center gap-2 pt-5">
                        {editingLabelId === selectedRunId ? (
                          <>
                            <input
                              type="text"
                              value={editingLabelValue}
                              onChange={e => setEditingLabelValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') void handleRenameRun(selectedRunId); if (e.key === 'Escape') setEditingLabelId(null); }}
                              autoFocus
                              className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-400 w-52"
                            />
                            <button
                              type="button"
                              onClick={() => void handleRenameRun(selectedRunId)}
                              className="p-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingLabelId(null)}
                              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors"
                            >
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              const run = historyRuns.find(r => r.id === selectedRunId);
                              setEditingLabelValue(run?.run_label ?? '');
                              setEditingLabelId(selectedRunId);
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-500 hover:text-violet-700 hover:bg-violet-50 text-xs font-semibold transition-colors"
                          >
                            <Pencil size={13} />
                            Rename
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteRun(selectedRunId)}
                          disabled={deletingRunId === selectedRunId}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 text-xs font-semibold transition-colors disabled:opacity-50"
                        >
                          {deletingRunId === selectedRunId ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          Delete
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Run report */}
                  {selectedRunLoading && (
                    <div className="flex items-center justify-center py-10 gap-3 text-slate-500 text-sm">
                      <Loader2 size={16} className="animate-spin text-violet-500" />
                      Loading report…
                    </div>
                  )}
                  {!selectedRunLoading && selectedRunReport && (
                    <WizardWorkflowReportView
                      report={selectedRunReport}
                      savedSectionCount={project?.section_count ?? 0}
                      onOpenQuoteBuilder={
                        onOpenQuoteFromProject ? () => void onOpenQuoteFromProject(projectId) : undefined
                      }
                      mapsApiKey={readMapsApiKey()}
                    />
                  )}
                  {!selectedRunLoading && !selectedRunReport && selectedRunId && (
                    <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500 text-sm">
                      Could not load this run's report.
                    </div>
                  )}
                </>
              )}
            </div>

          ) : (
            <div className="rounded-xl overflow-hidden border border-slate-200 bg-white shadow-sm mt-4 mb-4">
              {/* Stats row */}
              <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200">
                {[
                  { icon: <Layers size={14} />, label: 'Sections', value: project?.section_count ?? 0 },
                  { icon: <Ruler size={14} />, label: 'Total Roof Area', value: `${totalActual.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft` },
                  { icon: <Calendar size={14} />, label: 'Created', value: new Date(project?.created_at ?? '').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                ].map(stat => (
                  <div key={stat.label} className="bg-white px-4 py-3">
                    <div className="flex items-center gap-1.5 text-slate-400 text-xs mb-1">
                      {stat.icon}
                      {stat.label}
                    </div>
                    <div className="text-slate-900 font-bold text-base">{stat.value}</div>
                  </div>
                ))}
              </div>

              {/* Snapshots gallery */}
              <div className="py-4 px-6">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Image size={13} />
                  Saved Images ({snapshots.length})
                </h3>

                {snapshots.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400 text-sm">
                    No snapshots saved for this project.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                    {snapshots.map((snap, idx) => {
                      const ai = snapAI[snap.id];
                      return (
                        <div key={snap.id} className="flex flex-col gap-2">
                          {/* Thumbnail */}
                          <button
                            onClick={() => setLightboxIdx(idx)}
                            className="group relative rounded-xl overflow-hidden border border-slate-200 hover:border-blue-400 hover:shadow-lg transition-all aspect-video bg-slate-100"
                          >
                            <img src={snap.snapshot_url} alt={snap.label} className="w-full h-full object-cover" loading="lazy" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center">
                              <ZoomIn size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
                              <span className="text-white text-xs font-medium">{snap.label}</span>
                            </div>
                            {/* Condition badge if analyzed */}
                            {ai?.status === 'done' && ai.result && (
                              <div
                                className="absolute top-2 right-2 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                                style={{ backgroundColor: CONDITION_COLORS[ai.result.condition] }}
                              >
                                {ai.result.condition}
                              </div>
                            )}
                          </button>

                          {/* AI section */}
                          {!ai && (
                            <button
                              onClick={() => analyzeSnap(snap.id, snap.snapshot_url)}
                              disabled={!hasGeminiKey}
                              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1.5 rounded-lg transition-colors"
                              title={!hasGeminiKey ? 'Add your Gemini key in Settings to enable AI' : ''}
                            >
                              <Brain size={11} />
                              Analyze with AI
                            </button>
                          )}

                          {ai?.status === 'analyzing' && (
                            <div className="flex items-center justify-center gap-1.5 text-xs text-purple-500 py-1">
                              <Loader2 size={11} className="animate-spin" />
                              Analyzing…
                            </div>
                          )}

                          {ai?.status === 'error' && (
                            <div className="flex items-center gap-1.5 text-xs text-red-500 px-1">
                              <AlertTriangle size={11} />
                              {ai.error === 'GOOGLE_AI_KEY_MISSING' ? 'AI key missing' : 'Failed'}
                            </div>
                          )}

                          {ai?.status === 'done' && ai.result && (
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs space-y-1.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`font-bold px-1.5 py-0.5 rounded-full ${CONDITION_BG[ai.result.condition]}`}>
                                  {ai.result.condition}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded-full ${URGENCY_BG[ai.result.urgency]}`}>
                                  {ai.result.urgency}
                                </span>
                                <span className="ml-auto text-slate-400">{ai.result.condition_score}/10</span>
                              </div>
                              <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${ai.result.condition_score * 10}%`, backgroundColor: CONDITION_COLORS[ai.result.condition] }} />
                              </div>
                              <p className="text-slate-500 leading-relaxed">{ai.result.estimated_remaining_life} remaining</p>
                              {ai.result.issues.length > 0 && (
                                <ul className="text-slate-500 space-y-0.5">
                                  {ai.result.issues.slice(0, 3).map((issue, i) => (
                                    <li key={i} className="flex gap-1"><span className="text-amber-400">•</span>{issue}</li>
                                  ))}
                                </ul>
                              )}
                              <p className="text-slate-600 italic">"{ai.result.recommendation}"</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Sections table */}
              <div className="px-6 pb-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Layers size={13} />
                  Roof Sections ({sections.length})
                </h3>

                {sections.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-400 text-sm">
                    No sections recorded.
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Section</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Pitch</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Flat Area</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actual Area</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {sections.map(s => (
                          <tr key={s.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                                <span className="font-medium text-slate-800">{s.name}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-slate-600">{s.pitch}</td>
                            <td className="px-4 py-3 text-right text-slate-600">
                              {s.flat_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                              {s.actual_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <td colSpan={2} className="px-4 py-2.5 text-xs font-bold text-slate-600 uppercase">Total</td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-700">
                            {totalFlat.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                            {totalActual.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>

      {/* Lightbox — covers the same region as the project shell */}
      {lightboxIdx !== null && snapshots[lightboxIdx] && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/90"
          onClick={() => setLightboxIdx(null)}
        >
          <button
            onClick={e => { e.stopPropagation(); prevImage(); }}
            className="absolute left-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <ChevronLeft size={24} />
          </button>

          <div className="max-w-5xl w-full px-16" onClick={e => e.stopPropagation()}>
            <img
              src={snapshots[lightboxIdx].snapshot_url}
              alt={snapshots[lightboxIdx].label}
              className="w-full rounded-xl shadow-2xl"
            />
            <div className="mt-3 text-center">
              <span className="text-white font-semibold text-lg">{snapshots[lightboxIdx].label}</span>
              <span className="text-slate-400 text-sm ml-3">{lightboxIdx + 1} / {snapshots.length}</span>
            </div>
          </div>

          <button
            onClick={e => { e.stopPropagation(); nextImage(); }}
            className="absolute right-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <ChevronRight size={24} />
          </button>

          <button
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
