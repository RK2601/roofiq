/**
 * HOVER API client — professional roof measurement via 8-photo photogrammetry.
 * All calls go through /api/proxy-hover (key lives in HOVER_API_KEY env var, never in the browser).
 */

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

function proxy(path: string): string {
  return `/api/proxy-hover?path=${encodeURIComponent(path)}`;
}

export interface HoverJob {
  id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  name: string;
  created_at: string;
  deliverables?: HoverDeliverables;
}

export interface HoverDeliverables {
  measurements?: HoverMeasurements;
  report_url?: string;
  model_url?: string;
}

export interface HoverMeasurements {
  total_area_sq_ft?: number;
  total_squares?: number;
  predominant_pitch?: string;
  facets?: HoverFacet[];
  eave_length_ft?: number;
  ridge_length_ft?: number;
  valley_length_ft?: number;
  rake_length_ft?: number;
  hip_length_ft?: number;
  waste_factor?: number;
}

export interface HoverFacet {
  id: string;
  area_sq_ft: number;
  pitch: string;
  azimuth_deg?: number;
  facing?: string;
}

/** Create a new HOVER job for a property address. */
export async function createHoverJob(
  address: string,
  lat: number,
  lng: number
): Promise<HoverJob> {
  const res = await fetch(proxy('jobs'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      job: {
        name: address,
        location: { lat, lon: lng },
        delivery_method: 'webhook',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HOVER_CREATE_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { job: HoverJob };
  return json.job;
}

/** Upload a single photo to an existing HOVER job. */
export async function uploadHoverPhoto(
  jobId: string,
  file: File,
  captureType: string
): Promise<void> {
  const toBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });

  const base64 = await toBase64(file);
  const res = await fetch(proxy(`jobs/${jobId}/images`), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      image: {
        data: base64,
        content_type: file.type || 'image/jpeg',
        capture_type: captureType,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HOVER_UPLOAD_${res.status}: ${body.slice(0, 200)}`);
  }
}

/** Submit a job for processing after all photos are uploaded. */
export async function submitHoverJob(jobId: string): Promise<HoverJob> {
  const res = await fetch(proxy(`jobs/${jobId}`), {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ job: { status: 'processing' } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HOVER_SUBMIT_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { job: HoverJob };
  return json.job;
}

/** Poll job status until complete or failed (max 10 min). */
export async function pollHoverJob(
  jobId: string,
  onProgress?: (status: string) => void
): Promise<HoverJob> {
  const INTERVAL = 10_000;
  const MAX_ATTEMPTS = 60;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, INTERVAL));
    const res = await fetch(proxy(`jobs/${jobId}`), { headers: headers() });
    if (!res.ok) continue;
    const json = (await res.json()) as { job: HoverJob };
    const job = json.job;
    onProgress?.(job.status);
    if (job.status === 'complete' || job.status === 'failed') return job;
  }
  throw new Error('HOVER_POLL_TIMEOUT');
}

/** Fetch final deliverables (measurements) for a completed job. */
export async function fetchHoverMeasurements(jobId: string): Promise<HoverMeasurements | null> {
  const res = await fetch(proxy(`jobs/${jobId}/measurements`), { headers: headers() });
  if (!res.ok) return null;
  const json = (await res.json()) as { measurements: HoverMeasurements };
  return json.measurements ?? null;
}
