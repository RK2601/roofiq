export default function ReportsPage() {
  const charts = [
    { title: 'Monthly Analysis Volume', desc: 'Track the number of roof analyses completed each month.' },
    { title: 'Revenue by Material', desc: 'Breakdown of estimated revenue by roofing material type.' },
    { title: 'Top Zip Codes', desc: 'Most active service areas based on project count.' },
  ];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Reports</h2>
        <p className="text-slate-500 mt-1">Analytics and insights for your roofing business.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {charts.map(chart => (
          <div key={chart.title} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 text-sm">{chart.title}</h3>
              <span className="text-xs font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                Coming Soon
              </span>
            </div>
            <div className="p-6">
              <p className="text-slate-400 text-sm mb-6">{chart.desc}</p>
              {/* Placeholder chart */}
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-12 text-xs text-slate-400 text-right flex-shrink-0">
                      {['Jan', 'Feb', 'Mar', 'Apr', 'May'][i]}
                    </div>
                    <div className="flex-1 bg-slate-100 rounded-full h-4 overflow-hidden">
                      <div
                        className="h-full bg-blue-200 rounded-full"
                        style={{ width: `${[65, 45, 80, 55, 70][i]}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 pt-4 border-t border-slate-100 text-center">
                <p className="text-slate-300 text-xs font-medium uppercase tracking-wider">Data visualization coming soon</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
        <p className="text-blue-800 font-semibold mb-1">Full reporting suite is under development</p>
        <p className="text-blue-600 text-sm">Export CSV/PDF reports, date filtering, and trend analysis will be available in the next release.</p>
      </div>
    </div>
  );
}
