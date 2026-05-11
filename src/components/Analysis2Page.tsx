import { Zap, Map } from 'lucide-react';

interface Analysis2PageProps {
  onQuickAnalysis: () => void;
  onSmartRoofMappingWizard: () => void;
}

export default function Analysis2Page({ onQuickAnalysis, onSmartRoofMappingWizard }: Analysis2PageProps) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-slate-50 [-webkit-overflow-scrolling:touch]">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <p className="text-sm text-slate-600 mb-6 leading-relaxed">
          Choose how you want to measure the roof. Quick analysis keeps everything on one map screen; the wizard walks
          you through AI-assisted outline, photos, and a combined report.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:gap-5 sm:grid-cols-2">
          <article className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-bold text-slate-900 leading-tight">Quick analysis</h2>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                <Zap size={20} className="text-amber-600" aria-hidden />
              </div>
            </div>
            <p className="mt-3 flex-1 text-sm text-slate-600 leading-relaxed">
              Search an address, use satellite imagery, draw roof sections, and run estimates without leaving the map
              workspace.
            </p>
            <button
              type="button"
              onClick={onQuickAnalysis}
              className="touch-manipulation mt-5 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 active:bg-blue-800"
            >
              Start quick analysis
            </button>
          </article>

          <article className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-bold text-slate-900 leading-tight">Smart Roof Mapping Wizard</h2>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50">
                <Map size={20} className="text-violet-600" aria-hidden />
              </div>
            </div>
            <p className="mt-3 flex-1 text-sm text-slate-600 leading-relaxed">
              Step-by-step flow: roof outline and segments, multi-angle photos, then a merged structural and visual
              analysis with a saveable report.
            </p>
            <button
              type="button"
              onClick={onSmartRoofMappingWizard}
              className="touch-manipulation mt-5 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-semibold text-violet-900 transition-colors hover:bg-violet-100 active:bg-violet-200/80"
            >
              Open mapping wizard
            </button>
          </article>
        </div>
      </div>
    </div>
  );
}
