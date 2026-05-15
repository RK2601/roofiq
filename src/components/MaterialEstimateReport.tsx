import { useMemo, useState, Fragment, useId, useRef } from 'react';
import { Printer, Trash2, Plus, RotateCcw, Download, Save } from 'lucide-react';
import type { WizardWorkflowReportPayload } from '../utils/db';
import { printElementIsolated } from '../utils/printIsolated';
import { downloadMaterialListPdf } from '../utils/materialListPdf';
import { loadMaterialListSnapshot, saveMaterialListSnapshot, type MaterialListSnapshot } from '../utils/materialListStorage';

interface Props {
  report: WizardWorkflowReportPayload | null;
}

interface Measurements {
  totalSqFt: number;
  cappingFt: number;
  valleyFt: number;
  perimeterFt: number;
}

interface BrandRow {
  id: string;
  name: string;
  unit: string;
  coverage: number; // sqft or linear ft covered per unit
  // user-set overrides per waste % (null → use computed)
  overrides: Partial<Record<number, number>>;
}

interface SectionState {
  key: string;
  title: string;
  isArea: boolean; // true → header shows sqft totals, false → ft totals
  baseQtyKey: keyof Measurements; // or 'perimeterPlusValley' (special)
  brands: BrandRow[];
}

interface OtherRow {
  id: string;
  label: string;
  unit: string;
  sheetLen: number;
  baseQtyKey: keyof Measurements | 'perimeterFt';
  overrides: Partial<Record<number, number>>;
}

const WASTE_PCTS = [0, 10, 15, 20];

function mkId() {
  return Math.random().toString(36).slice(2, 9);
}

function getBaseQty(key: string, m: Measurements): number {
  if (key === 'totalSqFt')          return m.totalSqFt;
  if (key === 'cappingFt')           return m.cappingFt;
  if (key === 'valleyFt')            return m.valleyFt;
  if (key === 'perimeterFt')         return m.perimeterFt;
  if (key === 'perimeterPlusValley') return m.perimeterFt + m.valleyFt;
  return 0;
}

const DEFAULT_SECTIONS: SectionState[] = [
  {
    key: 'shingle',
    title: 'Shingle (total sqft)',
    isArea: true,
    baseQtyKey: 'totalSqFt',
    brands: [
      { id: mkId(), name: 'IKO - Cambridge',            unit: 'bundle', coverage: 33.33, overrides: {} },
      { id: mkId(), name: 'CertainTeed - Landmark',      unit: 'bundle', coverage: 33.33, overrides: {} },
      { id: mkId(), name: 'GAF - Timberline',            unit: 'bundle', coverage: 33.33, overrides: {} },
      { id: mkId(), name: 'Owens Corning - Duration',    unit: 'bundle', coverage: 33.33, overrides: {} },
      { id: mkId(), name: 'BP - Mystique',               unit: 'bundle', coverage: 33.33, overrides: {} },
    ],
  },
  {
    key: 'starter',
    title: 'Starter (eaves + rakes)',
    isArea: false,
    baseQtyKey: 'perimeterFt',
    brands: [
      { id: mkId(), name: 'IKO - Leading Edge Plus',      unit: 'bundle', coverage: 115, overrides: {} },
      { id: mkId(), name: 'CertainTeed - SwiftStart',      unit: 'bundle', coverage: 115, overrides: {} },
      { id: mkId(), name: 'GAF - Pro-Start',               unit: 'bundle', coverage: 115, overrides: {} },
      { id: mkId(), name: 'Owens Corning - Starter Strip', unit: 'bundle', coverage: 92,  overrides: {} },
      { id: mkId(), name: 'BP - Starter Strip',            unit: 'bundle', coverage: 66,  overrides: {} },
    ],
  },
  {
    key: 'ice',
    title: 'Ice and Water (eaves + valleys + flashings)',
    isArea: false,
    baseQtyKey: 'perimeterPlusValley' as keyof Measurements,
    brands: [
      { id: mkId(), name: 'IKO - StormShield',          unit: 'roll', coverage: 65, overrides: {} },
      { id: mkId(), name: 'CertainTeed - WinterGuard',   unit: 'roll', coverage: 65, overrides: {} },
      { id: mkId(), name: 'GAF - WeatherWatch',          unit: 'roll', coverage: 65, overrides: {} },
      { id: mkId(), name: 'Owens Corning - WeatherLock', unit: 'roll', coverage: 75, overrides: {} },
      { id: mkId(), name: 'BP - Weathertex',             unit: 'roll', coverage: 65, overrides: {} },
    ],
  },
  {
    key: 'synthetic',
    title: 'Synthetic (total sqft; no laps)',
    isArea: true,
    baseQtyKey: 'totalSqFt',
    brands: [
      { id: mkId(), name: 'IKO - Stormite',               unit: 'roll', coverage: 1000, overrides: {} },
      { id: mkId(), name: 'CertainTeed - RoofRunner',      unit: 'roll', coverage: 1000, overrides: {} },
      { id: mkId(), name: 'GAF - Deck-Armor',              unit: 'roll', coverage: 1000, overrides: {} },
      { id: mkId(), name: 'Owens Corning - RhinoRoof',     unit: 'roll', coverage: 1000, overrides: {} },
      { id: mkId(), name: 'BP - PRODECK',                  unit: 'roll', coverage: 1000, overrides: {} },
    ],
  },
  {
    key: 'capping',
    title: 'Capping (hips + ridges)',
    isArea: false,
    baseQtyKey: 'cappingFt',
    brands: [
      { id: mkId(), name: 'IKO - Hip and Ridge',           unit: 'bundle', coverage: 40, overrides: {} },
      { id: mkId(), name: 'CertainTeed - Shadow Ridge',     unit: 'bundle', coverage: 44, overrides: {} },
      { id: mkId(), name: 'GAF - Seal-A-Ridge',            unit: 'bundle', coverage: 25, overrides: {} },
      { id: mkId(), name: 'Owens Corning - DecoRidge',     unit: 'bundle', coverage: 20, overrides: {} },
      { id: mkId(), name: 'BP - Accu-Ridge',               unit: 'bundle', coverage: 40, overrides: {} },
    ],
  },
];

const DEFAULT_OTHER: OtherRow[] = [
  { id: mkId(), label: "8' Valley (no laps)",                    unit: 'sheet', sheetLen: 8,  baseQtyKey: 'valleyFt',    overrides: {} },
  { id: mkId(), label: "10' Drip Edge (eaves + rakes; no laps)", unit: 'sheet', sheetLen: 10, baseQtyKey: 'perimeterFt', overrides: {} },
];

// ── Editable cell ─────────────────────────────────────────────────────────────
function QtyCell({
  computed,
  override,
  onChange,
}: {
  computed: number;
  override: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const displayed = override ?? computed;
  return (
    <div className="flex items-center justify-end gap-0.5 group">
      <input
        type="number"
        min={0}
        value={displayed}
        onChange={e => {
          const v = Number(e.target.value);
          onChange(v === computed ? undefined : v);
        }}
        className="w-16 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right text-xs text-slate-800 font-medium focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400 transition-colors [color-scheme:light]"
      />
      {override !== undefined && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title="Reset to computed"
          className="no-print text-slate-300 hover:text-orange-500 transition-colors"
        >
          <RotateCcw size={10} />
        </button>
      )}
    </div>
  );
}

export default function MaterialEstimateReport({ report }: Props) {
  const uid = useId();
  const printRootRef = useRef<HTMLDivElement>(null);
  const printAnchorRef = useRef<HTMLDivElement>(null);
  const [materialPdfError, setMaterialPdfError] = useState<string | null>(null);

  const materialDefaults = useMemo((): MaterialListSnapshot => ({
    sections: DEFAULT_SECTIONS as unknown as MaterialListSnapshot['sections'],
    others: DEFAULT_OTHER as unknown as MaterialListSnapshot['others'],
  }), []);

  const materialBoot = useMemo(() => {
    const loaded = loadMaterialListSnapshot(materialDefaults);
    const sections = JSON.parse(JSON.stringify(loaded.sections)) as SectionState[];
    const others = JSON.parse(JSON.stringify(loaded.others)) as OtherRow[];
    const saved: MaterialListSnapshot = JSON.parse(JSON.stringify(loaded)) as MaterialListSnapshot;
    return { sections, others, saved };
  }, [materialDefaults]);

  const [sections, setSections] = useState<SectionState[]>(() => materialBoot.sections);
  const [others, setOthers] = useState<OtherRow[]>(() => materialBoot.others);
  const [savedSnapshot, setSavedSnapshot] = useState<MaterialListSnapshot>(() => materialBoot.saved);

  const listDirty = useMemo(
    () => JSON.stringify({ sections, others }) !== JSON.stringify(savedSnapshot),
    [sections, others, savedSnapshot]
  );

  function persistMaterialList() {
    const snap: MaterialListSnapshot = {
      sections: JSON.parse(JSON.stringify(sections)) as MaterialListSnapshot['sections'],
      others: JSON.parse(JSON.stringify(others)) as MaterialListSnapshot['others'],
    };
    saveMaterialListSnapshot(snap);
    setSavedSnapshot(JSON.parse(JSON.stringify(snap)) as MaterialListSnapshot);
  }

  function discardMaterialListDraft() {
    setSections(JSON.parse(JSON.stringify(savedSnapshot.sections)) as SectionState[]);
    setOthers(JSON.parse(JSON.stringify(savedSnapshot.others)) as OtherRow[]);
  }

  const m = useMemo<Measurements>(() => {
    if (!report) return { totalSqFt: 0, cappingFt: 0, valleyFt: 0, perimeterFt: 0 };

    // Solar API measurements — stored with separate totalRidgeFt/totalHipFt/totalEaveFt/totalRakeFt
    type SolarMeas = {
      totalRoofAreaSqFt?: number;
      totalRidgeFt?: number; totalHipFt?: number;
      totalValleyFt?: number;
      totalEaveFt?: number; totalRakeFt?: number;
      // legacy combined names (keep for backwards compat)
      hipsAndRidgesFt?: number; eavesAndRakesFt?: number;
    };
    const solar = (report.solarStructure as { measurements?: SolarMeas } | null)?.measurements;

    let cappingFt   = solar ? ((solar.hipsAndRidgesFt ?? 0) || ((solar.totalHipFt ?? 0) + (solar.totalRidgeFt ?? 0))) : 0;
    let valleyFt    = solar?.totalValleyFt ?? 0;
    let perimeterFt = solar ? ((solar.eavesAndRakesFt ?? 0) || ((solar.totalEaveFt ?? 0) + (solar.totalRakeFt ?? 0))) : 0;

    // Fallback to AI structure cues when solar data is missing
    if (!cappingFt || !perimeterFt) {
      type Cue = { type: string; estimatedLengthFt?: number };
      const cues = (report.structure as { cues?: Cue[] } | null)?.cues ?? [];
      const sumFt = (t: string) => cues.filter(c => c.type === t).reduce((s, c) => s + (c.estimatedLengthFt ?? 0), 0);
      if (!cappingFt)   cappingFt   = sumFt('ridge') + sumFt('hip');
      if (!valleyFt)    valleyFt    = sumFt('valley');
      if (!perimeterFt) perimeterFt = sumFt('eave') + sumFt('rake');
    }

    // Total area: solar → AI structure → sum of mapped segments
    let totalSqFt = solar?.totalRoofAreaSqFt ?? 0;
    if (!totalSqFt) totalSqFt = (report.structure as { totalAreaSqFt?: number } | null)?.totalAreaSqFt ?? 0;
    if (!totalSqFt && report.segments.length > 0) {
      totalSqFt = report.segments.reduce((sum, seg) => sum + (seg.flatAreaSqFt ?? 0), 0);
    }

    return {
      totalSqFt:   Math.round(totalSqFt),
      cappingFt:   Math.round(cappingFt),
      valleyFt:    Math.round(valleyFt),
      perimeterFt: Math.round(perimeterFt),
    };
  }, [report]);

  const hasData = m.totalSqFt > 0;

  function handleMaterialPrint() {
    const el = printRootRef.current;
    const parent = printAnchorRef.current;
    if (!el || !parent) {
      window.print();
      return;
    }
    printElementIsolated(el, parent);
  }

  function materialPdfFileName(): string {
    const addr = (report?.address ?? 'estimate').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return `RoofIQ-material-estimate-${addr || 'roof'}-${Date.now()}.pdf`;
  }

  // ── Section brand helpers ─────────────────────────────────────────────────
  function updateBrand(secKey: string, brandId: string, patch: Partial<BrandRow>) {
    setSections(prev => prev.map(s =>
      s.key !== secKey ? s : { ...s, brands: s.brands.map(b => b.id !== brandId ? b : { ...b, ...patch }) }
    ));
  }

  function deleteBrand(secKey: string, brandId: string) {
    setSections(prev => prev.map(s =>
      s.key !== secKey ? s : { ...s, brands: s.brands.filter(b => b.id !== brandId) }
    ));
  }

  function addBrand(secKey: string) {
    const sec = sections.find(s => s.key === secKey);
    if (!sec) return;
    const newBrand: BrandRow = { id: mkId(), name: 'New brand', unit: sec.brands[0]?.unit ?? 'bundle', coverage: sec.brands[0]?.coverage ?? 33.33, overrides: {} };
    setSections(prev => prev.map(s => s.key !== secKey ? s : { ...s, brands: [...s.brands, newBrand] }));
  }

  function setBrandOverride(secKey: string, brandId: string, wastePct: number, value: number | undefined) {
    setSections(prev => prev.map(s =>
      s.key !== secKey ? s : {
        ...s,
        brands: s.brands.map(b => {
          if (b.id !== brandId) return b;
          const overrides = { ...b.overrides };
          if (value === undefined) delete overrides[wastePct];
          else overrides[wastePct] = value;
          return { ...b, overrides };
        }),
      }
    ));
  }

  // ── Other row helpers ─────────────────────────────────────────────────────
  function updateOther(id: string, patch: Partial<OtherRow>) {
    setOthers(prev => prev.map(o => o.id !== id ? o : { ...o, ...patch }));
  }

  function deleteOther(id: string) {
    setOthers(prev => prev.filter(o => o.id !== id));
  }

  function addOtherRow() {
    setOthers(prev => [...prev, { id: mkId(), label: 'New item', unit: 'sheet', sheetLen: 10, baseQtyKey: 'perimeterFt', overrides: {} }]);
  }

  function setOtherOverride(id: string, wastePct: number, value: number | undefined) {
    setOthers(prev => prev.map(o => {
      if (o.id !== id) return o;
      const overrides = { ...o.overrides };
      if (value === undefined) delete overrides[wastePct];
      else overrides[wastePct] = value;
      return { ...o, overrides };
    }));
  }

  const inputCls =
    'rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400 [color-scheme:light]';

  return (
    <div ref={printAnchorRef} className="material-estimate-print-anchor py-4 sm:py-6">
      <div ref={printRootRef} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-blue-700">Material Estimate</h2>
              {listDirty && (
                <span className="text-[10px] font-semibold rounded-full bg-amber-100 text-amber-900 px-2 py-0.5">Unsaved</span>
              )}
            </div>
            {report?.address && <p className="text-xs text-slate-500 mt-0.5">{report.address}</p>}
            {hasData && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                <span className="text-xs text-slate-500">Total area: <span className="font-semibold text-slate-700">{m.totalSqFt.toLocaleString()} sqft</span></span>
                {m.cappingFt   > 0 && <span className="text-xs text-slate-500">Hips + ridges: <span className="font-semibold text-slate-700">{m.cappingFt} ft</span></span>}
                {m.valleyFt    > 0 && <span className="text-xs text-slate-500">Valleys: <span className="font-semibold text-slate-700">{m.valleyFt} ft</span></span>}
                {m.perimeterFt > 0 && <span className="text-xs text-slate-500">Eaves + rakes: <span className="font-semibold text-slate-700">{m.perimeterFt} ft</span></span>}
              </div>
            )}
          </div>
          <div className="no-print flex flex-col items-end gap-1 shrink-0">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { setSections(DEFAULT_SECTIONS.map(s => ({ ...s, brands: s.brands.map(b => ({ ...b, id: mkId(), overrides: {} })) }))); setOthers(DEFAULT_OTHER.map(o => ({ ...o, id: mkId(), overrides: {} }))); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
                title="Reset all to defaults"
              >
                <RotateCcw size={13} />
                Reset
              </button>
              <button
                type="button"
                onClick={persistMaterialList}
                disabled={!listDirty}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                <Save size={13} />
                Save list
              </button>
              <button
                type="button"
                onClick={discardMaterialListDraft}
                disabled={!listDirty}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline disabled:opacity-40 disabled:pointer-events-none px-2 py-2"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={handleMaterialPrint}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <Printer size={13} />
                Print
              </button>
              <button
                type="button"
                onClick={() => {
                  setMaterialPdfError(null);
                  try {
                    downloadMaterialListPdf({
                      address: report?.address,
                      measurements: m,
                      hasData,
                      wastePcts: WASTE_PCTS,
                      sections: sections.map(s => ({
                        key: s.key,
                        title: s.title,
                        isArea: s.isArea,
                        baseQtyKey: String(s.baseQtyKey),
                        brands: s.brands.map(b => ({
                          name: b.name,
                          unit: b.unit,
                          coverage: b.coverage,
                          overrides: { ...b.overrides },
                        })),
                      })),
                      others: others.map(o => ({
                        label: o.label,
                        unit: o.unit,
                        sheetLen: o.sheetLen,
                        baseQtyKey: String(o.baseQtyKey),
                        overrides: { ...o.overrides },
                      })),
                      fileName: materialPdfFileName(),
                    });
                  } catch (e) {
                    setMaterialPdfError(e instanceof Error ? e.message : 'Could not download PDF');
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
              >
                <Download size={13} />
                Download PDF
              </button>
            </div>
            {materialPdfError && <p className="text-xs text-red-600 max-w-[14rem] text-right leading-snug">{materialPdfError}</p>}
          </div>
        </div>

        {!hasData && (
          <div className="px-6 py-4 border-b border-amber-100 bg-amber-50/90">
            <p className="text-sm font-semibold text-amber-950">Roof measurements not loaded yet</p>
            <p className="text-xs text-amber-900/85 mt-1 leading-relaxed">
              Complete the Smart Roof Mapping wizard on this project for live areas and lineal feet. The full material list template below stays available to edit, print, or download as a checklist anytime.
            </p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-2.5 text-left font-semibold text-slate-500 w-1/2">Product</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-500 w-20">Unit</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-500 w-24">Coverage/unit</th>
                  {WASTE_PCTS.map(w => (
                    <th key={w} className="px-2 py-2.5 text-right font-semibold text-slate-500 whitespace-nowrap">Waste ({w}%)</th>
                  ))}
                  <th className="w-8 no-print" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {sections.map(section => {
                  const baseQty = getBaseQty(section.baseQtyKey as string, m);
                  if (hasData && baseQty <= 0 && section.key !== 'shingle') return null;
                  return (
                    <Fragment key={section.key}>
                      {/* Section header — title editable, totals computed */}
                      <tr className="bg-blue-50/60 border-t border-slate-200">
                        <td className="px-4 py-2" colSpan={3}>
                          <input
                            value={section.title}
                            onChange={e => setSections(prev => prev.map(s => s.key !== section.key ? s : { ...s, title: e.target.value }))}
                            className="font-semibold text-slate-800 bg-white border border-slate-200 rounded px-2 py-1 focus:border-emerald-400 focus:outline-none w-full [color-scheme:light]"
                          />
                        </td>
                        {WASTE_PCTS.map(w => (
                          <td key={w} className="px-2 py-2 text-right font-semibold text-slate-600 whitespace-nowrap">
                            {section.isArea
                              ? `${Math.round(baseQty * (1 + w / 100)).toLocaleString()} sqft`
                              : `${Math.round(baseQty * (1 + w / 100))} ft`}
                          </td>
                        ))}
                        <td className="no-print" />
                      </tr>

                      {/* Brand rows */}
                      {section.brands.map(brand => {
                        const computed = (w: number) => Math.ceil(baseQty * (1 + w / 100) / brand.coverage);
                        return (
                          <tr key={brand.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                            <td className="px-4 py-1 pl-8">
                              <input
                                value={brand.name}
                                onChange={e => updateBrand(section.key, brand.id, { name: e.target.value })}
                                className={`${inputCls} w-full`}
                              />
                            </td>
                            <td className="px-3 py-1">
                              <input
                                value={brand.unit}
                                onChange={e => updateBrand(section.key, brand.id, { unit: e.target.value })}
                                className={`${inputCls} w-16`}
                              />
                            </td>
                            <td className="px-3 py-1">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min={0.1}
                                  step={0.01}
                                  value={brand.coverage}
                                  onChange={e => updateBrand(section.key, brand.id, { coverage: Number(e.target.value), overrides: {} })}
                                  className={`${inputCls} w-16 text-right`}
                                  title="Coverage per unit (sqft or ft)"
                                />
                                <span className="text-slate-400 whitespace-nowrap">{section.isArea ? 'sqft' : 'ft'}</span>
                              </div>
                            </td>
                            {WASTE_PCTS.map(w => (
                              <td key={w} className="px-2 py-1 text-right">
                                <QtyCell
                                  computed={computed(w)}
                                  override={brand.overrides[w]}
                                  onChange={v => setBrandOverride(section.key, brand.id, w, v)}
                                />
                              </td>
                            ))}
                            <td className="no-print pr-2 py-1 text-right">
                              <button
                                type="button"
                                onClick={() => deleteBrand(section.key, brand.id)}
                                className="p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                                title="Remove"
                              >
                                <Trash2 size={12} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}

                      {/* Add brand button */}
                      <tr className="border-t border-slate-100 no-print">
                        <td colSpan={8} className="px-4 py-1 pl-8">
                          <button
                            type="button"
                            onClick={() => addBrand(section.key)}
                            className="flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
                          >
                            <Plus size={11} />
                            Add brand
                          </button>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}

                {/* Other section */}
                <Fragment key="other">
                  <tr className="bg-blue-50/60 border-t-2 border-slate-200">
                    <td className="px-4 py-2 font-semibold text-slate-700" colSpan={3}>Other</td>
                    {WASTE_PCTS.map(w => <td key={w} />)}
                    <td className="no-print" />
                  </tr>

                  {others.map(row => {
                    const baseQty = getBaseQty(row.baseQtyKey as string, m);
                    const computed = (w: number) => Math.ceil(baseQty * (1 + w / 100) / row.sheetLen);
                    return (
                      <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                        <td className="px-4 py-1 pl-8">
                          <input
                            value={row.label}
                            onChange={e => updateOther(row.id, { label: e.target.value })}
                            className={`${inputCls} w-full`}
                          />
                        </td>
                        <td className="px-3 py-1">
                          <input
                            value={row.unit}
                            onChange={e => updateOther(row.id, { unit: e.target.value })}
                            className={`${inputCls} w-16`}
                          />
                        </td>
                        <td className="px-3 py-1">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={1}
                              value={row.sheetLen}
                              onChange={e => updateOther(row.id, { sheetLen: Number(e.target.value), overrides: {} })}
                              className={`${inputCls} w-16 text-right`}
                              title="Length per sheet (ft)"
                            />
                            <span className="text-slate-400">ft</span>
                          </div>
                        </td>
                        {WASTE_PCTS.map(w => (
                          <td key={w} className="px-2 py-1 text-right">
                            <QtyCell
                              computed={computed(w)}
                              override={row.overrides[w]}
                              onChange={v => setOtherOverride(row.id, w, v)}
                            />
                          </td>
                        ))}
                        <td className="no-print pr-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => deleteOther(row.id)}
                            className="p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                            title="Remove"
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {/* Add other item */}
                  <tr className="border-t border-slate-100 no-print">
                    <td colSpan={8} className="px-4 py-2 pl-8">
                      <button
                        type="button"
                        onClick={addOtherRow}
                        className="flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
                      >
                        <Plus size={11} />
                        Add item
                      </button>
                    </td>
                  </tr>
                </Fragment>
              </tbody>
            </table>
        </div>

        {/* Disclaimer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50">
          <p className="text-[10px] text-slate-400 leading-relaxed">
            These calculations are approximations and are not guaranteed. Always double check material order quantities before using these calculations.
            Use Save list to store this template in your browser (all projects).{' '}
            <span className="no-print">
              {' '}Quantities with a{' '}
              <RotateCcw size={9} className="inline" />{' '}
              icon have been manually overridden — click the icon to restore the computed value.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
