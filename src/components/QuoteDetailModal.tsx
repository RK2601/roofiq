import { useEffect, useState } from 'react';
import {
  X, MapPin, Info, Phone, Mail, Pencil, Check,
  Plus, Trash2, Printer, Loader2, CheckCircle2, FileText,
} from 'lucide-react';
import { getQuoteDetails, updateQuote } from '../utils/db';
import { MATERIALS, formatCurrency } from '../utils/roofCalculations';

interface Props {
  quoteId: string;
  onClose: () => void;
}

interface QuoteDetail {
  id: string;
  material_id: string;
  material_name: string;
  total_squares: number;
  material_cost: number;
  labor_cost: number;
  additional_costs: Array<{ label: string; amount: number }>;
  subtotal: number;
  tax: number;
  total: number;
  generated_at: string;
  address: string | null;
  project_id: string | null;
}

interface EditState {
  material_cost: number;
  labor_cost: number;
  additional_costs: Array<{ label: string; amount: number }>;
  tax_rate: number; // percentage e.g. 8
}

export default function QuoteDetailModal({ quoteId, onClose }: Props) {
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    getQuoteDetails(quoteId)
      .then(setQuote)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [quoteId]);

  const startEdit = () => {
    if (!quote) return;
    setEditState({
      material_cost: quote.material_cost,
      labor_cost: quote.labor_cost,
      additional_costs: quote.additional_costs.map(c => ({ ...c })),
      tax_rate: quote.subtotal > 0 ? Math.round((quote.tax / quote.subtotal) * 100) : 8,
    });
    setEditing(true);
    setSaved(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditState(null);
  };

  // Live-computed totals from edit state
  const computedSubtotal = editState
    ? editState.material_cost + editState.labor_cost + editState.additional_costs.reduce((s, c) => s + (c.amount || 0), 0)
    : quote?.subtotal ?? 0;
  const computedTax = editState
    ? Math.round(computedSubtotal * (editState.tax_rate / 100))
    : quote?.tax ?? 0;
  const computedTotal = computedSubtotal + computedTax;

  const saveEdit = async () => {
    if (!quote || !editState) return;
    setSaving(true);
    try {
      const updates = {
        material_cost: editState.material_cost,
        labor_cost: editState.labor_cost,
        additional_costs: editState.additional_costs,
        subtotal: computedSubtotal,
        tax: computedTax,
        total: computedTotal,
      };
      await updateQuote(quoteId, updates);
      setQuote(prev => prev ? { ...prev, ...updates } : prev);
      setEditing(false);
      setEditState(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save quote:', err);
    } finally {
      setSaving(false);
    }
  };

  const updateAdditional = (idx: number, field: 'label' | 'amount', value: string) => {
    setEditState(prev => {
      if (!prev) return prev;
      const costs = prev.additional_costs.map((c, i) =>
        i === idx ? { ...c, [field]: field === 'amount' ? parseFloat(value) || 0 : value } : c
      );
      return { ...prev, additional_costs: costs };
    });
  };

  const addLineItem = () => {
    setEditState(prev => prev ? { ...prev, additional_costs: [...prev.additional_costs, { label: 'New Item', amount: 0 }] } : prev);
  };

  const removeLineItem = (idx: number) => {
    setEditState(prev => prev ? { ...prev, additional_costs: prev.additional_costs.filter((_, i) => i !== idx) } : prev);
  };

  const material = MATERIALS.find(m => m.id === quote?.material_id);

  // Display values (edit state takes priority)
  const displayMaterialCost = editState ? editState.material_cost : quote?.material_cost ?? 0;
  const displayLaborCost = editState ? editState.labor_cost : quote?.labor_cost ?? 0;
  const displayAdditional = editState ? editState.additional_costs : (quote?.additional_costs ?? []);
  const displaySubtotal = editState ? computedSubtotal : (quote?.subtotal ?? 0);
  const displayTax = editState ? computedTax : (quote?.tax ?? 0);
  const displayTotal = editState ? computedTotal : (quote?.total ?? 0);
  const displayTaxRate = editState ? editState.tax_rate : (quote?.subtotal ? Math.round((quote.tax / quote.subtotal) * 100) : 8);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm" onClick={onClose} />

      <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-slate-100 z-50 shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
        {/* Top action bar */}
        <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-2 text-blue-600 text-xs font-semibold uppercase tracking-wider">
            <FileText size={13} />
            Quote Detail
            {saved && (
              <span className="ml-2 flex items-center gap-1 text-green-600 normal-case">
                <CheckCircle2 size={13} /> Saved
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!loading && !editing && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Pencil size={12} /> Edit Quote
              </button>
            )}
            {editing && (
              <>
                <button
                  onClick={cancelEdit}
                  className="text-xs font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-1.5 rounded-lg transition-colors"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </>
            )}
            {!loading && (
              <button
                onClick={() => window.print()}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                title="Print / Save PDF"
              >
                <Printer size={16} />
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 space-y-4">
              {[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded-2xl animate-pulse" />)}
            </div>
          ) : !quote ? (
            <div className="p-12 text-center text-slate-400">Quote not found.</div>
          ) : (
            <div className="p-6">
              {/* Report card — matches QuotePage exactly */}
              <div className="bg-white rounded-2xl shadow-sm overflow-hidden border border-slate-200">

                {/* Dark header */}
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
                      <div className="text-3xl font-black text-white">{formatCurrency(displayTotal)}</div>
                      <div className="text-slate-400 text-sm mt-1">Total Estimate</div>
                      <div className="text-xs text-slate-500 mt-1">
                        Generated {new Date(quote.generated_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-8 space-y-8">
                  {/* Property */}
                  <div className="pb-8 border-b border-slate-100">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Property</h3>
                    <div className="flex items-center gap-2 text-slate-700 mb-4">
                      <MapPin size={15} className="text-slate-400" />
                      <span className="font-medium">{quote.address ?? 'No address'}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      {[
                        { label: 'Total Squares', value: `${quote.total_squares} squares` },
                        { label: 'Material', value: quote.material_name },
                        { label: 'Date', value: new Date(quote.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                      ].map(item => (
                        <div key={item.label} className="bg-slate-50 rounded-xl p-3">
                          <div className="text-xs text-slate-400 mb-0.5">{item.label}</div>
                          <div className="font-bold text-slate-900 text-sm">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Material */}
                  <div className="pb-8 border-b border-slate-100">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Selected Material</h3>
                    <div className="flex items-center gap-3 bg-blue-50 rounded-xl p-4">
                      <span className="text-3xl">{material?.icon ?? '🏠'}</span>
                      <div>
                        <div className="font-bold text-slate-900">{quote.material_name}</div>
                        <div className="text-sm text-slate-500">{material?.description ?? ''}</div>
                        {material && (
                          <div className="text-xs text-blue-600 font-semibold mt-1">
                            Warranty: {material.warranty} · Lifespan: {material.lifespan}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Cost Breakdown */}
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Cost Breakdown</h3>
                      {editing && (
                        <span className="text-xs text-blue-500 font-medium">Editing — changes apply live</span>
                      )}
                    </div>

                    <div className="space-y-1">
                      {/* Material cost row */}
                      <div className="flex items-center justify-between py-2.5 border-b border-slate-50">
                        <div>
                          <div className="font-medium text-slate-800 text-sm">Materials ({quote.material_name})</div>
                          <div className="text-xs text-slate-400">{quote.total_squares} squares × {formatCurrency(displayMaterialCost / quote.total_squares)}/sq</div>
                        </div>
                        {editing ? (
                          <input
                            type="number"
                            value={editState!.material_cost}
                            onChange={e => setEditState(prev => prev ? { ...prev, material_cost: parseFloat(e.target.value) || 0 } : prev)}
                            className="w-28 text-right font-semibold text-slate-800 border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                          />
                        ) : (
                          <div className="font-semibold text-slate-800">{formatCurrency(displayMaterialCost)}</div>
                        )}
                      </div>

                      {/* Labor cost row */}
                      <div className="flex items-center justify-between py-2.5 border-b border-slate-50">
                        <div>
                          <div className="font-medium text-slate-800 text-sm">Labor & Installation</div>
                          <div className="text-xs text-slate-400">{quote.total_squares} squares × {formatCurrency(displayLaborCost / quote.total_squares)}/sq</div>
                        </div>
                        {editing ? (
                          <input
                            type="number"
                            value={editState!.labor_cost}
                            onChange={e => setEditState(prev => prev ? { ...prev, labor_cost: parseFloat(e.target.value) || 0 } : prev)}
                            className="w-28 text-right font-semibold text-slate-800 border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                          />
                        ) : (
                          <div className="font-semibold text-slate-800">{formatCurrency(displayLaborCost)}</div>
                        )}
                      </div>

                      {/* Additional costs */}
                      {displayAdditional.map((cost, idx) => (
                        <div key={idx} className="flex items-center justify-between py-2.5 border-b border-slate-50 gap-3">
                          {editing ? (
                            <>
                              <input
                                type="text"
                                value={editState!.additional_costs[idx].label}
                                onChange={e => updateAdditional(idx, 'label', e.target.value)}
                                className="flex-1 font-medium text-slate-800 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200"
                              />
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  value={editState!.additional_costs[idx].amount}
                                  onChange={e => updateAdditional(idx, 'amount', e.target.value)}
                                  className="w-28 text-right font-semibold text-slate-800 border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                                />
                                <button onClick={() => removeLineItem(idx)} className="text-slate-300 hover:text-red-400 transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="font-medium text-slate-800 text-sm">{cost.label}</div>
                              <div className="font-semibold text-slate-800">{formatCurrency(cost.amount)}</div>
                            </>
                          )}
                        </div>
                      ))}

                      {/* Add line item button (edit mode) */}
                      {editing && (
                        <button
                          onClick={addLineItem}
                          className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-700 font-medium py-2 transition-colors"
                        >
                          <Plus size={13} /> Add Line Item
                        </button>
                      )}
                    </div>

                    {/* Subtotal / Tax / Total */}
                    <div className="mt-4 space-y-2">
                      <div className="flex justify-between text-sm text-slate-600 py-1">
                        <span>Subtotal</span>
                        <span className="font-semibold">{formatCurrency(displaySubtotal)}</span>
                      </div>
                      <div className="flex justify-between text-sm text-slate-600 py-1 items-center">
                        <span className="flex items-center gap-2">
                          Tax
                          {editing ? (
                            <span className="flex items-center gap-1">
                              <input
                                type="number"
                                value={editState!.tax_rate}
                                onChange={e => setEditState(prev => prev ? { ...prev, tax_rate: parseFloat(e.target.value) || 0 } : prev)}
                                className="w-14 text-center border border-blue-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200"
                              />
                              <span className="text-xs text-slate-400">%</span>
                            </span>
                          ) : (
                            <span className="text-slate-400">({displayTaxRate}%)</span>
                          )}
                        </span>
                        <span className="font-semibold">{formatCurrency(displayTax)}</span>
                      </div>
                      <div className="flex justify-between bg-slate-900 text-white rounded-xl px-4 py-3 mt-2">
                        <span className="font-bold text-base">Total Estimate</span>
                        <span className="font-black text-xl">{formatCurrency(displayTotal)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Waste factor note */}
                  <div className="flex gap-2 bg-amber-50 border border-amber-100 rounded-xl p-4 text-sm text-amber-800">
                    <Info size={15} className="flex-shrink-0 mt-0.5 text-amber-500" />
                    <div>
                      <span className="font-semibold">Order quantity includes 12% waste factor</span> for cuts, overlaps, and starter courses.
                    </div>
                  </div>

                  {/* Contact footer */}
                  <div className="bg-slate-50 rounded-2xl p-6 text-center border border-slate-100">
                    <p className="text-slate-500 text-sm mb-3">Questions about this estimate? Contact our roofing experts.</p>
                    <div className="flex items-center justify-center gap-6 text-sm">
                      <a href="tel:+15551234567" className="flex items-center gap-1.5 text-blue-600 hover:text-blue-700 font-medium">
                        <Phone size={13} /> (555) 123-4567
                      </a>
                      <a href="mailto:quotes@roofiq.com" className="flex items-center gap-1.5 text-blue-600 hover:text-blue-700 font-medium">
                        <Mail size={13} /> quotes@roofiq.com
                      </a>
                    </div>
                    <p className="text-xs text-slate-400 mt-4">
                      This estimate is based on satellite measurements and is subject to an on-site inspection. Final pricing may vary ±10% based on actual conditions found during inspection.
                    </p>
                    <p className="text-xs text-slate-300 mt-2 font-mono">Quote #{quote.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
