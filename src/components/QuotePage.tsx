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
      onClick={onSelect}
      className={`relative w-full text-left rounded-2xl border-2 p-4 transition-all duration-200 ${
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
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-slate-500 hover:text-slate-700 text-sm font-medium mb-6 transition-colors no-print"
      >
        <ArrowLeft size={15} />
        Back to Analysis
      </button>

      {/* Page title */}
      <div className="mb-8 no-print">
        <h1 className="text-2xl font-bold text-slate-900">Generate Quote</h1>
        <p className="text-slate-500 mt-1">Select a roofing material and generate your itemized estimate</p>
      </div>

      {/* Measurement Summary */}
      <div className="card p-6 mb-6 no-print">
        <div className="flex items-center gap-2 mb-4">
          <Layers size={16} className="text-blue-600" />
          <h2 className="font-semibold text-slate-900">Measurement Summary</h2>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500 mb-4">
          <MapPin size={13} className="text-slate-400" />
          {address}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
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
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                      <span className="font-medium text-slate-800">{s.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-right text-slate-600">{formatArea(s.flatArea)}</td>
                  <td className="py-2 px-4 text-right text-slate-600">{s.pitch}</td>
                  <td className="py-2 pl-4 text-right font-semibold text-slate-800">{formatArea(s.actualArea)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 rounded-lg">
                <td className="py-2 pr-4 pl-2 font-bold text-slate-900 rounded-l-lg">Total</td>
                <td className="py-2 px-4 text-right font-bold text-slate-700">{formatArea(totalFlat)}</td>
                <td className="py-2 px-4" />
                <td className="py-2 pl-4 text-right font-bold text-slate-900 rounded-r-lg">{formatArea(totalActual)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Material Selection */}
      {!quote && (
        <div className="card p-6 mb-6 no-print">
          <div className="flex items-center gap-2 mb-4">
            <Building2 size={16} className="text-blue-600" />
            <h2 className="font-semibold text-slate-900">Select Roofing Material</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mb-6">
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
            onClick={handleGenerate}
            className="btn-accent w-full justify-center text-base py-3"
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
          <div className="flex items-center gap-3 mb-4 no-print">
            <div className="flex items-center gap-2 text-green-600 font-semibold">
              <CheckCircle2 size={18} />
              Quote Ready
            </div>
            <div className="flex-1" />
            <button
              onClick={() => setQuote(null)}
              className="btn-secondary text-sm py-2 px-4"
            >
              <RotateCcw size={14} />
              Change Material
            </button>
            <button
              onClick={handleSaveQuote}
              disabled={quoteSaving || quoteSaved}
              className="btn-secondary text-sm py-2 px-4 disabled:opacity-60"
            >
              {quoteSaving ? (
                <div className="w-3.5 h-3.5 border-2 border-slate-400/30 border-t-slate-600 rounded-full animate-spin" />
              ) : quoteSaved ? (
                <CheckCircle2 size={14} className="text-green-500" />
              ) : (
                <Save size={14} />
              )}
              {quoteSaved ? 'Saved to DB' : 'Save Quote'}
            </button>
            <button onClick={handlePrint} className="btn-primary text-sm py-2 px-4">
              <Printer size={14} />
              Print / Save PDF
            </button>
          </div>

          {/* Report card */}
          <div className="card overflow-hidden" id="quote-report">
            {/* Report header */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 px-8 py-7 text-white">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-7 h-7 bg-blue-500 rounded-lg flex items-center justify-center">
                      <span className="font-black text-sm">R</span>
                    </div>
                    <span className="font-bold text-lg">RoofIQ</span>
                  </div>
                  <h2 className="text-2xl font-black mb-1">Roofing Estimate</h2>
                  <p className="text-slate-400 text-sm">Professional Quote — Confidential</p>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-black text-white">{formatCurrency(quote.total)}</div>
                  <div className="text-slate-400 text-sm mt-1">Total Estimate</div>
                  <div className="mt-2 text-xs text-slate-500">
                    Generated {quote.generatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-8">
              {/* Property info */}
              <div className="mb-8 pb-8 border-b border-slate-100">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Property</h3>
                <div className="flex items-center gap-2 text-slate-700">
                  <MapPin size={15} className="text-slate-400" />
                  <span className="font-medium">{quote.address}</span>
                </div>
                <div className="grid grid-cols-3 gap-4 mt-4">
                  {[
                    { label: 'Roof Sections', value: sections.length.toString() },
                    { label: 'Total Roof Area', value: formatArea(quote.totalActualArea) },
                    { label: 'Roofing Squares', value: `${quote.orderSquares} squares` },
                  ].map(item => (
                    <div key={item.label} className="bg-slate-50 rounded-xl p-3">
                      <div className="text-xs text-slate-400 mb-0.5">{item.label}</div>
                      <div className="font-bold text-slate-900">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Material */}
              <div className="mb-8 pb-8 border-b border-slate-100">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Selected Material</h3>
                <div className="flex items-center gap-3 bg-blue-50 rounded-xl p-4">
                  <span className="text-3xl">{quote.material.icon}</span>
                  <div>
                    <div className="font-bold text-slate-900">{quote.material.name}</div>
                    <div className="text-sm text-slate-500">{quote.material.description}</div>
                    <div className="text-xs text-blue-600 font-semibold mt-1">Warranty: {quote.material.warranty} · Lifespan: {quote.material.lifespan}</div>
                  </div>
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="mb-8">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">Cost Breakdown</h3>
                <div className="space-y-2">
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
                    <div key={row.label} className="flex items-center justify-between py-2.5 border-b border-slate-50">
                      <div>
                        <div className="font-medium text-slate-800 text-sm">{row.label}</div>
                        {row.sublabel && <div className="text-xs text-slate-400">{row.sublabel}</div>}
                      </div>
                      <div className="font-semibold text-slate-800">{formatCurrency(row.amount)}</div>
                    </div>
                  ))}
                </div>

                {/* Subtotals */}
                <div className="mt-4 space-y-2">
                  <div className="flex justify-between text-sm text-slate-600 py-1">
                    <span>Subtotal</span>
                    <span className="font-semibold">{formatCurrency(quote.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 py-1">
                    <span>Tax (8%)</span>
                    <span className="font-semibold">{formatCurrency(quote.tax)}</span>
                  </div>
                  <div className="flex justify-between bg-slate-900 text-white rounded-xl px-4 py-3 mt-2">
                    <span className="font-bold text-base">Total Estimate</span>
                    <span className="font-black text-xl">{formatCurrency(quote.total)}</span>
                  </div>
                </div>
              </div>

              {/* Waste factor note */}
              <div className="flex gap-2 bg-amber-50 border border-amber-100 rounded-xl p-4 mb-8 text-sm text-amber-800">
                <Info size={15} className="flex-shrink-0 mt-0.5 text-amber-500" />
                <div>
                  <span className="font-semibold">Order quantity includes 12% waste factor</span> for cuts, overlaps, and
                  starter courses. Total roof area measured: {formatArea(quote.totalActualArea)} ·
                  Order area: {formatArea(quote.totalActualArea * 1.12)}.
                </div>
              </div>

              {/* Contact footer */}
              <div className="bg-slate-50 rounded-2xl p-6 text-center border border-slate-100">
                <p className="text-slate-500 text-sm mb-3">
                  Questions about this estimate? Contact our roofing experts.
                </p>
                <div className="flex items-center justify-center gap-6 text-sm">
                  <a href="tel:+15551234567" className="flex items-center gap-1.5 text-blue-600 hover:text-blue-700 font-medium">
                    <Phone size={13} />
                    (555) 123-4567
                  </a>
                  <a href="mailto:quotes@roofiq.com" className="flex items-center gap-1.5 text-blue-600 hover:text-blue-700 font-medium">
                    <Mail size={13} />
                    quotes@roofiq.com
                  </a>
                </div>
                <p className="text-xs text-slate-400 mt-4">
                  This estimate is based on satellite measurements and is subject to an on-site inspection.
                  Final pricing may vary ±10% based on actual conditions found during inspection.
                </p>
              </div>
            </div>
          </div>

          {/* Bottom actions */}
          <div className="flex items-center justify-between mt-6 no-print">
            <button onClick={onRestart} className="btn-secondary">
              <RotateCcw size={15} />
              Start New Quote
            </button>
            <div className="flex gap-3">
              <button onClick={handlePrint} className="btn-primary">
                <Download size={15} />
                Download PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
