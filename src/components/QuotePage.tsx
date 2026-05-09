import { useState, useRef } from 'react';
import { QuoteData, Material } from '../types';
import { MATERIALS, generateQuote, formatArea, formatCurrency } from '../utils/roofCalculations';
import { RoofSection, Coordinates } from '../types';
import {
  FileText,
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
} from 'lucide-react';
import { saveQuote } from '../utils/db';

interface QuotePageProps {
  address: string;
  coordinates: Coordinates;
  sections: Omit<RoofSection, 'polygon'>[];
  projectId: string | null;
  onBack: () => void;
  onRestart: () => void;
}

function MaterialCard({ material, selected, onSelect }: { material: Material; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`touch-manipulation relative w-full text-left rounded-2xl border-2 p-4 min-h-[52px] transition-all duration-200 active:scale-[0.99] ${
        selected
          ? 'border-blue-500 bg-blue-50 shadow-md shadow-blue-100'
          : 'border-slate-100 bg-white hover:border-slate-200 hover:shadow-sm'
      }`}
    >
      {selected && (
        <div className="absolute top-3 right-3 w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center">
          <Check size={11} className="text-white" strokeWidth={3} />
        </div>
      )}
      <div className="flex items-start gap-3">
        <span className="text-2xl">{material.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-900 text-sm">{material.name}</div>
          <div className="text-slate-500 text-xs mt-0.5 leading-relaxed">{material.description}</div>
          <div className="flex flex-wrap gap-1 mt-2">
            {material.pros.map(p => (
              <span key={p} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium">
                {p}
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs">
            <span className="text-blue-600 font-bold">{formatCurrency(material.pricePerSquare)}<span className="text-slate-400 font-normal">/sq</span></span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{material.lifespan}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{material.warranty} warranty</span>
          </div>
        </div>
      </div>
    </button>
  );
}

export default function QuotePage({ address, coordinates, sections, projectId, onBack, onRestart }: QuotePageProps) {
  const [selectedMaterial, setSelectedMaterial] = useState<Material>(MATERIALS[0]);
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteSaved, setQuoteSaved] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const handleGenerate = () => {
    setGenerating(true);
    setTimeout(() => {
      const q = generateQuote(address, coordinates, sections, selectedMaterial);
      setQuote(q);
      setGenerating(false);
      setTimeout(() => reportRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }, 1200);
  };

  const handlePrint = () => window.print();

  const handleSaveQuote = async () => {
    if (!quote) return;
    setQuoteSaving(true);
    try {
      await saveQuote(projectId, quote);
      setQuoteSaved(true);
    } catch (err) {
      console.error('Failed to save quote:', err);
    } finally {
      setQuoteSaving(false);
    }
  };

  const totalFlat = sections.reduce((s, r) => s + r.flatArea, 0);
  const totalActual = sections.reduce((s, r) => s + r.actualArea, 0);

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 sm:py-8 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] animate-fade-in">
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
        className="touch-manipulation no-print flex items-center gap-2 min-h-[44px] -mx-1 px-2 text-slate-500 hover:text-slate-800 active:text-slate-900 text-sm font-medium mb-4 sm:mb-6 rounded-xl transition-colors"
      >
        <ArrowLeft size={18} className="shrink-0" aria-hidden />
        Back to analysis
      </button>

      {/* Page title */}
      <div className="mb-6 sm:mb-8 no-print">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">Generate Quote</h1>
        <p className="text-slate-500 text-sm sm:text-base mt-1.5 leading-relaxed">
          Select a roofing material and generate your itemized estimate
        </p>
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
          <button
            type="button"
            onClick={handleGenerate}
            className="btn-accent w-full justify-center text-base py-3.5 min-h-[52px] touch-manipulation"
          >
            {generating ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Calculating estimate…
              </>
            ) : (
              <>
                <DollarSign size={18} />
                Generate Quote
                <ChevronRight size={16} />
              </>
            )}
          </button>
        </div>
      )}

      {/* Quote Report */}
      {quote && (
        <div ref={reportRef}>
          {/* Actions bar */}
          <div className="no-print flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
            <div className="flex items-center gap-2 text-green-600 font-semibold text-sm sm:text-base shrink-0">
              <CheckCircle2 size={20} className="shrink-0" aria-hidden />
              Quote ready
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:justify-end">
              <button
                type="button"
                onClick={() => setQuote(null)}
                className="btn-secondary text-sm py-3 min-h-[48px] touch-manipulation w-full sm:w-auto justify-center"
              >
                <RotateCcw size={16} aria-hidden />
                Change material
              </button>
              <button
                type="button"
                onClick={handleSaveQuote}
                disabled={quoteSaving || quoteSaved}
                className="btn-secondary text-sm py-3 min-h-[48px] touch-manipulation w-full sm:w-auto justify-center disabled:opacity-60"
              >
                {quoteSaving ? (
                  <div className="w-4 h-4 border-2 border-slate-400/30 border-t-slate-600 rounded-full animate-spin" aria-hidden />
                ) : quoteSaved ? (
                  <CheckCircle2 size={16} className="text-green-500" aria-hidden />
                ) : (
                  <Save size={16} aria-hidden />
                )}
                {quoteSaved ? 'Saved' : 'Save quote'}
              </button>
              <button type="button" onClick={handlePrint} className="btn-primary text-sm py-3 min-h-[48px] touch-manipulation w-full sm:w-auto justify-center">
                <Printer size={16} aria-hidden />
                Print / PDF
              </button>
            </div>
          </div>

          {/* Report card */}
          <div className="card overflow-hidden" id="quote-report">
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

          {/* Bottom actions */}
          <div className="no-print flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 sm:mt-6">
            <button type="button" onClick={onRestart} className="btn-secondary w-full sm:w-auto justify-center min-h-[48px] touch-manipulation">
              <RotateCcw size={16} aria-hidden />
              Start new quote
            </button>
            <button type="button" onClick={handlePrint} className="btn-primary w-full sm:w-auto justify-center min-h-[48px] touch-manipulation">
              <Download size={16} aria-hidden />
              Download PDF
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
