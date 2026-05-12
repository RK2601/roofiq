import { useState, useRef } from 'react';
import { ArrowLeft, Upload, Cpu, AlertCircle, CheckCircle2, Info } from 'lucide-react';

interface PlaneResult {
  plane_id: number;
  pitch_deg: number;
  pitch_ratio: number;
  facing: string;
  area_rel: number;
  point_count: number;
  normal: [number, number, number];
}

interface PipelineResult {
  planes: PlaneResult[];
  dominant_pitch: number | string;
  dominant_facing: string;
  depth_map_b64: string;
  overlay_b64: string | null;
  stats: {
    image_size: { width: number; height: number };
    total_points: number;
    mesh_vertices: number;
    mesh_triangles: number;
    planes_detected: number;
    elapsed_seconds: number;
  };
}

interface Props {
  onBack: () => void;
}

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

const SERVICE_URL = import.meta.env.VITE_DEPTH_SERVICE_URL ?? '';

const FACING_COLORS: Record<string, string> = {
  N: 'bg-blue-100 text-blue-700',
  NE: 'bg-indigo-100 text-indigo-700',
  E: 'bg-purple-100 text-purple-700',
  SE: 'bg-fuchsia-100 text-fuchsia-700',
  S: 'bg-rose-100 text-rose-700',
  SW: 'bg-orange-100 text-orange-700',
  W: 'bg-amber-100 text-amber-700',
  NW: 'bg-yellow-100 text-yellow-700',
  Flat: 'bg-slate-100 text-slate-600',
};

export default function DepthPipelinePage({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'depth' | 'overlay'>('overlay');
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file.');
      setPhase('error');
      return;
    }

    setPreview(URL.createObjectURL(file));
    setPhase('uploading');
    setError('');
    setResult(null);

    if (!SERVICE_URL) {
      setError('VITE_DEPTH_SERVICE_URL is not configured. Add it to .env and redeploy.');
      setPhase('error');
      return;
    }

    try {
      setPhase('processing');
      const form = new FormData();
      form.append('file', file);

      const res = await fetch(`${SERVICE_URL}/analyze`, { method: 'POST', body: form });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(`Service error ${res.status}: ${detail}`);
      }

      const data: PipelineResult = await res.json();
      setResult(data);
      setPhase('done');
      setActiveTab(data.overlay_b64 ? 'overlay' : 'depth');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  const isLoading = phase === 'uploading' || phase === 'processing';

  return (
    <div className="min-h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <Cpu size={20} className="text-violet-600" />
          <h1 className="font-semibold text-slate-900">3D Depth Pipeline</h1>
        </div>
        <span className="ml-auto text-xs bg-violet-100 text-violet-700 font-medium px-2 py-0.5 rounded-full">
          Depth Anything V2 + Open3D
        </span>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Info banner */}
        <div className="flex items-start gap-3 bg-violet-50 border border-violet-200 rounded-xl p-4 text-sm text-violet-800">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <p>
            Upload any aerial or street-level roof photo. The Python service will run{' '}
            <strong>Depth Anything V2</strong> on Replicate, reconstruct a{' '}
            <strong>3D point cloud + Poisson mesh</strong> with Open3D, then segment roof planes using{' '}
            <strong>iterative RANSAC</strong>. Processing takes 20–60 s.
          </p>
        </div>

        {/* Upload zone */}
        <div
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => !isLoading && inputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer
            ${isLoading ? 'opacity-60 cursor-not-allowed border-slate-200' : 'border-violet-300 hover:border-violet-500 hover:bg-violet-50/50'}`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onInputChange}
            disabled={isLoading}
          />
          <Upload size={36} className="text-violet-400" />
          <p className="text-slate-600 font-medium">
            {isLoading ? 'Processing…' : 'Drop a roof photo here or click to browse'}
          </p>
          <p className="text-slate-400 text-sm">JPEG, PNG, WebP · max 20 MB</p>
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col items-center gap-4">
            <div className="w-12 h-12 rounded-full border-4 border-violet-200 border-t-violet-600 animate-spin" />
            <div className="text-center">
              <p className="font-semibold text-slate-800">
                {phase === 'uploading' ? 'Uploading image…' : 'Running depth pipeline…'}
              </p>
              <p className="text-slate-500 text-sm mt-1">
                Depth Anything V2 → point cloud → Poisson mesh → RANSAC segmentation
              </p>
            </div>
            {preview && (
              <img
                src={preview}
                alt="preview"
                className="w-48 h-32 object-cover rounded-xl border border-slate-200 opacity-60"
              />
            )}
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold">Pipeline failed</p>
              <p className="mt-1 font-mono text-xs">{error}</p>
            </div>
          </div>
        )}

        {/* Results */}
        {phase === 'done' && result && (
          <>
            {/* Success bar */}
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <CheckCircle2 size={16} />
              <span>
                Pipeline complete in <strong>{result.stats.elapsed_seconds}s</strong> —{' '}
                <strong>{result.stats.planes_detected}</strong> roof plane
                {result.stats.planes_detected !== 1 ? 's' : ''} detected
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Visual outputs */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="flex border-b border-slate-100">
                  {(['overlay', 'depth'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      disabled={tab === 'overlay' && !result.overlay_b64}
                      className={`flex-1 py-2.5 text-sm font-medium transition-colors
                        ${activeTab === tab ? 'text-violet-700 border-b-2 border-violet-600' : 'text-slate-500 hover:text-slate-700'}
                        ${tab === 'overlay' && !result.overlay_b64 ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {tab === 'overlay' ? 'Plane Overlay' : 'Depth Map'}
                    </button>
                  ))}
                </div>
                <div className="p-3">
                  {activeTab === 'overlay' && result.overlay_b64 ? (
                    <img src={result.overlay_b64} alt="plane overlay" className="w-full rounded-xl" />
                  ) : activeTab === 'depth' ? (
                    <img src={result.depth_map_b64} alt="depth map" className="w-full rounded-xl" />
                  ) : null}
                </div>
              </div>

              {/* Stats + planes table */}
              <div className="space-y-4">
                {/* Pipeline stats */}
                <div className="bg-white border border-slate-200 rounded-2xl p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Pipeline Stats</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {[
                      ['Image', `${result.stats.image_size.width} × ${result.stats.image_size.height}`],
                      ['Points', result.stats.total_points.toLocaleString()],
                      ['Mesh vertices', result.stats.mesh_vertices.toLocaleString()],
                      ['Mesh triangles', result.stats.mesh_triangles.toLocaleString()],
                      ['Dominant pitch', typeof result.dominant_pitch === 'number'
                        ? `${result.dominant_pitch.toFixed(2)} (${(Math.atan(result.dominant_pitch) * 180 / Math.PI).toFixed(1)}°)`
                        : result.dominant_pitch],
                      ['Dominant facing', result.dominant_facing],
                    ].map(([label, value]) => (
                      <div key={label} className="bg-slate-50 rounded-lg px-3 py-2">
                        <p className="text-xs text-slate-400">{label}</p>
                        <p className="font-medium text-slate-800">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Planes table */}
                {result.planes.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100">
                      <h3 className="text-sm font-semibold text-slate-700">Detected Planes</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">#</th>
                            <th className="px-3 py-2 text-left">Facing</th>
                            <th className="px-3 py-2 text-right">Pitch</th>
                            <th className="px-3 py-2 text-right">Rise/Run</th>
                            <th className="px-3 py-2 text-right">Area %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.planes.map((p, i) => (
                            <tr key={p.plane_id} className={i % 2 === 0 ? '' : 'bg-slate-50/50'}>
                              <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                              <td className="px-3 py-2">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${FACING_COLORS[p.facing] ?? 'bg-slate-100 text-slate-600'}`}>
                                  {p.facing}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-medium text-slate-700">
                                {p.pitch_deg.toFixed(1)}°
                              </td>
                              <td className="px-3 py-2 text-right text-slate-600">
                                {p.pitch_ratio.toFixed(2)}
                              </td>
                              <td className="px-3 py-2 text-right text-slate-600">
                                {(p.area_rel * 100).toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Try another */}
            <div className="flex justify-center pt-2">
              <button
                onClick={() => { setPhase('idle'); setResult(null); setPreview(null); }}
                className="px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
              >
                Analyse Another Photo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
