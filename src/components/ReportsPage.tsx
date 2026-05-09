import { FileText, BarChart2, MapPin, Layers, TrendingUp, Download } from 'lucide-react';

const REPORT_TYPES = [
  {
    icon: <FileText size={22} className="text-blue-600" />,
    title: 'Roof Measurement Report',
    desc: 'Full multi-page PDF with aerial imagery, blueprint diagram, per-section measurements, pitch breakdown, and material estimate.',
    badge: 'Available',
    badgeColor: 'bg-green-100 text-green-700',
    hint: 'Generate from any project via Generate Quote → Measurement Report',
  },
  {
    icon: <Layers size={22} className="text-purple-600" />,
    title: 'Pitch & Direction Report',
    desc: 'Visual breakdown of each roof segment by pitch and azimuth direction. Includes blueprint-style diagram with color coding.',
    badge: 'Available',
    badgeColor: 'bg-green-100 text-green-700',
    hint: 'Included in the Measurement Report',
  },
  {
    icon: <BarChart2 size={22} className="text-amber-600" />,
    title: 'Monthly Analysis Volume',
    desc: 'Track the number of roof analyses and quotes completed each month across all properties.',
    badge: 'Coming Soon',
    badgeColor: 'bg-amber-100 text-amber-700',
    hint: null,
  },
  {
    icon: <TrendingUp size={22} className="text-emerald-600" />,
    title: 'Revenue by Material',
    desc: 'Breakdown of estimated revenue by roofing material type across all generated quotes.',
    badge: 'Coming Soon',
    badgeColor: 'bg-amber-100 text-amber-700',
    hint: null,
  },
  {
    icon: <MapPin size={22} className="text-red-500" />,
    title: 'Top Service Areas',
    desc: 'Most active zip codes and regions based on project count and total roof area analyzed.',
    badge: 'Coming Soon',
    badgeColor: 'bg-amber-100 text-amber-700',
    hint: null,
  },
  {
    icon: <Download size={22} className="text-slate-600" />,
    title: 'CSV / Data Export',
    desc: 'Export all projects, measurements, and quotes as CSV for use in Excel, QuickBooks, or other tools.',
    badge: 'Coming Soon',
    badgeColor: 'bg-amber-100 text-amber-700',
    hint: null,
  },
];

export default function ReportsPage() {
  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Reports</h2>
        <p className="text-slate-500 mt-1 text-sm">Measurement reports, analytics and insights for your roofing business.</p>
      </div>

      {/* How to generate a report */}
      <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3">
        <FileText size={20} className="text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-900 mb-0.5">Generating a Measurement Report</p>
          <p className="text-sm text-blue-700 leading-relaxed">
            Open any project → go to <strong>Analysis</strong> → draw roof sections → click <strong>Save &amp; Quote</strong> → on the Quote page click <strong>Measurement Report</strong>. The report includes aerial imagery, blueprint diagram, per-section measurements, pitch breakdown, and material estimate — ready to print or save as PDF.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORT_TYPES.map(rt => (
          <div key={rt.title} className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                {rt.icon}
              </div>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${rt.badgeColor}`}>
                {rt.badge}
              </span>
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm mb-1">{rt.title}</h3>
              <p className="text-slate-500 text-xs leading-relaxed">{rt.desc}</p>
            </div>
            {rt.hint && (
              <div className="mt-auto pt-2 border-t border-slate-100">
                <p className="text-[11px] text-blue-600 font-medium">{rt.hint}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* What's in the report */}
      <div className="mt-8 bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <FileText size={16} className="text-blue-600" />
          <h3 className="font-semibold text-slate-800 text-sm">What's included in each Measurement Report</h3>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          {[
            'Cover page with high-res aerial satellite imagery',
            'Key stats: Roof Area, Facets, Predominant Pitch, Squares',
            'AI condition assessment (if analyzed)',
            'Blueprint-style roof plan diagram (all sections)',
            'Per-section area, pitch, perimeter, and squares',
            'Pitch & Direction report with visual bar chart',
            'Material estimate with order quantities',
            'Total perimeter (eaves estimate) from polygon geometry',
            'Waste-factor ordering quantities per material type',
            'Print-ready PDF via browser Print → Save as PDF',
          ].map(item => (
            <div key={item} className="flex items-start gap-2 text-xs text-slate-700 py-1.5 border-b border-slate-50">
              <span className="text-green-500 font-bold shrink-0 mt-0.5">✓</span>
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
