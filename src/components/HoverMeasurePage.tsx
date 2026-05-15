import { useState, useRef, useCallback } from 'react';
import {
  Camera, Upload, CheckCircle2, XCircle, Loader2,
  ChevronRight, AlertTriangle, RotateCcw, FileText, Info,
} from 'lucide-react';
import {
  createHoverJob, uploadHoverPhoto, submitHoverJob, pollHoverJob,
  fetchHoverMeasurements,
  type HoverJob, type HoverMeasurements,
} from '../utils/hoverApi';
import { Coordinates } from '../types';

interface HoverMeasurePageProps {
  address: string;
  coordinates: Coordinates;
  onBack: () => void;
}

const CAPTURE_TYPES = [
  { id: 'front',       label: 'Front',       description: 'Street-facing, facing the front' },
  { id: 'back',        label: 'Back',        description: 'Behind the house, facing back' },
  { id: 'left',        label: 'Left Side',   description: 'Left side, facing the house' },
  { id: 'right',       label: 'Right Side',  description: 'Right side, facing the house' },
  { id: 'front_left',  label: 'Front-Left',  description: '45° — front-left corner' },
  { id: 'front_right', label: 'Front-Right', description: '45° — front-right corner' },
  { id: 'back_left',   label: 'Back-Left',   description: '45° — back-left corner' },
  { id: 'back_right',  label: 'Back-Right',  description: '45° — back-right corner' },
];

type Phase = 'upload' | 'processing' | 'results';

export default function HoverMeasurePage({ address, coordinates, onBack }: HoverMeasurePageProps) {
  const [phase, setPhase] = useState<Phase>('upload');
  const [job, setJob] = useState<HoverJob | null>(null);
  const [photos, setPhotos] = useState<Record<string, File>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);
  const [pollStatus, setPollStatus] = useState('');
  const [measurements, setMeasurements] = useState<HoverMeasurements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const ensureJob = async (): Promise<HoverJob | null> => {
    if (job) return job;
    setCreatingJob(true);
    setError(null);
    try {
      const j = await createHoverJob(address, coordinates.lat, coordinates.lng);
      setJob(j);
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create job');
      return null;
    } finally {
      setCreatingJob(false);
    }
  };

  const handleFileSelect = useCallback(async (captureType: string, file: File) => {
    setUploading(captureType);
    setUploadError(null);
    const j = await ensureJob();
    if (!j) { setUploading(null); return; }
    try {
      await uploadHoverPhoto(j.id, file, captureType);
      setPhotos(prev => ({ ...prev, [captureType]: file }));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, address, coordinates]);

  const submitJob = async () => {
    if (!job) return;
    setError(null);
    setPhase('processing');
    try {
      await submitHoverJob(job.id);
      const completed = await pollHoverJob(job.id, setPollStatus);
      if (completed.status === 'failed') {
        setError('HOVER processing failed. Check photo quality and try again.');
        setPhase('upload');
        return;
      }
      const m = await fetchHoverMeasurements(completed.id);
      setMeasurements(m);
      setPhase('results');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Processing failed');
      setPhase('upload');
    }
  };

  const reset = () => {
    setPhase('upload');
    setJob(null);
    setPhotos({});
    setMeasurements(null);
    setError(null);
    setPollStatus('');
  };

  const uploadedCount = Object.keys(photos).length;
  const canSubmit = uploadedCount >= 4 && !!job;

  return (
    <div className="min-h-full bg-slate-50 py-6 px-4 safe-pb">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            type="button"
            onClick={onBack}
            className="tap-target shrink-0 text-slate-500 hover:text-slate-700 transition-colors touch-manipulation rounded-lg -ml-1"
          >
            ← Back
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-slate-900">HOVER Measurement</h1>
            <p className="text-sm text-slate-500 truncate">{address}</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-purple-600 bg-purple-50 border border-purple-200 rounded-full px-3 py-1">
            <Camera size={12} />
            Photogrammetry
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* Upload Phase */}
        {phase === 'upload' && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-xl p-3">
              <Info size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                Take <strong>8 photos</strong> from each direction around the property and upload them below.
                HOVER builds a 3D model and returns exact measurements. Upload at least 4 to submit.
              </div>
            </div>

            {creatingJob && (
              <div className="flex items-center gap-2 text-sm text-slate-500 p-3 bg-slate-100 rounded-xl">
                <Loader2 size={14} className="animate-spin" /> Creating job…
              </div>
            )}

            {job && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-slate-400 font-mono">Job {job.id}</p>
                  <span className="text-xs text-slate-500">{uploadedCount}/8 uploaded</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5">
                  <div
                    className="bg-purple-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${(uploadedCount / 8) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                {uploadError}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {CAPTURE_TYPES.map(ct => {
                const uploaded = !!photos[ct.id];
                const busy = uploading === ct.id;
                return (
                  <div
                    key={ct.id}
                    className={`relative border-2 rounded-xl overflow-hidden transition-colors ${uploaded ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:border-purple-300'}`}
                  >
                    <input
                      ref={el => { fileRefs.current[ct.id] = el; }}
                      type="file"
                      accept="image/*"
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) handleFileSelect(ct.id, f);
                      }}
                    />
                    <div className="p-3 text-center">
                      {busy ? (
                        <Loader2 size={20} className="animate-spin text-purple-500 mx-auto mb-1" />
                      ) : uploaded ? (
                        <CheckCircle2 size={20} className="text-emerald-500 mx-auto mb-1" />
                      ) : (
                        <Upload size={20} className="text-slate-400 mx-auto mb-1" />
                      )}
                      <p className="text-xs font-medium text-slate-700">{ct.label}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{ct.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-3">
              <button onClick={onBack} className="px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:border-slate-300 transition-colors">
                Cancel
              </button>
              <button
                onClick={submitJob}
                disabled={!canSubmit}
                className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {canSubmit ? (
                  <>Submit for Processing <ChevronRight size={16} /></>
                ) : (
                  `Upload at least 4 photos (${uploadedCount}/4)`
                )}
              </button>
            </div>
          </div>
        )}

        {/* Processing Phase */}
        {phase === 'processing' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
            <Loader2 size={48} className="animate-spin text-purple-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Processing your roof…</h2>
            <p className="text-sm text-slate-500 mb-4">
              HOVER is building a 3D model and extracting measurements. Typically 5–15 minutes.
            </p>
            {pollStatus && (
              <span className="inline-flex items-center gap-1.5 text-xs bg-purple-50 text-purple-600 border border-purple-200 rounded-full px-3 py-1">
                Status: {pollStatus}
              </span>
            )}
          </div>
        )}

        {/* Results Phase */}
        {phase === 'results' && measurements && (
          <div className="space-y-4">
            <div className="bg-white border border-emerald-200 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircle2 size={20} className="text-emerald-500" />
                <h2 className="font-semibold text-slate-900">Measurements Complete</h2>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
                {measurements.total_area_sq_ft && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.total_area_sq_ft.toLocaleString()}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Total sq ft</p>
                  </div>
                )}
                {measurements.total_squares && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.total_squares.toFixed(1)}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Squares</p>
                  </div>
                )}
                {measurements.predominant_pitch && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.predominant_pitch}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Pitch</p>
                  </div>
                )}
                {measurements.ridge_length_ft && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.ridge_length_ft.toFixed(0)}'</p>
                    <p className="text-xs text-slate-500 mt-0.5">Ridge</p>
                  </div>
                )}
                {measurements.eave_length_ft && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.eave_length_ft.toFixed(0)}'</p>
                    <p className="text-xs text-slate-500 mt-0.5">Eave</p>
                  </div>
                )}
                {measurements.valley_length_ft && (
                  <div className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-slate-900">{measurements.valley_length_ft.toFixed(0)}'</p>
                    <p className="text-xs text-slate-500 mt-0.5">Valley</p>
                  </div>
                )}
              </div>

              {measurements.facets && measurements.facets.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Roof Facets</h3>
                  <div className="space-y-2">
                    {measurements.facets.map((f, i) => (
                      <div key={f.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-2">
                        <span className="text-slate-600">Facet {i + 1}</span>
                        <div className="flex items-center gap-4 text-slate-700">
                          <span>{f.area_sq_ft.toLocaleString()} sq ft</span>
                          <span className="font-mono text-xs">{f.pitch}</span>
                          {f.facing && <span className="text-xs text-slate-400">{f.facing}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={reset}
                className="flex items-center gap-2 px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:border-slate-300 transition-colors"
              >
                <RotateCcw size={14} /> New Job
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors"
                onClick={() => alert('Quote generation from HOVER measurements coming soon!')}
              >
                <FileText size={16} /> Generate Quote
              </button>
            </div>
          </div>
        )}

        {phase === 'results' && !measurements && (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
            <XCircle size={40} className="text-red-400 mx-auto mb-3" />
            <h2 className="font-semibold text-slate-900 mb-1">No measurements returned</h2>
            <p className="text-sm text-slate-500 mb-4">
              The job completed but HOVER did not return measurement data. Try with more photos.
            </p>
            <button onClick={reset} className="px-6 py-2 bg-slate-700 text-white rounded-xl text-sm hover:bg-slate-800 transition-colors">
              Start Over
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
