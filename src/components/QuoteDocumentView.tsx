import { forwardRef } from 'react';
import type { QuoteBranding, QuoteClient } from '../utils/quoteBranding';

interface LineItem { label: string; amount: number }

interface Props {
  branding: QuoteBranding;
  client: QuoteClient;
  quoteNo: string;
  quoteDate: string;
  validDays: number;
  materialName: string;
  orderSquares: number;
  totalSqFt: number;
  wastePct: number;
  matPricePerSq: number;
  laborPricePerSq: number;
  materialCost: number;
  laborCost: number;
  lineItems: LineItem[];
  subtotal: number;
  taxRate: number;
  taxAmt: number;
  total: number;
  notes: string;
}

const QuoteDocumentView = forwardRef<HTMLDivElement, Props>(function QuoteDocumentView(
  {
    branding, client, quoteNo, quoteDate, validDays,
    materialName, orderSquares, totalSqFt, wastePct,
    matPricePerSq, laborPricePerSq,
    materialCost, laborCost, lineItems,
    subtotal, taxRate, taxAmt, total, notes,
  },
  ref,
) {
  const accent = branding.accentColor || '#1e40af';
  const fmt = (n: number) => '$' + Math.round(n).toLocaleString();

  return (
    <div
      ref={ref}
      className="bg-white text-slate-800 font-sans text-sm"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ borderTop: `5px solid ${accent}` }} className="px-8 pt-6 pb-5">
        <div className="flex items-start justify-between gap-6">
          {/* Left: logo + company */}
          <div className="flex items-start gap-4">
            {branding.logoDataUrl ? (
              <img src={branding.logoDataUrl} alt="Logo" className="h-14 w-auto object-contain shrink-0" />
            ) : (
              <div
                className="h-14 w-14 rounded-lg flex items-center justify-center text-white text-xl font-bold shrink-0"
                style={{ backgroundColor: accent }}
              >
                {(branding.companyName || 'C').charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="text-lg font-bold text-slate-900 leading-tight">
                {branding.companyName || 'Your Company Name'}
              </div>
              {branding.tagline && <div className="text-xs text-slate-500 mt-0.5">{branding.tagline}</div>}
              <div className="mt-1.5 text-xs text-slate-500 space-y-0.5">
                {branding.address && <div>{branding.address}</div>}
                {branding.city && <div>{branding.city}</div>}
                <div className="flex flex-wrap gap-x-3">
                  {branding.phone && <span>{branding.phone}</span>}
                  {branding.email && <span>{branding.email}</span>}
                  {branding.website && <span>{branding.website}</span>}
                </div>
                {branding.licenseNo && <div>License: {branding.licenseNo}</div>}
              </div>
            </div>
          </div>

          {/* Right: quote meta */}
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold" style={{ color: accent }}>QUOTE</div>
            <table className="mt-2 text-xs text-right ml-auto">
              <tbody>
                <tr>
                  <td className="text-slate-500 pr-3 py-0.5">Quote #</td>
                  <td className="font-semibold text-slate-800">{quoteNo}</td>
                </tr>
                <tr>
                  <td className="text-slate-500 pr-3 py-0.5">Date</td>
                  <td className="font-semibold text-slate-800">{quoteDate}</td>
                </tr>
                <tr>
                  <td className="text-slate-500 pr-3 py-0.5">Valid for</td>
                  <td className="font-semibold text-slate-800">{validDays} days</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Client block ─────────────────────────────────────────────────── */}
      <div className="px-8 py-4 border-t border-slate-100">
        <div
          className="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded mb-2"
          style={{ backgroundColor: `${accent}18`, color: accent }}
        >
          Prepared For
        </div>
        <div className="text-sm font-semibold text-slate-800">{client.name || '—'}</div>
        <div className="text-xs text-slate-500 mt-0.5 space-y-0.5">
          {client.address && <div>{client.address}</div>}
          {client.city && <div>{client.city}</div>}
          <div className="flex flex-wrap gap-x-3">
            {client.phone && <span>{client.phone}</span>}
            {client.email && <span>{client.email}</span>}
          </div>
        </div>
      </div>

      {/* ── Scope / Notes ─────────────────────────────────────────────────── */}
      {notes && (
        <div className="px-8 py-3 border-t border-slate-100">
          <div
            className="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded mb-2"
            style={{ backgroundColor: `${accent}18`, color: accent }}
          >
            Scope of Work / Notes
          </div>
          <p className="text-xs text-slate-600 whitespace-pre-line">{notes}</p>
        </div>
      )}

      {/* ── Cost breakdown ───────────────────────────────────────────────── */}
      <div className="px-8 py-4 border-t border-slate-100">
        <div
          className="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded mb-3"
          style={{ backgroundColor: `${accent}18`, color: accent }}
        >
          Cost Breakdown — {materialName}
        </div>
        <div className="text-[10px] text-slate-400 mb-2">
          {orderSquares} sq ordered · {totalSqFt.toLocaleString()} sq ft + {wastePct}% waste ·
          Material ${matPricePerSq}/sq · Labor ${laborPricePerSq}/sq
        </div>

        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ backgroundColor: `${accent}12` }}>
              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200">Description</th>
              <th className="text-right px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 w-32">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-slate-50/60">
              <td className="px-3 py-2 border border-slate-200 font-medium">Material — {materialName}</td>
              <td className="px-3 py-2 border border-slate-200 text-right font-medium">{fmt(materialCost)}</td>
            </tr>
            <tr>
              <td className="px-3 py-2 border border-slate-200 text-slate-600">Labor</td>
              <td className="px-3 py-2 border border-slate-200 text-right">{fmt(laborCost)}</td>
            </tr>
            {lineItems.map((item, i) => (
              <tr key={i} className={i % 2 === 0 ? '' : 'bg-slate-50/40'}>
                <td className="px-3 py-2 border border-slate-200 text-slate-600">{item.label}</td>
                <td className="px-3 py-2 border border-slate-200 text-right">{fmt(item.amount)}</td>
              </tr>
            ))}
            <tr className="bg-slate-100">
              <td className="px-3 py-2 border border-slate-200 font-semibold">Subtotal</td>
              <td className="px-3 py-2 border border-slate-200 text-right font-semibold">{fmt(subtotal)}</td>
            </tr>
            <tr>
              <td className="px-3 py-2 border border-slate-200 text-slate-600">Tax ({taxRate}%)</td>
              <td className="px-3 py-2 border border-slate-200 text-right">{fmt(taxAmt)}</td>
            </tr>
            <tr style={{ backgroundColor: accent }}>
              <td className="px-3 py-2.5 border border-slate-200 font-bold text-white text-base">Total Estimate</td>
              <td className="px-3 py-2.5 border border-slate-200 text-right font-bold text-white text-base">{fmt(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Acceptance / Signature ───────────────────────────────────────── */}
      <div className="px-8 py-5 border-t border-slate-100">
        <div
          className="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded mb-4"
          style={{ backgroundColor: `${accent}18`, color: accent }}
        >
          Acceptance
        </div>
        <div className="grid grid-cols-2 gap-8">
          <div>
            <div className="text-xs text-slate-500 mb-1">Authorized by — {branding.companyName || 'Company'}</div>
            {branding.signatureDataUrl ? (
              <img src={branding.signatureDataUrl} alt="Signature" className="h-12 object-contain" />
            ) : (
              <div className="h-12 border-b-2 border-slate-300" />
            )}
            <div className="text-xs text-slate-400 mt-1">Signature &amp; Date</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">Accepted by — {client.name || 'Client'}</div>
            <div className="h-12 border-b-2 border-slate-300" />
            <div className="text-xs text-slate-400 mt-1">Signature &amp; Date</div>
          </div>
        </div>
      </div>

      {/* ── Terms ────────────────────────────────────────────────────────── */}
      {branding.terms && (
        <div className="px-8 py-4 border-t border-slate-100 bg-slate-50/60">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Terms &amp; Conditions</div>
          <p className="text-[10px] text-slate-500 leading-relaxed whitespace-pre-line">{branding.terms}</p>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div
        className="px-8 py-2 text-center text-[10px] text-white"
        style={{ backgroundColor: accent }}
      >
        {[branding.companyName, branding.phone, branding.email, branding.website]
          .filter(Boolean)
          .join('  ·  ')}
      </div>
    </div>
  );
});

export default QuoteDocumentView;
