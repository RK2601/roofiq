import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Eye, ChevronRight, Search, X } from 'lucide-react';
import { getRecentQuotes, projectTagLabel } from '../utils/db';
import QuoteDetailModal from './QuoteDetailModal';
import QuoteTagMenu from './QuoteTagMenu';
import { projectTagTone } from './ProjectTagMenu';

interface Quote {
  id: string;
  material_name: string;
  total_squares: number;
  total: number;
  generated_at: string;
  address: string | null;
  quote_tag: string | null;
  project_id: string | null;
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function quoteMatchesQuery(q: Quote, raw: string): boolean {
  const query = raw.trim().toLowerCase();
  if (!query) return true;
  const hay = [
    q.address ?? '',
    q.material_name,
    projectTagLabel(q.quote_tag) ?? '',
    q.id,
    String(q.total_squares),
    String(Math.round(q.total)),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

export default function QuotesListPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const reloadQuotes = useCallback(() => {
    return getRecentQuotes(50)
      .then(rows => setQuotes(rows as Quote[]))
      .catch(console.error);
  }, []);

  useEffect(() => {
    reloadQuotes().finally(() => setLoading(false));
  }, [reloadQuotes]);

  const filteredQuotes = useMemo(
    () => quotes.filter(q => quoteMatchesQuery(q, searchQuery)),
    [quotes, searchQuery]
  );

  const handleQuoteDeleted = useCallback((deletedId: string) => {
    setQuotes(prev => prev.filter(q => q.id !== deletedId));
    setSelectedId(cur => (cur === deletedId ? null : cur));
  }, []);

  return (
    <>
      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Quotes</h2>
            {!loading && (
              <p className="text-slate-500 text-sm mt-1">
                {searchQuery.trim()
                  ? `${filteredQuotes.length} match${filteredQuotes.length !== 1 ? 'es' : ''} · ${quotes.length} total`
                  : `Showing ${quotes.length} quote${quotes.length !== 1 ? 's' : ''}`}
              </p>
            )}
          </div>
          {!loading && quotes.length > 0 && (
            <div className="relative w-full min-w-0 sm:max-w-md sm:min-w-[12rem]">
              <Search
                size={18}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search address, material, status…"
                className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-10 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                aria-label="Search quotes"
              />
              {searchQuery.trim() !== '' && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Clear search"
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <>
              <div className="lg:hidden p-3 space-y-2 animate-pulse">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[5.75rem] rounded-xl bg-slate-100" />
                ))}
              </div>
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
          ) : filteredQuotes.length === 0 ? (
            <div className="p-8 sm:p-16 text-center">
              <Search size={40} className="text-slate-300 mx-auto mb-4" aria-hidden />
              <p className="text-slate-500 font-semibold text-lg">No matches</p>
              <p className="text-slate-400 text-sm mt-2">Try a different search term or clear the filter.</p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-4 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                Clear search
              </button>
            </div>
          ) : (
            <>
              <ul className="lg:hidden p-2 sm:p-3 space-y-2 list-none">
                {filteredQuotes.map(q => (
                  <li key={q.id} className="flex gap-2 items-stretch">
                    <button
                      type="button"
                      onClick={() => setSelectedId(q.id)}
                      className="touch-manipulation min-w-0 flex-1 rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:p-4 text-left transition-colors hover:bg-slate-50 active:bg-slate-100"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2">
                            <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2 min-w-0 flex-1">
                              {q.address ?? 'No address'}
                            </p>
                            {projectTagLabel(q.quote_tag) && (
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${projectTagTone(q.quote_tag)}`}
                              >
                                {projectTagLabel(q.quote_tag)}
                              </span>
                            )}
                          </div>
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
                    <div
                      className="shrink-0 flex flex-col justify-center py-2"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <QuoteTagMenu
                        quoteId={q.id}
                        currentTag={q.quote_tag}
                        compact
                        onTagUpdated={tag =>
                          setQuotes(prev => prev.map(x => (x.id === q.id ? { ...x, quote_tag: tag } : x)))
                        }
                        onQuoteDeleted={handleQuoteDeleted}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm min-w-[52rem]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10">#</th>
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                      <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Material</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Squares</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                      <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-36">Tag</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredQuotes.map((q, idx) => (
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
                        <td className="px-6 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            {projectTagLabel(q.quote_tag) ? (
                              <span
                                className={`max-w-[6.5rem] truncate rounded-full px-2 py-0.5 text-xs font-semibold ${projectTagTone(q.quote_tag)}`}
                                title={projectTagLabel(q.quote_tag) ?? undefined}
                              >
                                {projectTagLabel(q.quote_tag)}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                            <QuoteTagMenu
                              quoteId={q.id}
                              currentTag={q.quote_tag}
                              compact
                              onTagUpdated={tag =>
                                setQuotes(prev => prev.map(x => (x.id === q.id ? { ...x, quote_tag: tag } : x)))
                              }
                              onQuoteDeleted={handleQuoteDeleted}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
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
