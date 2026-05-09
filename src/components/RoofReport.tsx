import { useRef } from 'react';
import type { RoofSection, Coordinates, QuoteData } from '../types';
import { computeRoofMeasurements, formatFt } from '../utils/measurements';
import { formatArea, formatCurrency } from '../utils/roofCalculations';
import RoofDiagram from './RoofDiagram';
import { X, Printer } from 'lucide-react';

interface RoofReportProps {
  address: string;
  coordinates: Coordinates;
  sections: Omit<RoofSection, 'polygon'>[];
  mapsApiKey: string;
  quoteData?: QuoteData | null;
  aiCondition?: string | null;
  aiScore?: number | null;
  aiRecommendation?: string | null;
  onClose: () => void;
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <td className={`px-4 py-2.5 border-b border-slate-100 ${accent ? 'text-blue-700 font-semibold' : 'text-slate-800'} text-sm`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">{label}</div>
      {value}
    </td>
  );
}

export default function RoofReport({
  address,
  coordinates,
  sections,
  mapsApiKey,
  quoteData,
  aiCondition,
  aiScore,
  aiRecommendation,
  onClose,
}: RoofReportProps) {
  const reportRef = useRef<HTMLDivElement>(null);
  const measurements = computeRoofMeasurements(sections);

  const aerialUrl = mapsApiKey
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${coordinates.lat},${coordinates.lng}&zoom=20&size=640x400&maptype=satellite&scale=2&key=${mapsApiKey}`
    : null;

  const generatedAt = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 flex flex-col overflow-hidden">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden shrink-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 shadow-sm">
        <button
          onClick={onClose}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-900 text-sm font-medium px-3 py-2 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <X size={16} />
          Close
        </button>
        <div className="flex-1 text-center">
          <span className="text-sm font-semibold text-slate-700">Roof Measurement Report</span>
        </div>
        <button
          onClick={handlePrint}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          <Printer size={15} />
          Print / Save PDF
        </button>
      </div>

      {/* Scrollable preview area — hidden on print (print uses @media print styles) */}
      <div className="flex-1 overflow-y-auto bg-slate-200 py-8 print:p-0 print:overflow-visible print:bg-white">
        <div
          ref={reportRef}
          className="mx-auto max-w-[816px] space-y-0 print:max-w-none print:space-y-0"
          id="roof-report"
        >

          {/* ── PAGE 1: Cover ─────────────────────────────────────── */}
          <div className="bg-white shadow-xl print:shadow-none print:break-after-page">
            {/* Header bar */}
            <div className="bg-blue-700 px-10 py-6 flex items-center justify-between">
              <div>
                <div className="text-white/60 text-xs uppercase tracking-widest mb-1 font-medium">Roof Measurement Report</div>
                <div className="text-white text-2xl font-bold">RoofIQ Pro</div>
              </div>
              <div className="text-right text-white/80 text-xs">
                <div>{generatedAt}</div>
                <div className="mt-1 text-white/50">Powered by Google Solar + AI</div>
              </div>
            </div>

            {/* Aerial imagery */}
            {aerialUrl && (
              <div className="overflow-hidden" style={{ height: 320 }}>
                <img
                  src={aerialUrl}
                  alt="Aerial satellite view"
                  className="w-full h-full object-cover"
                  crossOrigin="anonymous"
                />
              </div>
            )}

            <div className="px-10 py-8">
              <div className="text-xs uppercase tracking-widest text-blue-600 font-semibold mb-1">Property Address</div>
              <div className="text-xl font-bold text-slate-900 mb-6">{address}</div>

              {/* Key metrics grid */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                {[
                  { label: 'Total Roof Area', value: formatArea(measurements.totalActualAreaSqFt) },
                  { label: 'Roof Facets', value: String(measurements.facets) },
                  { label: 'Predominant Pitch', value: measurements.predominantPitch },
                  { label: 'Material Squares', value: `${measurements.totalSquares} sq` },
                  { label: 'Total Perimeter', value: formatFt(measurements.totalPerimeterFt) },
                  { label: 'Plan Area', value: formatArea(measurements.totalFlatAreaSqFt) },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">{label}</div>
                    <div className="text-lg font-bold text-blue-700">{value}</div>
                  </div>
                ))}
              </div>

              {aiCondition && (
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                  <div className="text-[10px] uppercase tracking-wide text-purple-500 mb-1">AI Roof Condition Assessment</div>
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-purple-700">{aiCondition}</span>
                    {aiScore != null && (
                      <span className="text-sm text-purple-500">Score: {aiScore}/10</span>
                    )}
                  </div>
                  {aiRecommendation && (
                    <p className="mt-1 text-sm text-purple-700 italic">"{aiRecommendation}"</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── PAGE 2: Diagram + Measurements ───────────────────── */}
          <div className="bg-white shadow-xl print:shadow-none print:break-after-page">
            <div className="px-10 py-6 border-b border-slate-100">
              <div className="text-[10px] uppercase tracking-widest text-blue-600 font-semibold mb-0.5">Roof Plan Diagram</div>
              <div className="text-slate-400 text-xs">{address}</div>
            </div>

            <div className="px-10 py-6">
              <div className="flex justify-center mb-6">
                <RoofDiagram
                  sections={sections}
                  width={680}
                  height={380}
                  style="plan"
                />
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-3">
                {sections.map(s => (
                  <div key={s.id} className="flex items-center gap-1.5 text-xs text-slate-600">
                    <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
                    {s.name} — {s.pitch} pitch
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── PAGE 3: Measurements Table ────────────────────────── */}
          <div className="bg-white shadow-xl print:shadow-none print:break-after-page">
            <div className="px-10 py-6 border-b border-slate-100">
              <div className="text-[10px] uppercase tracking-widest text-blue-600 font-semibold mb-0.5">Area Measurement Report</div>
              <div className="text-slate-400 text-xs">{address}</div>
            </div>

            <div className="px-10 py-6">
              {/* Summary row */}
              <div className="grid grid-cols-4 gap-3 mb-6">
                {[
                  { label: 'Total Low Pitch (≤4/12)', value: formatArea(sections.filter(s => parseFloat(s.pitch) <= 4).reduce((a, s) => a + s.actualArea, 0)) },
                  { label: 'Total Steep Pitch (>4/12)', value: formatArea(sections.filter(s => parseFloat(s.pitch) > 4).reduce((a, s) => a + s.actualArea, 0)) },
                  { label: 'Predominant Pitch', value: measurements.predominantPitch },
                  { label: 'Total Area', value: formatArea(measurements.totalActualAreaSqFt) },
                ].map(({ label, value }) => (
                  <div key={label} className="text-center border border-slate-100 rounded-lg p-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">{label}</div>
                    <div className="text-sm font-bold text-blue-700">{value}</div>
                  </div>
                ))}
              </div>

              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Section</th>
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Plan Area</th>
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Pitch</th>
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Actual Area</th>
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Perimeter</th>
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Squares</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((s, idx) => {
                    const m = measurements.sections[idx];
                    return (
                      <tr key={s.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 border-b border-slate-100">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
                            <span className="text-sm font-medium text-slate-800">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 border-b border-slate-100 text-sm text-slate-700">{formatArea(s.flatArea)}</td>
                        <td className="px-4 py-2.5 border-b border-slate-100 text-sm text-blue-700 font-semibold">{s.pitch}</td>
                        <td className="px-4 py-2.5 border-b border-slate-100 text-sm text-slate-700">{formatArea(s.actualArea)}</td>
                        <td className="px-4 py-2.5 border-b border-slate-100 text-sm text-slate-700">{m ? formatFt(m.perimeterFt) : '—'}</td>
                        <td className="px-4 py-2.5 border-b border-slate-100 text-sm font-semibold text-slate-800">{Math.ceil((s.actualArea * 1.12) / 100)} sq</td>
                      </tr>
                    );
                  })}
                  <tr className="bg-blue-50 font-semibold">
                    <td className="px-4 py-3 text-sm text-blue-900">Total</td>
                    <td className="px-4 py-3 text-sm text-blue-700">{formatArea(measurements.totalFlatAreaSqFt)}</td>
                    <td className="px-4 py-3 text-sm text-blue-700">{measurements.predominantPitch}</td>
                    <td className="px-4 py-3 text-sm text-blue-700">{formatArea(measurements.totalActualAreaSqFt)}</td>
                    <td className="px-4 py-3 text-sm text-blue-700">{formatFt(measurements.totalPerimeterFt)}</td>
                    <td className="px-4 py-3 text-sm text-blue-900 font-bold">{measurements.totalSquares} sq</td>
                  </tr>
                </tbody>
              </table>

              {/* Waste factor note */}
              <div className="mt-4 flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 text-xs text-amber-800">
                <span className="font-semibold shrink-0">Note:</span>
                <span>Squares include 12% waste factor for ordering. Perimeter measurements are calculated from drawn polygon boundaries using geodesic distance.</span>
              </div>
            </div>
          </div>

          {/* ── PAGE 4: Pitch & Direction Report ─────────────────── */}
          <div className="bg-white shadow-xl print:shadow-none print:break-after-page">
            <div className="px-10 py-6 border-b border-slate-100">
              <div className="text-[10px] uppercase tracking-widest text-blue-600 font-semibold mb-0.5">Pitch &amp; Direction Measurement Report</div>
              <div className="text-slate-400 text-xs">{address}</div>
            </div>

            <div className="px-10 py-6">
              <div className="flex gap-8">
                {/* Diagram on left */}
                <div className="shrink-0">
                  <RoofDiagram
                    sections={sections}
                    width={320}
                    height={280}
                    style="blueprint"
                  />
                </div>

                {/* Pitch table on right */}
                <div className="flex-1">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Section</th>
                        <th className="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Pitch</th>
                        <th className="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Multiplier</th>
                        <th className="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">Area</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sections.map(s => (
                        <tr key={s.id}>
                          <td className="px-3 py-2.5 border-b border-slate-100">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
                              <span className="text-xs text-slate-800">{s.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 border-b border-slate-100 text-xs font-bold text-blue-700">{s.pitch}</td>
                          <td className="px-3 py-2.5 border-b border-slate-100 text-xs text-slate-600">×{s.pitchMultiplier.toFixed(3)}</td>
                          <td className="px-3 py-2.5 border-b border-slate-100 text-xs text-slate-700">{formatArea(s.actualArea)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Pitch breakdown by type */}
                  <div className="mt-4 space-y-2">
                    {['2/12', '3/12', '4/12', '5/12', '6/12', '7/12', '8/12', '9/12', '10/12', '12/12'].map(pitch => {
                      const matching = sections.filter(s => s.pitch === pitch);
                      if (matching.length === 0) return null;
                      const area = matching.reduce((a, s) => a + s.actualArea, 0);
                      const pct = Math.round((area / measurements.totalActualAreaSqFt) * 100);
                      return (
                        <div key={pitch} className="flex items-center gap-2 text-xs">
                          <span className="w-12 text-right font-mono font-semibold text-blue-700">{pitch}</span>
                          <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden">
                            <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-16 text-slate-500">{formatArea(area)}</span>
                          <span className="w-8 text-slate-400">{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── PAGE 5: Material Estimate ─────────────────────────── */}
          {quoteData && (
            <div className="bg-white shadow-xl print:shadow-none print:break-after-page">
              <div className="px-10 py-6 border-b border-slate-100">
                <div className="text-[10px] uppercase tracking-widest text-blue-600 font-semibold mb-0.5">Material Estimate</div>
                <div className="text-slate-400 text-xs">{address}</div>
              </div>
              <div className="px-10 py-6">
                <div className="grid grid-cols-2 gap-6 mb-6">
                  <div>
                    <div className="text-xs font-semibold text-slate-600 mb-3">Selected Material</div>
                    <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xl">{quoteData.material.icon}</span>
                        <span className="font-bold text-slate-800">{quoteData.material.name}</span>
                      </div>
                      <div className="text-xs text-slate-500">{quoteData.material.description}</div>
                      <div className="mt-2 text-xs text-slate-600">
                        Warranty: <span className="font-semibold">{quoteData.material.warranty}</span> ·
                        Lifespan: <span className="font-semibold">{quoteData.material.lifespan}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-600 mb-3">Cost Summary</div>
                    <div className="space-y-1.5">
                      {[
                        { label: 'Material Cost', value: formatCurrency(quoteData.materialCost) },
                        { label: 'Labor Cost', value: formatCurrency(quoteData.laborCost) },
                        ...quoteData.additionalCosts.map(c => ({ label: c.label, value: formatCurrency(c.amount) })),
                        { label: 'Subtotal', value: formatCurrency(quoteData.subtotal) },
                        { label: `Tax (${(quoteData.tax / quoteData.subtotal * 100).toFixed(0)}%)`, value: formatCurrency(quoteData.tax) },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between text-sm text-slate-700 py-1 border-b border-slate-50">
                          <span>{label}</span>
                          <span className="font-medium">{value}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-base font-bold text-blue-700 pt-2">
                        <span>Total Estimate</span>
                        <span>{formatCurrency(quoteData.total)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-slate-50">
                      {['Product', 'Unit', 'Roof Area', 'Ridge Cap', 'Waste 10%', 'Order Qty'].map(h => (
                        <th key={h} className="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { product: quoteData.material.name, unit: 'bundle', roofArea: `${quoteData.orderSquares * 3}`, ridgeCap: Math.ceil(measurements.totalPerimeterFt / 35).toString(), waste10: Math.ceil(quoteData.orderSquares * 3 * 0.1).toString(), order: `${Math.ceil(quoteData.orderSquares * 3 * 1.1)}` },
                      { product: 'Synthetic Underlayment', unit: 'roll', roofArea: Math.ceil(quoteData.totalActualArea / 1000).toString(), ridgeCap: '0', waste10: '1', order: (Math.ceil(quoteData.totalActualArea / 1000) + 1).toString() },
                      { product: 'Drip Edge', unit: 'piece', roofArea: Math.ceil(measurements.totalPerimeterFt / 10).toString(), ridgeCap: '0', waste10: Math.ceil(measurements.totalPerimeterFt / 100).toString(), order: Math.ceil(measurements.totalPerimeterFt / 9).toString() },
                      { product: 'Cap Nails', unit: 'box', roofArea: Math.ceil(quoteData.orderSquares / 5).toString(), ridgeCap: '0', waste10: '1', order: (Math.ceil(quoteData.orderSquares / 5) + 1).toString() },
                    ].map(row => (
                      <tr key={row.product}>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs font-medium text-slate-800">{row.product}</td>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500">{row.unit}</td>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs text-blue-700">{row.roofArea}</td>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500">{row.ridgeCap}</td>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500">{row.waste10}</td>
                        <td className="px-3 py-2 border-b border-slate-100 text-xs font-bold text-slate-800">{row.order}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="bg-white shadow-xl print:shadow-none px-10 py-6 flex items-center justify-between text-xs text-slate-400">
            <span>RoofIQ Pro · Roof Measurement Report</span>
            <span>Generated {generatedAt} · Measurements computed from satellite imagery</span>
          </div>

        </div>
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden; }
          #roof-report, #roof-report * { visibility: visible; }
          #roof-report { position: fixed; left: 0; top: 0; width: 100%; }
          .print\\:break-after-page { break-after: page; page-break-after: always; }
          .print\\:shadow-none { box-shadow: none !important; }
        }
      `}</style>
    </div>
  );
}
