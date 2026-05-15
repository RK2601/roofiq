import type { Coordinates } from '../types';
import { latLngToImageNorm } from './roofVision';

/** Keep aligned with satellite snapshot cap in RoofMappingWizard */
const MAX_DATA_URL_CHARS = 800_000;

/**
 * Renders the roof outline on the same satellite frame used for Gemini (when available),
 * with orange perimeter and vertex markers similar to the map editor.
 */
export async function buildRoofOutlineSnapshotDataUrl(
  path: Array<{ lat: number; lng: number }>,
  center: Coordinates,
  sat: { data: string; mimeType: string } | null | undefined,
  zoom = 20,
  size = 640
): Promise<string | null> {
  if (path.length < 3 || typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const pts = path.map(p => {
    const n = latLngToImageNorm(p, center, zoom, size);
    return { x: n.x * size, y: n.y * size };
  });

  const strokeOutline = () => {
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();

    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(100,116,139,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };

  if (sat?.data && sat.data.length > 80) {
    try {
      const dataUrl = `data:${sat.mimeType || 'image/png'};base64,${sat.data}`;
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, size, size);
          strokeOutline();
          resolve();
        };
        img.onerror = () => reject(new Error('satellite image load failed'));
        img.src = dataUrl;
      });
    } catch {
      ctx.fillStyle = '#475569';
      ctx.fillRect(0, 0, size, size);
      strokeOutline();
    }
  } else {
    ctx.fillStyle = '#475569';
    ctx.fillRect(0, 0, size, size);
    strokeOutline();
  }

  let out = canvas.toDataURL('image/jpeg', 0.88);
  if (out.length > MAX_DATA_URL_CHARS) {
    out = canvas.toDataURL('image/jpeg', 0.72);
  }
  if (out.length > MAX_DATA_URL_CHARS) {
    out = canvas.toDataURL('image/jpeg', 0.6);
  }
  return out.length <= MAX_DATA_URL_CHARS ? out : null;
}
