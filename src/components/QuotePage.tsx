import { useCallback, useState, useRef } from 'react';
import { QuoteData, Material } from '../types';
import { MATERIALS, generateQuote, formatArea, formatCurrency } from '../utils/roofCalculations';
import { RoofSection, Coordinates } from '../types';
import {
  Printer,
  ChevronRight,
  CheckCircle2,
  Info,
  Building2,
  Layers,
  DollarSign,
  ArrowLeft,
  Check,
  Download,
  RotateCcw,
  Phone,
  Mail,
  MapPin,
  Save,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { saveQuote, isDbConfigured } from '../utils/db';
import RoofReport from './RoofReport';

interface QuotePageProps {
  address: string;
  coordinates: Coordinates;
  sections: Omit<RoofSection, 'polygon'>[];
  projectId: string | null;
  mapsApiKey?: string;
  onBack: () => void;
  onRestart: () => void;
}

function MaterialCard({ material, selected, onSelect }: { material: Material; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`touch-manipulation relative w-full min-h-[52px] rounded-2xl border-2 p-3 text-left transition-all duration-200 active:scale-[0.99] sm:min-h-[52px] sm:p-4 ${
        selected
          ? 'border-blue-500 bg-blue-50 shadow-md shadow-blue-100'
          : 'border-slate-100 bg-white hover:border-slate-200 hover:shadow-sm'
      }`}
    >
      {selected && (
        <div className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 sm:right-3 sm:top-3 sm:h-5 sm:w-5">
          <Check size={11} className="text-white" strokeWidth={3} aria-hidden />
        </div>
      )}
      <div className="flex items-start gap-2.5 sm:gap-3">
        <span className="text-xl shrink-0 sm:text-2xl" aria-hidden>{material.icon}</span>
        <div className="min-w-0 flex-1 pr-6 sm:pr-5">
          <div className="text-sm font-semibold text-slate-900">{material.name}</div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500 sm:line-clamp-none">{material.description}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {material.pros.map(p => (
              <span key={p} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                {p}
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-slate-500 sm:text-xs">
            <span className="shrink-0 font-bold text-blue-600 tabular-nums">
              {formatCurrency(material.pricePerSquare)}
              <span className="font-normal text-slate-400">/sq</span>
            </span>
            <span aria-hidden className="hidden text-slate-300 sm:inline">
              ·
            </span>
            <span className="tabular-nums">{material.lifespan}</span>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <span className="tabular-nums">{material.warranty} warranty</span>
          </div>
        </div>
      </div>
    </button>
  );
}

export default function QuotePage({ address, coordinates, sections, projectId, mapsApiKey = '', onBack, onRestart }: QuotePageProps) {
  const [selectedMaterial, setSelectedMaterial] = useState<Material>(MATERIALS[0]);
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteSaved, setQuoteSaved] = useState(false);
  const [quotePersistError, setQuotePersistError] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const clearDraftQuote = useCallback(() => {
    setQuote(null);
    setQuoteSaved(false);
    setQuotePersistError(null);
  }, []);

  /** Persists one quote row to Neon (optional project link). Silent no-op if DB is not configured. */
  const persistQuoteToDb = useCallback(
    async (q: QuoteData) => {
      if (!isDbConfigured()) return;
      setQuoteSaving(true);
      setQuotePersistError(null);
      try {
        await saveQuote(projectId, q);
        setQuoteSaved(true);
      } catch (err: unknown) {
        console.error('[QuotePage] save quote failed', err);
        setQuoteSaved(false);
        const msg = err instanceof Error ? err.message : String(err);
        setQuotePersistError(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
      } finally {
        setQuoteSaving(false);
      }
    },
    [projectId]
  );

  const handleGenerate = () => {
    setGenerating(true);
    setQuotePersistError(null);
    window.setTimeout(() => {
      void (async () => {
        const q = generateQuote(address, coordinates, sections, selectedMaterial);
        setQuote(q);
        setQuoteSaved(false);
        setGenerating(false);
        await persistQuoteToDb(q);
        requestAnimationFrame(() => {
          reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      })();
    }, 1200);
  };

  const handlePrint = () => window.print();

  /** Used when auto-save failed or DB was offline; skips if already persisted. */
  const handleManualSaveQuote = async () => {
    if (!quote || quoteSaving || quoteSaved) return;
    await persistQuoteToDb(quote);
  };

  const totalFlat = sections.reduce((s, r) => s + r.flatArea, 0);
  const totalActual = sections.reduce((s, r) => s + r.actualArea, 0);

  return (
    <div
      className={`animate-fade-in mx-auto max-w-4xl px-3 pt-4 sm:px-4 sm:py-8 ${
        quote
          ? 'pb-[max(11rem,calc(env(safe-area-inset-bottom,0px)+9.5rem))] lg:pb-[max(1.5rem,env(safe-area-inset-bottom,0px))]'
          : 'pb-[max(9rem,calc(env(safe-area-inset-bottom,0px)+7.5rem))] lg:pb-[max(1.5rem,env(safe-area-inset-bottom,0px))]'
      }`}
    >
      <div className="no-print mb-5 space-y-2 sm:mb-8">
        <button
          type="button"
          onClick={onBack}
          className="tap-target touch-manipulation -ml-1 flex items-center gap-2 rounded-xl px-1 py-1 text-sm font-medium text-slate-500 hover:text-slate-800 active:text-slate-900"
        >
          <ArrowLeft size={18} className="shrink-0" aria-hidden />
          Back to analysis
        </button>
        <h1 className="text-xl font-bold leading-tight text-slate-900 sm:text-2xl">Generate Quote</h1>
        <p className="hidden text-slate-500 sm:block sm:text-base">Select a roofing material and generate your itemized estimate.</p>
        <p className="text-xs leading-relaxed text-slate-500 sm:hidden">Tap a material, then use Generate below.</p>
      </div>

      {/* Measurement Summary */}
      <div className="card p-4 sm:p-6 mb-5 sm:mb-6 no-print">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <Layers size={18} className="text-blue-600 shrink-0" aria-hidden />
          <h2 className="font-semibold text-slate-900 text-[15px] sm:text-base">Measurement Summary</h2>
        </div>
        <div className="flex items-start gap-2 text-sm text-slate-600 mb-4">
          <MapPin size={15} className="text-slate-400 shrink-0 mt-0.5" aria-hidden />
          <span className="break-words leading-snug">{address || '—'}</span>
        </div>
        {/* Mobile: section cards */}
        <div className="sm:hidden space-y-2">
          {sections.map(s => (
            <div key={s.id} className="rounded-xl border border-slate-100 bg-slate-50/80 p-3">
              <div className="flex items-center gap-2 font-medium text-slate-800 text-sm mb-2">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                {s.name}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-slate-400">Flat</div>
                  <div className="font-semibold text-slate-700 tabular-nums">{formatArea(s.flatArea)}</div>
                </div>
                <div>
                  <div className="text-slate-400">Pitch</div>
                  <div className="font-semibold text-slate-700">{s.pitch}</div>
                </div>
                <div className="text-right">
                  <div className="text-slate-400">Actual</div>
                  <div className="font-bold text-slate-900 tabular-nums">{formatArea(s.actualArea)}</div>
                </div>
              </div>
            </div>
          ))}
          <div className="rounded-xl bg-slate-100 border border-slate-200 p-3 flex items-center justify-between">
            <span className="font-bold text-slate-900">Total</span>
            <div className="text-right text-xs leading-tight">
              <div className="text-slate-500">Flat {formatArea(totalFlat)}</div>
              <div className="font-bold text-slate-900 tabular-nums">{formatArea(totalActual)} actual</div>
            </div>
          </div>
        </div>
        <div className="hidden sm:block overflow-x-auto -mx-1 px-1">
          <table className="w-full text-sm min-w-[28rem]">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left font-semibold text-slate-600 pb-2 pr-4">Section</th>
                <th className="text-right font-semibold text-slate-600 pb-2 px-4">Flat Area</th>
                <th className="text-right font-semibold text-slate-600 pb-2 px-4">Pitch</th>
                <th className="text-right font-semibold text-slate-600 pb-2 pl-4">Actual Area</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(s => (
                <tr key={s.id} className="border-b border-slate-50">
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                      <span className="font-medium text-slate-800">{s.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-right text-slate-600 tabular-nums">{formatArea(s.flatArea)}</td>
                  <td className="py-2 px-4 text-right text-slate-600">{s.pitch}</td>
                  <td className="py-2 pl-4 text-right font-semibold text-slate-800 tabular-nums">{formatArea(s.actualArea)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 rounded-lg">
                <td className="py-2 pr-4 pl-2 font-bold text-slate-900 rounded-l-lg">Total</td>
                <td className="py-2 px-4 text-right font-bold text-slate-700 tabular-nums">{formatArea(totalFlat)}</td>
                <td className="py-2 px-4" />
                <td className="py-2 pl-4 text-right font-bold text-slate-900 rounded-r-lg tabular-nums">{formatArea(totalActual)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Material Selection */}
      {!quote && (
        <div className="card p-4 sm:p-6 mb-5 sm:mb-6 no-print">
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Building2 size={18} className="text-blue-600 shrink-0" aria-hidden />
            <h2 className="font-semibold text-slate-900 text-[15px] sm:text-base">Select Roofing Material</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5 sm:mb-6">
            {MATERIALS.map(m => (
              <MaterialCard
                key={m.id}
                material={m}
                selected={selectedMaterial.id === m.id}
                onSelect={() => setSelectedMaterial(m)}
              />
            ))}
          </div>
          <div className="hidden lg:block">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="btn-accent min-h-[52px] w-full justify-center py-3.5 text-base touch-manipulation disabled:opacity-80"
            >
              {generating ? (
                <>
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Calculating estimate…
                </>
              ) : (
                <>
                  <DollarSign size={18} aria-hidden />
                  Generate Quote
                  <ChevronRight size={16} aria-hidden />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Mobile / tablet sticky: primary CTA always visible without scrolling past materials */}
      {!quote && (
        <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-20 lg:hidden">
          <div className="pointer-events-auto mx-auto max-w-4xl border-t border-orange-400/40 bg-gradient-to-t from-orange-600 to-orange-500 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] pt-3 shadow-[0_-12px_32px_-8px_rgba(15,23,42,0.25)]">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="tap-target btn-accent inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-base font-semibold disabled:opacity-80"
            >
              {generating ? (
                <>
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                  Calculating estimate…
                </>
              ) : (
                <>
                  <DollarSign size={18} aria-hidden />
                  Generate Quote
                  <ChevronRight size={18} aria-hidden />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Quote Report */}
      {quote && (
        <>
          {quotePersistError && (
            <div className="no-print mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <div className="flex gap-2">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">Quote was not saved to the database</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-red-900/90">{quotePersistError}</p>
                  <button
                    type="button"
                    onClick={() => persistQuoteToDb(quote)}
                    disabled={quoteSaving || !isDbConfigured()}
                    className="tap-target mt-3 inline-flex items-center rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {quoteSaving ? 'Saving…' : 'Retry save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {quote && !isDbConfigured() && (
            <div className="no-print mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
              Quotes list syncing is disabled (database URL not configured on this deployment). Generated estimates still work locally; add{' '}
              <code className="rounded bg-amber-100/80 px-1">VITE_DATABASE_URL</code> to save quotes to Neon.
            </div>
          )}

          {/* Actions bar — wide screens */}
          <div className="no-print mb-4 hidden lg:flex lg:flex-row lg:items-start lg:justify-between lg:gap-6">
            <div className="flex shrink-0 items-center gap-2 text-base font-semibold text-green-600">
              <CheckCircle2 size={20} className="shrink-0" aria-hidden />
              Quote ready
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={clearDraftQuote}
                className="btn-secondary min-h-[48px] touch-manipulation justify-center py-3 text-sm"
              >
                <RotateCcw size={16} aria-hidden />
                Change material
              </button>
              <button
                type="button"
                onClick={handleManualSaveQuote}
                disabled={quoteSaving || quoteSaved}
                className="btn-secondary min-h-[48px] touch-manipulation justify-center py-3 text-sm disabled:opacity-60"
              >
                {quoteSaving ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-600" aria-hidden />
                ) : quoteSaved ? (
                  <CheckCircle2 size={16} className="text-green-500" aria-hidden />
                ) : (
                  <Save size={16} aria-hidden />
                )}
                {quoteSaved ? 'Saved' : 'Save quote'}
              </button>
              <button
                type="button"
                onClick={() => setShowReport(true)}
                className="btn-secondary min-h-[48px] touch-manipulation justify-center py-3 text-sm border-blue-200 text-blue-700 hover:bg-blue-50"
              >
                <FileText size={16} aria-hidden />
                Measurement Report
              </button>
              <button type="button" onClick={handlePrint} className="btn-primary min-h-[48px] touch-manipulation justify-center py-3 text-sm">
                <Printer size={16} aria-hidden />
                Print / PDF
              </button>
            </div>
          </div>

          {/* In-flow notice on phones (sticky bar handles actions) */}
          <div className="no-print mb-3 flex items-center gap-2 text-sm font-semibold text-green-600 lg:hidden">
            <CheckCircle2 size={18} className="shrink-0" aria-hidden />
            Quote ready
          </div>

          {/* Report card */}
          <div ref={reportRef} className="card overflow-hidden" id="quote-report">
            {/* Report header */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 px-4 py-5 sm:px-8 sm:py-7 text-white">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-2 sm:mb-3">
                    <div className="w-8 h-8 sm:w-7 sm:h-7 bg-blue-500 rounded-lg flex items-center justify-center shrink-0">
                      <span className="font-black text-sm">R</span>
                    </div>
                    <span className="font-bold text-lg">RoofIQ</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-black mb-1 leading-tight">Roofing Estimate</h2>
                  <p className="text-slate-400 text-xs sm:text-sm">Professional Quote — Confidential</p>
                </div>
                <div className="sm:text-right pt-1 border-t border-white/10 sm:border-0 sm:pt-0">
                  <div className="text-2xl sm:text-3xl font-black text-white tabular-nums">{formatCurrency(quote.total)}</div>
                  <div className="text-slate-400 text-sm mt-1">Total estimate</div>
                  <div className="mt-2 text-[11px] sm:text-xs text-slate-500">
                    Generated {quote.generatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 sm:p-8">
              {/* Property info */}
              <div className="mb-6 sm:mb-8 pb-6 sm:pb-8 border-b border-slate-100">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Property</h3>
                <div className="flex items-start gap-2 text-slate-700">
                  <MapPin size={16} className="text-slate-400 shrink-0 mt-0.5" aria-hidden />
                  <span className="font-medium text-sm sm:text-base break-words leading-snug">{quote.address}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mt-4">
                  {[
                    { label: 'Roof Sections', value: sections.length.toString() },
                    { label: 'Total Roof Area', value: formatArea(quote.totalActualArea) },
                    { label: 'Roofing Squares', value: `${quote.orderSquares} squares` },
                  ].map(item => (
                    <div key={item.label} className="bg-slate-50 rounded-xl p-3">
                      <div className="text-[11px] sm:text-xs text-slate-400 mb-0.5">{item.label}</div>
                      <div className="font-bold text-slate-900 text-sm sm:text-base break-words">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Material */}
              <div className="mb-6 sm:mb-8 pb-6 sm:pb-8 border-b border-slate-100">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Selected Material</h3>
                <div className="flex items-start gap-3 bg-blue-50 rounded-xl p-4">
                  <span className="text-2xl sm:text-3xl shrink-0 leading-none">{quote.material.icon}</span>
                  <div className="min-w-0">
                    <div className="font-bold text-slate-900 text-sm sm:text-base">{quote.material.name}</div>
                    <div className="text-xs sm:text-sm text-slate-500 mt-0.5 leading-relaxed">{quote.material.description}</div>
                    <div className="text-[11px] sm:text-xs text-blue-600 font-semibold mt-2 leading-snug">
                      Warranty: {quote.material.warranty} · Lifespan: {quote.material.lifespan}
                    </div>
                  </div>
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="mb-6 sm:mb-8">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3 sm:mb-4">Cost Breakdown</h3>
                <div className="space-y-1 sm:space-y-2">
                  {[
                    {
                      label: `Materials (${quote.material.name})`,
                      sublabel: `${quote.orderSquares} squares × ${formatCurrency(quote.material.pricePerSquare)}/sq`,
                      amount: quote.materialCost,
                      highlight: false,
                    },
                    {
                      label: 'Labor & Installation',
                      sublabel: `${quote.orderSquares} squares × ${formatCurrency(quote.material.laborPerSquare)}/sq`,
                      amount: quote.laborCost,
                      highlight: false,
                    },
                    ...quote.additionalCosts.map(c => ({
                      label: c.label,
                      sublabel: '',
                      amount: c.amount,
                      highlight: false,
                    })),
                  ].map(row => (
                    <div key={row.label} className="flex items-start justify-between gap-3 py-2.5 border-b border-slate-50">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-800 text-sm leading-snug">{row.label}</div>
                        {row.sublabel && (
                          <div className="text-[11px] sm:text-xs text-slate-400 mt-0.5 break-words">{row.sublabel}</div>
                        )}
                      </div>
                      <div className="font-semibold text-slate-800 text-sm tabular-nums shrink-0">{formatCurrency(row.amount)}</div>
                    </div>
                  ))}
                </div>

                {/* Subtotals */}
                <div className="mt-4 space-y-2">
                  <div className="flex justify-between gap-3 text-sm text-slate-600 py-1">
                    <span>Subtotal</span>
                    <span className="font-semibold tabular-nums">{formatCurrency(quote.subtotal)}</span>
                  </div>
                  <div className="flex justify-between gap-3 text-sm text-slate-600 py-1">
                    <span>Tax (8%)</span>
                    <span className="font-semibold tabular-nums">{formatCurrency(quote.tax)}</span>
                  </div>
                  <div className="flex justify-between items-center gap-3 bg-slate-900 text-white rounded-xl px-4 py-3.5 mt-2">
                    <span className="font-bold text-sm sm:text-base">Total estimate</span>
                    <span className="font-black text-lg sm:text-xl tabular-nums">{formatCurrency(quote.total)}</span>
                  </div>
                </div>
              </div>

              {/* Waste factor note */}
              <div className="flex gap-3 bg-amber-50 border border-amber-100 rounded-xl p-4 mb-6 sm:mb-8 text-xs sm:text-sm text-amber-800 leading-relaxed">
                <Info size={18} className="flex-shrink-0 mt-0.5 text-amber-500" aria-hidden />
                <div>
                  <span className="font-semibold">Order quantity includes 12% waste factor</span> for cuts, overlaps, and
                  starter courses. Total roof area measured: {formatArea(quote.totalActualArea)} ·
                  Order area: {formatArea(quote.totalActualArea * 1.12)}.
                </div>
              </div>

              {/* Contact footer */}
              <div className="bg-slate-50 rounded-2xl p-4 sm:p-6 text-center border border-slate-100">
                <p className="text-slate-500 text-sm mb-4 leading-relaxed">
                  Questions about this estimate? Contact our roofing experts.
                </p>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 sm:gap-6 text-sm">
                  <a
                    href="tel:+15551234567"
                    className="touch-manipulation inline-flex items-center justify-center gap-2 min-h-[48px] px-4 rounded-xl text-blue-600 hover:bg-white font-medium border border-transparent hover:border-slate-200 active:bg-slate-100"
                  >
                    <Phone size={16} aria-hidden />
                    (555) 123-4567
                  </a>
                  <a
                    href="mailto:quotes@roofiq.com"
                    className="touch-manipulation inline-flex items-center justify-center gap-2 min-h-[48px] px-4 rounded-xl text-blue-600 hover:bg-white font-medium border border-transparent hover:border-slate-200 active:bg-slate-100 break-all"
                  >
                    <Mail size={16} className="shrink-0" aria-hidden />
                    quotes@roofiq.com
                  </a>
                </div>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-4 leading-relaxed">
                  This estimate is based on satellite measurements and is subject to an on-site inspection.
                  Final pricing may vary ±10% based on actual conditions found during inspection.
                </p>
              </div>
            </div>
          </div>

          {/* Bottom actions — PDF on desktop here; phones use sticky bar */}
          <div className="no-print mt-5 flex flex-col-reverse gap-3 sm:mt-6 lg:flex-row lg:items-center lg:justify-between">
            <button
              type="button"
              onClick={onRestart}
              className="btn-secondary tap-target flex min-h-[48px] w-full touch-manipulation items-center justify-center lg:w-auto"
            >
              <RotateCcw size={16} aria-hidden />
              Start new quote
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="btn-primary tap-target hidden min-h-[48px] touch-manipulation items-center justify-center lg:inline-flex"
            >
              <Download size={16} aria-hidden />
              Download PDF
            </button>
          </div>

          {/* Mobile sticky: PDF + report + material + save */}
          <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-20 lg:hidden">
            <div className="pointer-events-auto mx-auto max-w-4xl border-t border-slate-200/90 bg-white/95 px-3 pt-3 backdrop-blur-sm shadow-[0_-10px_30px_-10px_rgba(15,23,42,0.2)]">
              <div className="grid grid-cols-2 gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
                <button
                  type="button"
                  onClick={() => setShowReport(true)}
                  className="tap-target col-span-2 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white"
                >
                  <FileText size={16} aria-hidden />
                  Measurement Report
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="btn-primary tap-target inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl py-3 text-xs"
                >
                  <Printer size={14} aria-hidden />
                  Print / PDF
                </button>
                <button
                  type="button"
                  onClick={clearDraftQuote}
                  className="btn-secondary tap-target inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl py-3 text-xs"
                >
                  <RotateCcw size={14} aria-hidden />
                  Material
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Measurement Report Modal */}
      {showReport && (
        <RoofReport
          address={address}
          coordinates={coordinates}
          sections={sections}
          mapsApiKey={mapsApiKey}
          quoteData={quote}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}
