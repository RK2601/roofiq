"""
Vercel Python serverless function.
Receives roof segment polygons (local metre coords), uses Shapely to:
  1. Simplify edges
  2. Detect shared edges — exact boundary intersection + edge-pair proximity fallback
  3. Return union outline (single clean perimeter)
"""
from http.server import BaseHTTPRequestHandler
import json
import math

try:
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    SHAPELY_OK = True
except ImportError:
    SHAPELY_OK = False


def _cors(h):
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")


def extract_lines(geom):
    if geom is None or geom.is_empty:
        return []
    t = geom.geom_type
    if t == 'LineString':
        return [geom]
    if t in ('MultiLineString', 'GeometryCollection'):
        out = []
        for g in geom.geoms:
            out.extend(extract_lines(g))
        return out
    return []


def edge_pair_shared(ci, cj, gap_tol=5.0, min_len=0.5, max_angle_deg=60):
    """
    For each edge in ci, find edges in cj that are:
      - parallel within max_angle_deg
      - within gap_tol perpendicularly
      - have significant projection overlap
    Returns list of [[x1,y1],[x2,y2]] shared segment coords (on ci's edge).
    """
    results = []
    ni, nj = len(ci), len(cj)
    cos_thresh = math.cos(math.radians(max_angle_deg))

    for a in range(ni):
        ax1, ay1 = ci[a]
        ax2, ay2 = ci[(a + 1) % ni]
        ea_len = math.hypot(ax2 - ax1, ay2 - ay1)
        if ea_len < min_len:
            continue
        edx, edy = (ax2 - ax1) / ea_len, (ay2 - ay1) / ea_len
        nx, ny = -edy, edx

        for b in range(nj):
            bx1, by1 = cj[b]
            bx2, by2 = cj[(b + 1) % nj]
            eb_len = math.hypot(bx2 - bx1, by2 - by1)
            if eb_len < min_len:
                continue
            fbdx, fbdy = (bx2 - bx1) / eb_len, (by2 - by1) / eb_len

            if abs(edx * fbdx + edy * fbdy) < cos_thresh:
                continue

            dist = abs((bx1 - ax1) * nx + (by1 - ay1) * ny)
            if dist > gap_tol:
                continue

            p_a1, p_a2 = 0.0, ea_len
            p_b1 = (bx1 - ax1) * edx + (by1 - ay1) * edy
            p_b2 = (bx2 - ax1) * edx + (by2 - ay1) * edy
            ov_s = max(min(p_a1, p_a2), min(p_b1, p_b2))
            ov_e = min(max(p_a1, p_a2), max(p_b1, p_b2))
            if ov_e - ov_s < min_len:
                continue

            ox1 = ax1 + ov_s * edx
            oy1 = ay1 + ov_s * edy
            ox2 = ax1 + ov_e * edx
            oy2 = ay1 + ov_e * edy
            results.append([[ox1, oy1], [ox2, oy2]])

    return results


def compute(segments):
    if not SHAPELY_OK:
        return {"segments": segments, "sharedEdges": [], "error": "shapely not installed"}

    # ── 1. Build polygons ────────────────────────────────────────────────
    polys = {}
    for seg in segments:
        pts = [(p["x"], p["y"]) for p in seg["path"]]
        if len(pts) >= 3:
            try:
                p = Polygon(pts).buffer(0)
                if p.is_valid and not p.is_empty:
                    polys[seg["id"]] = p
            except Exception:
                pass

    ids = list(polys.keys())

    # ── 2. Simplify ──────────────────────────────────────────────────────
    for id_ in list(polys.keys()):
        try:
            s = polys[id_].simplify(0.5, preserve_topology=True)
            if s.is_valid and not s.is_empty and len(s.exterior.coords) >= 4:
                polys[id_] = s
        except Exception:
            pass

    # ── 3. Shared edges ──────────────────────────────────────────────────
    # Guards: A (overlap) + C (opposite sides via representative_point).
    # Facing-direction guard removed — incorrectly filters real edges when
    # facing metadata is absent or inaccurate.

    shared_edges = []
    seen = set()

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            id_i, id_j = ids[i], ids[j]
            pi, pj = polys[id_i], polys[id_j]

            # Guard A: significantly overlapping polygons
            try:
                ov = pi.intersection(pj).area
                min_a = min(pi.area, pj.area)
                if min_a > 0 and ov / min_a > 0.05:
                    continue
            except Exception:
                pass

            # Pass 1: exact boundary intersection
            candidates = []
            try:
                exact = pi.boundary.intersection(pj.boundary)
                for line in extract_lines(exact):
                    if line.length >= 0.5:
                        candidates.append([[c[0], c[1]] for c in line.coords])
            except Exception:
                pass

            # Pass 2: edge-pair proximity fallback — run both directions
            if not candidates:
                ci_coords = list(pi.exterior.coords)[:-1]
                cj_coords = list(pj.exterior.coords)[:-1]
                candidates = edge_pair_shared(ci_coords, cj_coords)
                candidates += edge_pair_shared(cj_coords, ci_coords)

            for seg_coords in candidates:
                if len(seg_coords) < 2:
                    continue
                ax1, ay1 = seg_coords[0]
                ax2, ay2 = seg_coords[-1]
                if math.hypot(ax2 - ax1, ay2 - ay1) < 0.5:
                    continue

                key = (round(ax1, 1), round(ay1, 1), round(ax2, 1), round(ay2, 1))
                rkey = (round(ax2, 1), round(ay2, 1), round(ax1, 1), round(ay1, 1))
                if key in seen or rkey in seen:
                    continue
                seen.add(key)

                shared_edges.append({
                    "ids": [id_i, id_j],
                    "coords": seg_coords,
                })

    # ── 4. Union outline ─────────────────────────────────────────────────
    outlines = []
    try:
        union = unary_union([polys[id_] for id_ in ids if id_ in polys])
        union = union.buffer(0.2).buffer(-0.2)
        geoms = list(union.geoms) if union.geom_type == "MultiPolygon" else [union]
        for g in geoms:
            if g.geom_type == "Polygon" and not g.is_empty:
                outlines.append([list(c) for c in list(g.exterior.coords)[:-1]])
    except Exception:
        pass

    # ── 5. Return ─────────────────────────────────────────────────────────
    result_segs = []
    for seg in segments:
        sid = seg["id"]
        if sid in polys:
            coords = list(polys[sid].exterior.coords)[:-1]
            result_segs.append({
                "id": sid,
                "path": [{"x": c[0], "y": c[1]} for c in coords],
            })
        else:
            result_segs.append({"id": sid, "path": seg["path"]})

    return {"segments": result_segs, "sharedEdges": shared_edges, "outlines": outlines}


class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        _cors(self)
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            result = compute(body.get("segments", []))
            status = 200
        except Exception as e:
            result = {"segments": [], "sharedEdges": [], "error": str(e)}
            status = 500

        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        _cors(self)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass
