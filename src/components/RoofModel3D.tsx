/**
 * RoofModel3D — blueprint-style roof plan with 4-stage geometry processing:
 *   1. Python/Shapely  — vertex snapping + edge simplification
 *   2. Pitch correction — stretch each face along slope by √(1 + (p/12)²)
 *   3. Regularization  — snap to polygon's principal-axis grid
 *   4. Shared-edge lines — Shapely intersection highlights ridges/valleys
 */
import { useRef, useEffect, useCallback, useState, useMemo } from 'react';

const METERS_PER_DEG_LAT = 111_320;

export interface RoofModel3DSegment {
  path: Array<{ lat: number; lng: number }>;
  color: string;
  analysis: unknown | null;
  flatAreaSqFt?: number;
}

interface Props {
  segments: RoofModel3DSegment[];
  center: { lat: number; lng: number };
  mapsApiKey?: string;
}

type Pt = [number, number];
type Poly = Pt[];

interface ApiResponse {
  segments: Array<{ id: string; path: Array<{ x: number; y: number }> }>;
  sharedEdges: Array<{ ids: [string, string]; coords: [number, number][] }>;
  outlines?: Array<Array<[number, number]>>;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function latLngToM(pt: { lat: number; lng: number }, o: { lat: number; lng: number }): Pt {
  const c = Math.cos((o.lat * Math.PI) / 180);
  return [
    (pt.lng - o.lng) * METERS_PER_DEG_LAT * c,
    (pt.lat - o.lat) * METERS_PER_DEG_LAT,
  ];
}

const centroid = (p: Poly): Pt => [
  p.reduce((s, [x]) => s + x, 0) / p.length,
  p.reduce((s, [, y]) => s + y, 0) / p.length,
];

// Uphill direction for each facing (water drains in facing direction → uphill is opposite)
// Coord system: X = East (+), Y = North (+)
const UPHILL: Record<string, [number, number]> = {
  N:  [ 0,     -1    ],
  NE: [-0.707, -0.707],
  E:  [-1,      0    ],
  SE: [-0.707,  0.707],
  S:  [ 0,      1    ],
  SW: [ 0.707,  0.707],
  W:  [ 1,      0    ],
  NW: [ 0.707, -0.707],
};

/** Stretch each vertex along the uphill (slope) direction to reveal true face dimensions. */
function pitchCorrect(poly: Poly, pitchStr: string | null | undefined, facing: string): Poly {
  const m = pitchStr ? /^(\d+(?:\.\d+)?)\/12$/.exec(pitchStr.trim()) : null;
  if (!m) return poly;
  const ratio = parseFloat(m[1]) / 12;
  if (ratio === 0) return poly;
  const stretch = Math.sqrt(1 + ratio * ratio); // = 1 / cos(atan(ratio))
  const uh = UPHILL[facing];
  if (!uh) return poly;

  const [cx, cy] = centroid(poly);
  return poly.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const t = dx * uh[0] + dy * uh[1]; // scalar projection onto uphill axis
    return [cx + dx + t * (stretch - 1) * uh[0],
            cy + dy + t * (stretch - 1) * uh[1]] as Pt;
  });
}

/** Snap vertices to the polygon's principal-axis-aligned grid → orthogonal clean edges. */
function regularize(poly: Poly): Poly {
  if (poly.length < 3) return poly;

  // Principal axis via covariance
  const [cx, cy] = centroid(poly);
  let cxx = 0, cxy = 0, cyy = 0;
  for (const [x, y] of poly) {
    const dx = x - cx, dy = y - cy;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
  const cosB = Math.cos(angle),  sinB = Math.sin(angle);

  // Rotate to principal frame
  const rotated: Poly = poly.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [dx * cosA - dy * sinA, dx * sinA + dy * cosA];
  });

  // Grid size: span / 20, clamped to [0.15 m, 0.4 m]
  const xs = rotated.map(([x]) => x), ys = rotated.map(([, y]) => y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const grid = Math.max(0.15, Math.min(0.4, span / 20));

  // Snap, then rotate back and re-centre
  return rotated.map(([rx, ry]) => {
    const sx = Math.round(rx / grid) * grid;
    const sy = Math.round(ry / grid) * grid;
    return [cx + sx * cosB - sy * sinB, cy + sx * sinB + sy * cosB] as Pt;
  });
}

function getPitchFacing(seg: RoofModel3DSegment): [string | null, string] {
  const a = seg.analysis as { pitchEstimate?: string; facingDirection?: string } | null;
  const sx = seg as RoofModel3DSegment & { dsmPitchRatio?: string; dsmFacingDirection?: string };
  return [
    sx.dsmPitchRatio ?? a?.pitchEstimate ?? null,
    sx.dsmFacingDirection ?? a?.facingDirection ?? '',
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RoofModel3D({ segments, center, mapsApiKey }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [apiData, setApiData] = useState<ApiResponse | null>(null);
  const [satImage, setSatImage] = useState<HTMLImageElement | null>(null);

  const segs = useMemo(
    () => segments.filter(s => s.path.length >= 3).map((s, i) => ({
      ...s,
      _id: (s as RoofModel3DSegment & { id?: string }).id ?? String(i),
    })),
    [segments],
  );

  // ── Call Python API ──────────────────────────────────────────────────
  useEffect(() => {
    if (segs.length < 1) return;
    let cancelled = false;

    const payload = {
      segments: segs.map(s => {
        const [, facing] = getPitchFacing(s);
        return {
          id: s._id,
          path: s.path.map(p => { const [x, y] = latLngToM(p, center); return { x, y }; }),
          facing: facing || null,
        };
      }),
    };

    fetch('/api/roof-net', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: ApiResponse | null) => {
        if (!cancelled && data?.segments) setApiData(data);
      })
      .catch(() => { /* fallback: use original paths */ });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segs.length, center.lat, center.lng]);

  // ── Fetch satellite image ────────────────────────────────────────────
  useEffect(() => {
    if (!mapsApiKey) return;
    let cancelled = false;
    const staticUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${center.lat},${center.lng}&zoom=20&size=640x640&maptype=satellite&scale=2&key=${mapsApiKey}`;
    const proxyUrl = `/api/proxy-static-map?u=${encodeURIComponent(staticUrl)}`;
    const img = new Image();
    // Same-origin proxy; anonymous keeps the bitmap exportable for html2canvas / PDF.
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!cancelled) setSatImage(img); };
    img.onerror = () => { /* silently ignore — degrade to plain background */ };
    img.src = proxyUrl;
    return () => { cancelled = true; };
  }, [mapsApiKey, center.lat, center.lng]);

  // ── Render ───────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (segs.length === 0) return;

    // White base so semi-transparent fills look correct when no sat image
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, W, H);

    // Always use original lat/lng→metres coords for fills so they align
    // exactly with what the user traced (Shapely simplification can shift
    // vertices and cause visible misalignment against the satellite image).
    type RenderPoly = { poly: Poly; id: string };
    const renderPolys: RenderPoly[] = segs.map(s => ({
      poly: s.path.map(p => latLngToM(p, center)),
      id: s._id,
    }));

    // Bounding box + scale
    const xs = renderPolys.flatMap(r => r.poly.map(([x]) => x));
    const ys = renderPolys.flatMap(r => r.poly.map(([, y]) => y));
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const PAD = 32;
    const scale = Math.min((W - PAD * 2) / (maxX - minX || 1), (H - PAD * 2) / (maxY - minY || 1));
    const drawW = (maxX - minX) * scale, drawH = (maxY - minY) * scale;
    const ox = PAD + (W - PAD * 2 - drawW) / 2;
    const oy = PAD + (H - PAD * 2 - drawH) / 2;
    const toC = ([x, y]: Pt): Pt => [ox + (x - minX) * scale, oy + drawH - (y - minY) * scale];

    // ── Draw satellite background (aligned to same coordinate space) ──
    if (satImage) {
      // Google Static Maps zoom 20, scale 2 → 1280×1280 px image covers a tile
      // Metres per pixel at zoom 20: 156543.03392 * cos(lat°) / 2^zoom / scale
      const mpp = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / (1 << 20) / 2;
      const imgPx = mpp * 1280 * scale; // image size in canvas pixels
      // The image is centered on center.lat/lng = local origin [0,0].
      // Find the canvas pixel for [0,0] using toC.
      const [originCx, originCy] = toC([0, 0]);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.drawImage(satImage, originCx - imgPx / 2, originCy - imgPx / 2, imgPx, imgPx);
      ctx.restore();
    }

    // ── Draw fills ────────────────────────────────────────────────────
    for (const { poly } of renderPolys) {
      const pts = poly.map(toC);
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = satImage ? 'rgba(219,234,254,0.25)' : '#dbeafe';
      ctx.fill();
    }

    // ── Draw outlines ─────────────────────────────────────────────────
    const unionOutlines = apiData?.outlines;
    ctx.strokeStyle = satImage ? '#ffffff' : '#93c5fd';
    ctx.lineWidth = 1.5;
    if (unionOutlines?.length) {
      for (const outline of unionOutlines) {
        const pts = outline.map(([x, y]) => toC([x, y]));
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
    } else {
      for (const { poly } of renderPolys) {
        const pts = poly.map(toC);
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
    }

    // ── Shared edges (ridge / valley) ─────────────────────────────────
    if (apiData?.sharedEdges?.length) {
      ctx.strokeStyle = satImage ? '#facc15' : '#3b82f6';
      ctx.lineWidth = 1.8;
      for (const edge of apiData.sharedEdges) {
        if (edge.coords.length < 2) continue;
        ctx.beginPath();
        edge.coords.forEach(([x, y], k) => {
          const [cx2, cy2] = toC([x, y]);
          k ? ctx.lineTo(cx2, cy2) : ctx.moveTo(cx2, cy2);
        });
        ctx.stroke();
      }
    }
  }, [segs, center, apiData, satImage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const w = canvas.parentElement?.clientWidth ?? 480;
      canvas.width = w;
      canvas.height = Math.round(w * 0.6);
      render();
    });
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  }, [render]);

  useEffect(() => { render(); }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={480}
      height={288}
      className="w-full rounded-lg bg-white border border-slate-200"
      style={{ display: 'block' }}
    />
  );
}
