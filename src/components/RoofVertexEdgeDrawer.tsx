/**
 * RoofVertexEdgeDrawer — two-step segment drawing:
 *
 *  Step 1 (Vertices): Click corners/junctions on the roof to place dots.
 *                     Drag to reposition. Click dot to remove.
 *
 *  Step 2 (Edges):    Click a vertex — a glowing line follows your cursor.
 *                     Move to the next vertex — it snaps and highlights.
 *                     Click to draw that edge. Repeat for every edge.
 *                     Closed loops are detected automatically as segments.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { MousePointer2, GitBranch, Check, X, Trash2 } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RVertex {
  id: string;
  num: number;
  lat: number;
  lng: number;
  marker: google.maps.Marker;
}

interface REdge {
  id: string;
  fromId: string;
  toId: string;
  glowLine: google.maps.Polyline;  // wide semi-transparent glow
  solidLine: google.maps.Polyline; // narrow solid line on top
}

interface RFace {
  id: string;
  vertexIds: string[];
  path: { lat: number; lng: number }[];
  polygon: google.maps.Polygon | null;
  color: string;
}

export interface Props {
  map: google.maps.Map;
  outline: google.maps.Polygon | null;
  onDone: (faces: Array<{ path: { lat: number; lng: number }[] }>) => void;
  onCancel: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SNAP_M = 16;   // snap to vertex within this radius (meters)

const FACE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#6366f1',
];

const EDGE_SOLID_COLOR = '#94a3b8';   // committed edge colour
const EDGE_GLOW_COLOR  = '#cbd5e1';   // committed edge glow

// ─── Geometry ─────────────────────────────────────────────────────────────────

function metersBetween(
  geom: typeof google.maps.geometry.spherical,
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  return geom.computeDistanceBetween(
    new google.maps.LatLng(a.lat, a.lng),
    new google.maps.LatLng(b.lat, b.lng)
  );
}

/**
 * Signed area > 0 → CCW winding → interior face in lat/lng space.
 * Applies cos(lat) to longitude so the area is geographically meaningful.
 */
function signedArea(path: { lat: number; lng: number }[]): number {
  let a = 0;
  const n = path.length;
  const midLat = path.reduce((s, p) => s + p.lat, 0) / n;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const p = path[i], q = path[(i + 1) % n];
    a += (p.lng * cosLat) * q.lat - (q.lng * cosLat) * p.lat;
  }
  return a / 2;
}

/**
 * Planar half-edge face detection.
 * For directed edge A→B, the next half-edge is B→C where C is the neighbour
 * of B most clockwise from the B→A direction.  This traces CCW interior faces.
 */
function detectFaces(verts: Map<string, RVertex>, edges: REdge[]): string[][] {
  if (verts.size < 3 || edges.length < 3) return [];

  const adj = new Map<string, string[]>();
  for (const [id] of verts) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.fromId)?.push(e.toId);
    adj.get(e.toId)?.push(e.fromId);
  }

  function nextHE(from: string, to: string): [string, string] {
    const A = verts.get(from)!, B = verts.get(to)!;
    // Apply cos(lat) so that longitude differences are scaled to meters,
    // giving accurate angles for the planar half-edge traversal.
    const cosLat = Math.cos((B.lat * Math.PI) / 180);
    const angleBA = Math.atan2(A.lat - B.lat, (A.lng - B.lng) * cosLat);
    const nbrs = adj.get(to) ?? [];
    let bestId = from, bestDiff = Infinity;
    for (const nId of nbrs) {
      if (nId === from && nbrs.length > 1) continue;
      const N = verts.get(nId)!;
      const angleBN = Math.atan2(N.lat - B.lat, (N.lng - B.lng) * cosLat);
      const diff = ((angleBA - angleBN) + 2 * Math.PI) % (2 * Math.PI);
      if (diff < bestDiff) { bestDiff = diff; bestId = nId; }
    }
    return [to, bestId];
  }

  const key = (f: string, t: string) => `${f}→${t}`;
  const visited = new Set<string>();
  const halfEdges: [string, string][] = [];
  for (const e of edges) { halfEdges.push([e.fromId, e.toId]); halfEdges.push([e.toId, e.fromId]); }

  const faces: string[][] = [];
  for (const [hf, ht] of halfEdges) {
    if (visited.has(key(hf, ht))) continue;
    const face: string[] = [];
    let [cf, ct] = [hf, ht];
    let guard = halfEdges.length + 4;
    while (!visited.has(key(cf, ct)) && guard-- > 0) {
      visited.add(key(cf, ct));
      face.push(cf);
      [cf, ct] = nextHE(cf, ct);
    }
    if (face.length >= 3) faces.push(face);
  }

  return faces.filter(faceIds => {
    const path = faceIds.map(id => { const v = verts.get(id)!; return { lat: v.lat, lng: v.lng }; });
    return signedArea(path) > 0;
  });
}

// ─── Marker icons ─────────────────────────────────────────────────────────────

function makeVertexIcon(state: 'normal' | 'from' | 'snap'): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: state === 'from' ? 9 : state === 'snap' ? 8 : 7,
    fillColor: state === 'from' ? '#22c55e' : state === 'snap' ? '#facc15' : '#f97316',
    fillOpacity: 1,
    strokeColor: '#0f172a',
    strokeWeight: 1.5,
  };
}

function makeVertexLabel(num: number, state: 'normal' | 'from' | 'snap'): google.maps.MarkerLabel {
  return {
    text: String(num),
    color: state === 'snap' ? '#0f172a' : '#ffffff',
    fontSize: '8px',
    fontWeight: 'bold',
  };
}

// ─── Polyline pair (glow + solid) ─────────────────────────────────────────────

function makeLinePair(
  map: google.maps.Map,
  path: google.maps.LatLng[],
  glowColor: string,
  solidColor: string,
  clickable: boolean
): [google.maps.Polyline, google.maps.Polyline] {
  const glow = new google.maps.Polyline({
    path, strokeColor: glowColor, strokeOpacity: 0.35, strokeWeight: 10,
    clickable, zIndex: 3, map,
  });
  const solid = new google.maps.Polyline({
    path, strokeColor: solidColor, strokeOpacity: 1, strokeWeight: 2.5,
    clickable, zIndex: 4, map,
  });
  return [glow, solid];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RoofVertexEdgeDrawer({ map, outline, onDone, onCancel }: Props) {
  const [step, setStep] = useState<'vertices' | 'edges'>('vertices');
  const stepRef = useRef<'vertices' | 'edges'>('vertices');

  // Selected "from" vertex in edge mode
  const [fromId, setFromId] = useState<string | null>(null);
  const fromIdRef = useRef<string | null>(null);

  // Hovered snap target in edge mode
  const snapIdRef = useRef<string | null>(null);

  const [vertexCount, setVertexCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [faces, setFaces] = useState<RFace[]>([]);
  // 'reviewing' = user clicked "Use segments" — show confirm/edit-more panel
  const [reviewing, setReviewing] = useState(false);

  const vertsRef = useRef<Map<string, RVertex>>(new Map());
  const edgesRef = useRef<REdge[]>([]);
  const facesRef = useRef<RFace[]>([]);
  const vertexCounterRef = useRef(0); // increments each time a vertex is placed

  // Preview polylines (glow layer + solid layer)
  const previewGlowRef  = useRef<google.maps.Polyline | null>(null);
  const previewSolidRef = useRef<google.maps.Polyline | null>(null);
  const snapCircleRef   = useRef<google.maps.Circle | null>(null);

  const clickListenerRef        = useRef<google.maps.MapsEventListener | null>(null);
  const moveListenerRef         = useRef<google.maps.MapsEventListener | null>(null);
  const outlineClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);

  // ── Nearest vertex ───────────────────────────────────────────────────────────

  const nearestVertex = useCallback((ll: google.maps.LatLng): RVertex | null => {
    const geom = google.maps.geometry?.spherical;
    if (!geom) return null;
    let best: RVertex | null = null, bestD = SNAP_M;
    for (const v of vertsRef.current.values()) {
      const d = metersBetween(geom, { lat: ll.lat(), lng: ll.lng() }, v);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }, []);

  const edgeExists = useCallback((a: string, b: string) =>
    edgesRef.current.some(e => (e.fromId === a && e.toId === b) || (e.fromId === b && e.toId === a)),
  []);

  // ── Face detection ───────────────────────────────────────────────────────────

  const refreshFaces = useCallback(() => {
    const faceIds = detectFaces(vertsRef.current, edgesRef.current);
    for (const f of facesRef.current) f.polygon?.setMap(null);

    const newFaces: RFace[] = faceIds.map((vIds, i) => {
      const path = vIds.map(id => { const v = vertsRef.current.get(id)!; return { lat: v.lat, lng: v.lng }; });
      const color = FACE_COLORS[i % FACE_COLORS.length];
      const polygon = new google.maps.Polygon({
        paths: path, fillColor: color, fillOpacity: 0.22,
        strokeColor: color, strokeWeight: 1.5, clickable: false, zIndex: 1, map,
      });
      return { id: `f${i}`, vertexIds: vIds, path, polygon, color };
    });

    facesRef.current = newFaces;
    setFaces(newFaces);
  }, [map]);

  // ── Vertex icons ─────────────────────────────────────────────────────────────

  const refreshIcons = useCallback(() => {
    for (const v of vertsRef.current.values()) {
      const state = v.id === fromIdRef.current ? 'from'
                  : v.id === snapIdRef.current ? 'snap'
                  : 'normal';
      v.marker.setIcon(makeVertexIcon(state));
      v.marker.setLabel(makeVertexLabel(v.num, state));
    }
  }, []);

  // ── Preview line ─────────────────────────────────────────────────────────────

  const ensurePreview = useCallback(() => {
    if (previewGlowRef.current) return;
    previewGlowRef.current = new google.maps.Polyline({
      path: [], strokeColor: '#22c55e', strokeOpacity: 0.4, strokeWeight: 14,
      clickable: false, zIndex: 10, map,
    });
    previewSolidRef.current = new google.maps.Polyline({
      path: [], strokeColor: '#4ade80', strokeOpacity: 0.95, strokeWeight: 3,
      clickable: false, zIndex: 11, map,
      icons: [{
        icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
        offset: '0', repeat: '12px',
      }],
    });
  }, [map]);

  const setPreviewPath = useCallback((path: google.maps.LatLng[]) => {
    previewGlowRef.current?.setPath(path);
    previewSolidRef.current?.setPath(path);
  }, []);

  const clearPreview = useCallback(() => {
    previewGlowRef.current?.setPath([]);
    previewSolidRef.current?.setPath([]);
    snapCircleRef.current?.setMap(null);
    snapIdRef.current = null;
    refreshIcons();
  }, [refreshIcons]);

  // ── Add / remove vertex ───────────────────────────────────────────────────────

  const removeEdgesOf = useCallback((id: string) => {
    const toRemove = edgesRef.current.filter(e => e.fromId === id || e.toId === id);
    toRemove.forEach(e => { e.glowLine.setMap(null); e.solidLine.setMap(null); });
    edgesRef.current = edgesRef.current.filter(e => e.fromId !== id && e.toId !== id);
    setEdgeCount(edgesRef.current.length);
  }, []);

  const addVertex = useCallback((lat: number, lng: number): RVertex => {
    const id = `v${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    const num = ++vertexCounterRef.current;
    const marker = new google.maps.Marker({
      position: { lat, lng }, map,
      icon: makeVertexIcon('normal'),
      label: makeVertexLabel(num, 'normal'),
      draggable: true, zIndex: (google.maps.Marker.MAX_ZINDEX ?? 1e6) + 10,
      title: `Corner ${num} · Drag to move · Click to remove`,
    });

    const v: RVertex = { id, num, lat, lng, marker };
    vertsRef.current.set(id, v);

    marker.addListener('drag', () => {
      const p = marker.getPosition();
      if (!p) return;
      v.lat = p.lat(); v.lng = p.lng();
      // update connected edges
      for (const e of edgesRef.current) {
        if (e.fromId === id || e.toId === id) {
          const a = vertsRef.current.get(e.fromId)!, b = vertsRef.current.get(e.toId)!;
          const pts = [new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(b.lat, b.lng)];
          e.glowLine.setPath(pts); e.solidLine.setPath(pts);
        }
      }
      refreshFaces();
    });

    marker.addListener('click', () => {
      if (stepRef.current === 'vertices') {
        // Remove vertex + its edges
        v.marker.setMap(null);
        vertsRef.current.delete(id);
        removeEdgesOf(id);
        if (fromIdRef.current === id) { fromIdRef.current = null; setFromId(null); }
        setVertexCount(vertsRef.current.size);
        refreshFaces();
      } else {
        // Edge mode — handled in map click listener via nearestVertex snap
        handleEdgeVertexClick(id);
      }
    });

    setVertexCount(vertsRef.current.size);
    return v;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, removeEdgesOf, refreshFaces]);

  const addVertexRef = useRef(addVertex);
  addVertexRef.current = addVertex;

  // ── Edge vertex click handler (stable ref) ────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleEdgeVertexClick = useCallback((clickedId: string) => {
    const from = fromIdRef.current;
    if (!from) {
      // Select as start
      fromIdRef.current = clickedId;
      setFromId(clickedId);
      ensurePreview();
      refreshIcons();
      return;
    }
    if (from === clickedId) {
      // Deselect
      fromIdRef.current = null;
      setFromId(null);
      clearPreview();
      return;
    }
    // Draw edge
    if (!edgeExists(from, clickedId)) {
      const a = vertsRef.current.get(from)!, b = vertsRef.current.get(clickedId)!;
      const pts = [new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(b.lat, b.lng)];
      const [glow, solid] = makeLinePair(map, pts, EDGE_GLOW_COLOR, EDGE_SOLID_COLOR, true);

      // Click edge to delete it
      const eid = `e${Date.now()}`;
      const edge: REdge = { id: eid, fromId: from, toId: clickedId, glowLine: glow, solidLine: solid };
      glow.addListener('click', () => deleteEdge(eid));
      solid.addListener('click', () => deleteEdge(eid));

      edgesRef.current.push(edge);
      setEdgeCount(edgesRef.current.length);
      refreshFaces();
    }
    // Advance: clicked vertex becomes new "from"
    fromIdRef.current = clickedId;
    setFromId(clickedId);
    snapIdRef.current = null;
    refreshIcons();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, edgeExists, refreshFaces, refreshIcons, clearPreview, ensurePreview]);

  const handleEdgeVertexClickRef = useRef(handleEdgeVertexClick);
  handleEdgeVertexClickRef.current = handleEdgeVertexClick;

  // ── Delete edge ───────────────────────────────────────────────────────────────

  const deleteEdge = useCallback((eid: string) => {
    const idx = edgesRef.current.findIndex(e => e.id === eid);
    if (idx < 0) return;
    edgesRef.current[idx].glowLine.setMap(null);
    edgesRef.current[idx].solidLine.setMap(null);
    edgesRef.current.splice(idx, 1);
    setEdgeCount(edgesRef.current.length);
    refreshFaces();
  }, [refreshFaces]);

  // ── Map listeners ─────────────────────────────────────────────────────────────

  const removeListeners = useCallback(() => {
    if (clickListenerRef.current)        { google.maps.event.removeListener(clickListenerRef.current);        clickListenerRef.current        = null; }
    if (moveListenerRef.current)         { google.maps.event.removeListener(moveListenerRef.current);         moveListenerRef.current         = null; }
    if (outlineClickListenerRef.current) { google.maps.event.removeListener(outlineClickListenerRef.current); outlineClickListenerRef.current = null; }
    clearPreview();
  }, [clearPreview]);

  // Shared map-click handler — used by both vertex and edge modes
  const handleMapClick = useCallback((latLng: google.maps.LatLng) => {
    if (stepRef.current === 'vertices') {
      // Don't guard with nearestVertex here — marker clicks never propagate to the
      // map click event, so every map click is always a fresh point placement.
      addVertexRef.current(latLng.lat(), latLng.lng());
    } else {
      const snap = nearestVertex(latLng);
      if (snap) {
        handleEdgeVertexClickRef.current(snap.id);
        return;
      }
      // Clicked empty space — place new vertex and connect
      const from = fromIdRef.current;
      const nv = addVertexRef.current(latLng.lat(), latLng.lng());
      if (from) {
        handleEdgeVertexClickRef.current(nv.id);
      } else {
        fromIdRef.current = nv.id;
        setFromId(nv.id);
        ensurePreview();
        refreshIcons();
      }
    }
  }, [nearestVertex, ensurePreview, refreshIcons]);

  const handleMapClickRef = useRef(handleMapClick);
  handleMapClickRef.current = handleMapClick;

  const attachVertexListeners = useCallback((outline: google.maps.Polygon | null) => {
    removeListeners();
    // Listen on the map
    clickListenerRef.current = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng) handleMapClickRef.current(e.latLng);
    });
    // Also listen on the outline polygon — it blocks map clicks when clickable
    if (outline) {
      outlineClickListenerRef.current = outline.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) handleMapClickRef.current(e.latLng);
      });
    }
  }, [map, removeListeners]);

  const attachEdgeListeners = useCallback((outline: google.maps.Polygon | null) => {
    removeListeners();
    ensurePreview();

    moveListenerRef.current = map.addListener('mousemove', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng || stepRef.current !== 'edges') return;
      const from = fromIdRef.current;
      if (!from) { clearPreview(); return; }

      const fv = vertsRef.current.get(from);
      if (!fv) { clearPreview(); return; }

      const snap = nearestVertex(e.latLng);
      const target = (snap && snap.id !== from)
        ? new google.maps.LatLng(snap.lat, snap.lng)
        : e.latLng;

      // Live glowing preview line
      setPreviewPath([new google.maps.LatLng(fv.lat, fv.lng), target]);

      // Snap indicator circle
      if (snap && snap.id !== from) {
        if (!snapCircleRef.current) {
          snapCircleRef.current = new google.maps.Circle({
            strokeColor: '#facc15', strokeOpacity: 0.9, strokeWeight: 2.5,
            fillColor: '#facc15', fillOpacity: 0.18, clickable: false, zIndex: 12, map,
          });
        }
        snapCircleRef.current.setCenter({ lat: snap.lat, lng: snap.lng });
        snapCircleRef.current.setRadius(SNAP_M);
        snapCircleRef.current.setMap(map);
        if (snapIdRef.current !== snap.id) {
          snapIdRef.current = snap.id;
          refreshIcons();
        }
      } else {
        snapCircleRef.current?.setMap(null);
        if (snapIdRef.current) { snapIdRef.current = null; refreshIcons(); }
      }
    });

    // Map click
    clickListenerRef.current = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng && stepRef.current === 'edges') handleMapClickRef.current(e.latLng);
    });
    // Outline polygon click (blocks map clicks otherwise)
    if (outline) {
      outlineClickListenerRef.current = outline.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng && stepRef.current === 'edges') handleMapClickRef.current(e.latLng);
      });
    }
  }, [map, removeListeners, ensurePreview, nearestVertex, clearPreview, setPreviewPath, refreshIcons]);

  // ── Step switch ───────────────────────────────────────────────────────────────

  // Keep a stable ref to the current outline prop so callbacks can access it without stale closure
  const outlineRef = useRef(outline);
  outlineRef.current = outline;

  const goToEdges = useCallback(() => {
    stepRef.current = 'edges';
    setStep('edges');
    fromIdRef.current = null; setFromId(null);
    attachEdgeListeners(outlineRef.current);
  }, [attachEdgeListeners]);

  const goToVertices = useCallback(() => {
    stepRef.current = 'vertices';
    setStep('vertices');
    fromIdRef.current = null; setFromId(null);
    clearPreview();
    attachVertexListeners(outlineRef.current);
  }, [clearPreview, attachVertexListeners]);

  // ── Init & cleanup ────────────────────────────────────────────────────────────

  useEffect(() => {
    // Disable double-click zoom so rapid corner placement isn't swallowed by map zoom
    map.setOptions({ disableDoubleClickZoom: true });

    // Make the outline polygon non-editable/non-clickable while this drawer is active
    // so clicks on the roof area reach our listeners instead of the polygon.
    const ol = outlineRef.current;
    if (ol) ol.setOptions({ clickable: false, editable: false });

    stepRef.current = 'vertices';
    attachVertexListeners(ol);

    return () => {
      removeListeners();
      map.setOptions({ disableDoubleClickZoom: false });
      // Restore outline interactivity
      if (ol) ol.setOptions({ clickable: true, editable: true });
      for (const v of vertsRef.current.values()) v.marker.setMap(null);
      vertsRef.current.clear();
      for (const e of edgesRef.current) { e.glowLine.setMap(null); e.solidLine.setMap(null); }
      edgesRef.current = [];
      for (const f of facesRef.current) f.polygon?.setMap(null);
      facesRef.current = [];
      previewGlowRef.current?.setMap(null);  previewGlowRef.current  = null;
      previewSolidRef.current?.setMap(null); previewSolidRef.current = null;
      snapCircleRef.current?.setMap(null);   snapCircleRef.current   = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fromIdRef.current) {
          fromIdRef.current = null; setFromId(null); clearPreview();
        } else {
          onCancel();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, clearPreview]);

  // ── Clear all ─────────────────────────────────────────────────────────────────

  const clearAll = useCallback(() => {
    for (const v of vertsRef.current.values()) v.marker.setMap(null);
    vertsRef.current.clear();
    for (const e of edgesRef.current) { e.glowLine.setMap(null); e.solidLine.setMap(null); }
    edgesRef.current = [];
    for (const f of facesRef.current) f.polygon?.setMap(null);
    facesRef.current = [];
    fromIdRef.current = null; snapIdRef.current = null;
    vertexCounterRef.current = 0;
    setFromId(null); setVertexCount(0); setEdgeCount(0); setFaces([]);
    clearPreview();
  }, [clearPreview]);

  // ── Done ──────────────────────────────────────────────────────────────────────

  // First click → enter review mode (show confirm / keep editing)
  const handleDone = useCallback(() => {
    setReviewing(true);
    // Pause map interaction while reviewing
    removeListeners();
  }, [removeListeners]);

  // Confirmed → commit to wizard
  const confirmDone = useCallback(() => {
    onDone(facesRef.current.map(f => ({ path: f.path })));
  }, [onDone]);

  // Back to editing from review
  const backToEditing = useCallback(() => {
    setReviewing(false);
    attachEdgeListeners(outlineRef.current);
  }, [attachEdgeListeners]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  // ── Review / confirm panel ──────────────────────────────────────────────────
  if (reviewing) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-amber-600/40 bg-amber-900/20 p-3 space-y-2">
          <p className="text-xs font-semibold text-amber-300">Review detected segments</p>
          <p className="text-xs text-slate-300 leading-relaxed">
            Check the map. If any edges are missing, go back and complete them before confirming.
          </p>
          <div className="flex flex-col gap-1 mt-1">
            {faces.map((f, i) => (
              <div key={f.id} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: f.color }} />
                Segment {i + 1} — {f.path.length} corners
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={backToEditing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-600 transition-colors"
          >
            <GitBranch size={12} /> Add missing edges
          </button>
          <button
            onClick={confirmDone}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-500 transition-colors ml-auto"
          >
            <Check size={12} /> Confirm {faces.length} segment{faces.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    );
  }

  // ── Normal drawing panel ────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">

      {/* Step tabs */}
      <div className="flex gap-2">
        <button
          onClick={goToVertices}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            step === 'vertices'
              ? 'bg-orange-500 text-white shadow shadow-orange-500/30'
              : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700'
          }`}
        >
          <MousePointer2 size={12} />
          1. Corners
        </button>
        <button
          onClick={goToEdges}
          disabled={vertexCount < 2}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 ${
            step === 'edges'
              ? 'bg-green-600 text-white shadow shadow-green-500/30'
              : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700'
          }`}
        >
          <GitBranch size={12} />
          2. Edges
        </button>
      </div>

      {/* Instructions */}
      {step === 'vertices' && (
        <div className="rounded-xl border border-orange-600/30 bg-orange-900/15 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-orange-300">Step 1 — Place all corner points</p>
          <p className="text-xs text-slate-300 leading-relaxed">
            Click every junction, ridge peak, and corner on the roof.
            Drag dots to reposition. Click a dot to remove it.
          </p>
          <p className="text-xs text-slate-400">
            {vertexCount === 0
              ? 'No corners yet — click the map to start.'
              : `${vertexCount} corner${vertexCount === 1 ? '' : 's'} placed.`}
          </p>
        </div>
      )}

      {step === 'edges' && (
        <div className="rounded-xl border border-green-600/30 bg-green-900/15 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-green-300">Step 2 — Draw edges</p>
          {!fromId ? (
            <p className="text-xs text-slate-300 leading-relaxed">
              Click a corner to start. A glowing line will follow your cursor to the next corner.
            </p>
          ) : (
            <p className="text-xs text-green-200 font-medium leading-relaxed">
              Move cursor to next corner and click to connect.
              Press <kbd className="bg-slate-800 border border-slate-600 px-1 rounded text-[10px] font-mono">Esc</kbd> to deselect.
            </p>
          )}
          <p className="text-xs text-slate-400">
            {edgeCount === 0
              ? 'No edges yet.'
              : `${edgeCount} edge${edgeCount === 1 ? '' : 's'} · ${faces.length} segment${faces.length === 1 ? '' : 's'} detected`}
          </p>
          <p className="text-xs text-slate-500">Tip: click an edge line to delete it.</p>
        </div>
      )}

      {/* Detected segments list */}
      {faces.length > 0 && !reviewing && (
        <div className="rounded-xl border border-blue-700/30 bg-blue-900/10 p-3">
          <p className="text-xs font-semibold text-blue-300 mb-2">
            {faces.length} segment{faces.length === 1 ? '' : 's'} detected
          </p>
          <div className="flex flex-col gap-1">
            {faces.map((f, i) => (
              <div key={f.id} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: f.color }} />
                Segment {i + 1} · {f.path.length} corners
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {vertexCount > 0 && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-800/40 transition-colors"
          >
            <Trash2 size={11} /> Clear all
          </button>
        )}
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-slate-700/60 text-slate-300 hover:bg-slate-700 border border-slate-600/40 transition-colors"
        >
          <X size={11} /> Cancel
        </button>
        {faces.length > 0 && (
          <button
            onClick={handleDone}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors ml-auto"
          >
            <Check size={12} /> Review {faces.length} segment{faces.length === 1 ? '' : 's'} →
          </button>
        )}
      </div>
    </div>
  );
}
