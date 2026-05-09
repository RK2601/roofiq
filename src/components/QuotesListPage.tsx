import { useEffect, useState } from 'react';
import { FileText, Eye, ChevronRight } from 'lucide-react';
import { getRecentQuotes } from '../utils/db';
import QuoteDetailModal from './QuoteDetailModal';

interface Quote {
  id: string;
  material_name: string;
  total_squares: number;
  total: number;
  generated_at: string;
  address: string | null;
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function QuotesListPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getRecentQuotes(50)
      .then(rows => setQuotes(rows as Quote[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:p-6">
        <div className="mb-5 sm:mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Quotes</h2>
          {!loading && (
            <p className="text-slate-500 text-sm mt-1">
              Showing {quotes.length} quote{quotes.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <>
              {/* Mobile skeletons */}
              <div className="lg:hidden p-3 space-y-2 animate-pulse">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[5.75rem] rounded-xl bg-slate-100" />
                ))}
              </div>
              {/* Desktop skeletons */}
              <div className="hidden lg:block animate-pulse">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-6 py-4 border-b border-slate-100 flex items-center gap-4">
                    <div className="h-4 bg-slate-200 rounded w-6" />
                    <div className="h-4 bg-slate-200 rounded flex-1" />
                    <div className="h-4 bg-slate-200 rounded w-24" />
                    <div className="h-4 bg-slate-200 rounded w-16" />
                    <div className="h-4 bg-slate-200 rounded w-20" />
                    <div className="h-4 bg-slate-200 rounded w-24" />
                    <div className="h-8 bg-slate-200 rounded w-16" />
                  </div>
                ))}
              </div>
            </>
          ) : quotes.length === 0 ? (
            <div className="p-8 sm:p-16 text-center">
              <FileText size={48} className="text-slate-300 mx-auto mb-4" aria-hidden />
              <p className="text-slate-500 font-semibold text-lg">No quotes yet</p>
              <p className="text-slate-400 text-sm mt-2">Complete an analysis to generate your first quote.</p>
            </div>
          ) : (
            <>
              {/* Mobile: card list */}
              <ul className="lg:hidden p-2 sm:p-3 space-y-2 list-none">
                {quotes.map(q => (
                  <li key={q.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(q.id)}
                      className="touch-manipulation w-full rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:p-4 text-left transition-colors hover:bg-slate-50 active:bg-slate-100"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
                            {q.address ?? 'No address'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {q.material_name} · {q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })} sq
                          </p>
                        </div>
                        <ChevronRight size={20} className="shrink-0 text-slate-300 mt-0.5" aria-hidden />
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-200/70 pt-3">
                        <span className="text-[11px] text-slate-400 tabular-nums">
                          {formatShortDate(q.generated_at)}
                        </span>
                        <span className={`text-base font-bold tabular-nums ${q.total >= 5000 ? 'text-green-700' : 'text-slate-900'}`}>
                          {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>

              {/* Desktop: table */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm min-w-[48rem]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10">#</th>
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Material</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Squares</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                      <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {quotes.map((q, idx) => (
                      <tr
                        key={q.id}
                        className="hover:bg-slate-50 transition-colors cursor-pointer"
                        onClick={() => setSelectedId(q.id)}
                      >
                        <td className="px-6 py-3 text-slate-400">{idx + 1}</td>
                        <td className="px-6 py-3 text-slate-700 max-w-xs">
                          <span className="block truncate">
                            {q.address ?? <span className="text-slate-400 italic">No address</span>}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-slate-600">{q.material_name}</td>
                        <td className="px-6 py-3 text-right text-slate-600 tabular-nums">
                          {q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                        </td>
                        <td className="px-6 py-3 text-right">
                          <span className={`font-semibold tabular-nums ${q.total >= 5000 ? 'text-green-700' : 'text-slate-800'}`}>
                            {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-right text-slate-400 tabular-nums whitespace-nowrap">
                          {formatShortDate(q.generated_at)}
                        </td>
                        <td className="px-6 py-3 text-center" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(q.id)}
                            className="touch-manipulation inline-flex items-center justify-center gap-1.5 min-h-[40px] min-w-[88px] bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
                          >
                            <Eye size={13} aria-hidden />
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {!loading && quotes.length > 0 && (
          <p className="text-slate-400 text-xs mt-3">
            Showing {quotes.length} of {quotes.length} quotes
          </p>
        )}
      </div>

      {selectedId && (
        <QuoteDetailModal
          quoteId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}
