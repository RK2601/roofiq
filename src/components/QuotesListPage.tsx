import { useEffect, useState } from 'react';
import { FileText, Eye } from 'lucide-react';
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
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Quotes</h2>
            {!loading && (
              <p className="text-slate-500 text-sm mt-1">
                Showing {quotes.length} quote{quotes.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="animate-pulse">
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
          ) : quotes.length === 0 ? (
            <div className="p-16 text-center">
              <FileText size={48} className="text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500 font-semibold text-lg">No quotes yet</p>
              <p className="text-slate-400 text-sm mt-2">Complete an analysis to generate your first quote.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
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
                    <td className="px-6 py-3 text-right text-slate-600">
                      {q.total_squares.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <span className={`font-semibold ${q.total >= 5000 ? 'text-green-700' : 'text-slate-800'}`}>
                        {q.total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right text-slate-400">
                      {new Date(q.generated_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </td>
                    <td className="px-6 py-3 text-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setSelectedId(q.id)}
                        className="inline-flex items-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <Eye size={13} />
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
