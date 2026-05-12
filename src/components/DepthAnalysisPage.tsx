import { useState, useRef } from 'react';
import { Upload, Cpu, Loader2, AlertTriangle, RotateCcw, Info, CheckCircle2 } from 'lucide-react';

// Replicate model: chenxwh/ml-depth-pro (Apple Depth Pro, ICLR 2025)
// Faster (~4s) and cheaper than alternatives. Outputs: color_map, npz.
const DEPTH_PRO_VERSION = 'a6645b33f4e36eda0d8d52ab3da6ef37b82d198e2b70c72e680cc75f0baf1623';

interface DepthResult {
  depth_map_url: string;
  metric_depth_url?: string;
  focal_length?: number;
}

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | Record<string, string>;
  error?: string;
  urls?: { get: string };
}

async function runDepthPro(imageDataUrl: string): Promise<DepthResult> {
  const createRes = await fetch(`/api/proxy-replicate?path=predictions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: DEPTH_PRO_VERSION,
      input: { image_path: imageDataUrl },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`REPLICATE_${createRes.status}: ${body.slice(0, 200)}`);
  }

  let pred = (await createRes.json()) as ReplicatePrediction;
  const pollPath = pred.id ? `predictions/${pred.id}` : '';

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pollRes = await fetch(`/api/proxy-replicate?path=${encodeURIComponent(pollPath)}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!pollRes.ok) continue;
    pred = (await pollRes.json()) as ReplicatePrediction;
    if (pred.status === 'succeeded') break;
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`REPLICATE_${pred.status.toUpperCase()}: ${pred.error ?? 'unknown'}`);
    }
  }

  if (pred.status !== 'succeeded' || !pred.output) throw new Error('REPLICATE_TIMEOUT');

  const out = pred.output;
  // chenxwh/ml-depth-pro returns { color_map, npz }
  if (typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string, string>;
    return {
      depth_map_url: o.color_map ?? o.depth ?? o.output ?? '',
      metric_depth_url: o.npz ?? o.metric_depth,
    };
  }
  if (typeof out === 'string') return { depth_map_url: out };
  if (Array.isArray(out)) return { depth_map_url: out[0], metric_depth_url: out[1] };
  return { depth_map_url: '' };
}

interface DepthAnalysisPageProps {
  onBack: () => void;
}

export default function DepthAnalysisPage({ onBack }: DepthAnalysisPageProps) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<DepthResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = e => setImageUrl(e.target?.result as string);
    reader.readAsDataURL(file);
    setResult(null);
    setError(null);
  };

  const analyze = async () => {
    if (!imageUrl) return;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runDepthPro(imageUrl));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    setImageFile(null);
    setImageUrl(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="min-h-full bg-slate-50 py-6 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors">
            ← Back
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-slate-900">AI Depth Analysis</h1>
            <p className="text-sm text-slate-500">Zero-shot metric depth from a single photo</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
            <Cpu size={12} />
            Depth Pro
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* Info banner */}
        <div className="flex items-start gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
          <Info size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <strong>Apple Depth Pro</strong> (ICLR 2025) produces metric depth from a single image in ~0.3 s.
            Best results from <strong>aerial or oblique</strong> photos. Runs via Replicate — set{' '}
            <span className="font-mono">REPLICATE_API_TOKEN</span> in your <span className="font-mono">.env</span>.
          </div>
        </div>

        {/* Upload area */}
        <div
          className={`relative border-2 border-dashed rounded-2xl transition-colors mb-4 ${imageUrl ? 'border-emerald-300 bg-emerald-50/30' : 'border-slate-300 bg-white hover:border-emerald-400 hover:bg-emerald-50/20'}`}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="absolute inset-0 opacity-0 cursor-pointer"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          {imageUrl ? (
            <div className="p-4">
              <img src={imageUrl} alt="Selected roof photo" className="w-full max-h-64 object-contain rounded-xl" />
              <p className="text-xs text-slate-500 text-center mt-2">{imageFile?.name} — click to change</p>
            </div>
          ) : (
            <div className="py-12 text-center">
              <Upload size={32} className="text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">Upload a roof photo</p>
              <p className="text-xs text-slate-400 mt-1">Aerial, oblique, or street-level — JPG / PNG / HEIC</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          {imageUrl && (
            <button
              onClick={reset}
              className="flex items-center gap-2 px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:border-slate-300 transition-colors"
            >
              <RotateCcw size={14} /> Clear
            </button>
          )}
          <button
            onClick={analyze}
            disabled={!imageUrl || analyzing}
            className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {analyzing ? (
              <><Loader2 size={16} className="animate-spin" /> Analysing… (may take 30–90 s)</>
            ) : (
              <><Cpu size={16} /> Run Depth Analysis</>
            )}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="mt-6 space-y-4">
            <div className="bg-white border border-emerald-200 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircle2 size={18} className="text-emerald-500" />
                <h2 className="font-semibold text-slate-900">Depth Map Generated</h2>
              </div>

              {result.depth_map_url && (
                <div className="mb-4">
                  <p className="text-xs text-slate-500 mb-1">Depth map — brighter = closer to camera</p>
                  <img src={result.depth_map_url} alt="Depth map" className="w-full rounded-xl border border-slate-100" />
                </div>
              )}

              {result.metric_depth_url && (
                <div className="mb-4 p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-700">Metric depth data (absolute scale)</p>
                    <p className="text-xs text-slate-500 mt-0.5">NumPy .npz file — load in Python for per-pixel depth values in metres</p>
                  </div>
                  <a
                    href={result.metric_depth_url}
                    download="depth_metric.npz"
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors"
                  >
                    Download .npz
                  </a>
                </div>
              )}

              {result.focal_length && (
                <div className="bg-slate-50 rounded-xl px-4 py-2 inline-block">
                  <p className="text-lg font-bold text-slate-900">{result.focal_length.toFixed(0)}</p>
                  <p className="text-xs text-slate-500">Focal length (px)</p>
                </div>
              )}

              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
                <strong>Note:</strong> Depth Pro provides relative depth from a single image.
                For precise measurements use HOVER (8-photo photogrammetry) or the Smart Roof Wizard with Google Solar DSM.
              </div>
            </div>

            {result.depth_map_url && (
              <a
                href={result.depth_map_url}
                target="_blank"
                rel="noreferrer"
                className="block text-center py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:border-slate-300 transition-colors"
              >
                Open depth map in new tab ↗
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
