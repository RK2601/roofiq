"""
Core depth pipeline:
  1. Depth estimation via Replicate (Depth Anything V2)
  2. Point cloud construction from depth map + estimated camera intrinsics
  3. Mesh generation using Open3D Poisson surface reconstruction
  4. Roof plane segmentation (see segmentation.py)
  5. Colourised overlay and depth-map images returned as base64
"""

import base64
import io
import time
import logging
import os
import urllib.request

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Depth Anything V2 via Replicate
# ---------------------------------------------------------------------------

# Pinned version — update if Replicate retires it
DEPTH_MODEL = "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4"

# Pixel budget: resize input if larger to keep inference fast & memory safe
MAX_SIDE_PX = 640


def _get_depth_map(image_bytes: bytes, replicate_token: str) -> tuple[np.ndarray, Image.Image]:
    """
    Send image to Replicate and return (depth_array float32 [0,1], resized PIL image).
    depth_array: higher value = closer to camera (Depth Anything convention).
    """
    import replicate  # installed via requirements.txt

    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = pil.size

    # Resize if oversized
    if max(w, h) > MAX_SIDE_PX:
        scale = MAX_SIDE_PX / max(w, h)
        pil = pil.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        w, h = pil.size
        logger.info("Resized image to %dx%d", w, h)

    # Re-encode as JPEG for upload
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    buf.seek(0)

    client = replicate.Client(api_token=replicate_token)
    t0 = time.time()
    output = client.run(DEPTH_MODEL, input={"image": buf})
    logger.info("Replicate depth inference: %.1fs", time.time() - t0)

    # output may be a dict (e.g. {'color_depth': url, 'depth': url}) or a direct URL
    if isinstance(output, dict):
        depth_url = str(output.get("depth") or output.get("color_depth") or next(iter(output.values())))
    else:
        depth_url = str(output)
    req = urllib.request.Request(depth_url, headers={"User-Agent": "RoofIQ/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        depth_bytes = resp.read()

    depth_pil = Image.open(io.BytesIO(depth_bytes)).convert("L")  # greyscale
    depth_pil = depth_pil.resize((w, h), Image.BILINEAR)
    depth_arr = np.array(depth_pil).astype(np.float32) / 255.0  # [0, 1]

    return depth_arr, pil


# ---------------------------------------------------------------------------
# Point cloud construction
# ---------------------------------------------------------------------------

def _depth_to_pointcloud(depth: np.ndarray, rgb: np.ndarray):
    """
    Project depth map to 3D point cloud using estimated pinhole camera intrinsics.

    We assume a 70° horizontal FoV (reasonable for phone/drone cameras).
    Depth values are relative [0,1]; we invert so near=small-z, far=large-z.

    Returns:
        pcd : open3d.geometry.PointCloud
        pixel_index : ndarray shape (H*W,) mapping flat pixel index → point index (-1 if filtered)
    """
    import open3d as o3d

    h, w = depth.shape
    fx = fy = w / (2 * np.tan(np.radians(35)))  # 70° FoV → f = w/(2*tan(35°))
    cx, cy = w / 2.0, h / 2.0

    # Invert depth (Depth Anything: bright=near) so z increases away from camera
    z = 1.0 - depth.astype(np.float64) + 1e-4

    u, v = np.meshgrid(np.arange(w), np.arange(h))
    x = (u - cx) * z / fx
    y = (v - cy) * z / fy

    points = np.stack([x, y, z], axis=-1).reshape(-1, 3)
    colors = rgb.reshape(-1, 3).astype(np.float64) / 255.0

    valid_mask = np.isfinite(points).all(axis=1) & (z.reshape(-1) > 0)
    valid_indices = np.where(valid_mask)[0]

    # Map flat pixel index → point cloud index
    pixel_index = np.full(h * w, -1, dtype=np.int64)
    pixel_index[valid_indices] = np.arange(len(valid_indices))

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points[valid_mask])
    pcd.colors = o3d.utility.Vector3dVector(colors[valid_mask])

    # Voxel downsample to ~20 k points for faster processing
    target_voxel = max(0.003, np.sqrt(1.0 / max(1, len(valid_indices) / 20_000)))
    pcd = pcd.voxel_down_sample(voxel_size=target_voxel)
    logger.info("Point cloud: %d points (voxel=%.4f)", len(pcd.points), target_voxel)

    return pcd, pixel_index


# ---------------------------------------------------------------------------
# Mesh generation (Poisson reconstruction)
# ---------------------------------------------------------------------------

def _build_mesh(pcd):
    """
    Estimate normals and run Poisson surface reconstruction.
    Returns the cleaned TriangleMesh.
    """
    import open3d as o3d

    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.05, max_nn=30)
    )
    # Orient normals consistently — critical for Poisson quality
    pcd.orient_normals_consistent_tangent_plane(k=30)

    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=9, scale=1.1, linear_fit=False
    )

    # Remove low-density vertices (noise / artefacts at mesh boundary)
    densities_np = np.asarray(densities)
    keep_threshold = np.quantile(densities_np, 0.05)
    verts_to_remove = densities_np < keep_threshold
    mesh.remove_vertices_by_mask(verts_to_remove)
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_unreferenced_vertices()

    logger.info(
        "Mesh: %d vertices, %d triangles",
        len(mesh.vertices),
        len(mesh.triangles),
    )
    return mesh


# ---------------------------------------------------------------------------
# Visualisation helpers
# ---------------------------------------------------------------------------

_TURBO = None

def _turbo_colormap(x: np.ndarray) -> np.ndarray:
    """Vectorised Turbo colormap without matplotlib dependency."""
    global _TURBO
    if _TURBO is None:
        # 256-entry Turbo LUT (Google Brain, public domain)
        lut = np.array([
            [48,18,59],[50,21,67],[51,24,74],[52,27,81],[53,30,88],[54,33,95],[55,36,102],
            [56,39,109],[57,42,115],[58,45,121],[59,47,128],[60,50,134],[61,53,139],
            [62,56,145],[63,59,150],[63,62,156],[64,64,161],[65,67,166],[65,70,171],
            [66,73,176],[66,75,181],[67,78,186],[68,81,191],[68,84,195],[68,86,200],
            [69,89,204],[69,92,208],[70,94,213],[70,97,217],[70,100,221],[70,102,225],
            [70,105,228],[71,108,232],[71,110,235],[71,113,238],[71,115,241],[71,118,244],
            [71,120,247],[71,123,250],[70,125,252],[70,128,255],[70,130,255],[69,133,255],
            [69,135,255],[68,138,255],[67,140,255],[67,143,255],[66,145,255],[65,148,255],
            [64,150,255],[63,153,255],[62,155,255],[62,158,255],[61,160,255],[60,163,255],
            [59,165,255],[58,168,255],[57,170,255],[56,172,255],[55,175,254],[54,177,253],
            [53,180,252],[52,182,251],[51,185,250],[51,187,248],[50,190,247],[49,192,246],
            [48,195,244],[47,197,243],[46,200,241],[46,202,239],[45,205,237],[44,207,235],
            [43,209,233],[43,212,231],[42,214,229],[41,216,227],[41,219,224],[40,221,222],
            [40,223,220],[39,226,217],[39,228,215],[39,230,212],[38,232,210],[38,234,207],
            [38,236,204],[38,238,202],[38,240,199],[38,242,196],[38,244,193],[38,246,190],
            [38,247,188],[38,249,185],[38,251,182],[39,252,179],[39,254,176],[40,255,173],
            [41,255,170],[42,255,167],[43,255,164],[45,255,161],[46,254,158],[48,252,155],
            [50,251,152],[51,249,149],[53,247,146],[55,246,143],[57,244,140],[59,242,137],
            [61,240,134],[63,238,131],[65,236,128],[68,234,125],[70,232,122],[72,230,119],
            [74,228,116],[76,226,113],[79,224,110],[81,222,107],[83,220,104],[85,218,101],
            [88,216,98],[90,214,95],[92,212,92],[95,210,89],[97,208,86],[99,206,83],
            [101,204,80],[104,202,77],[106,200,74],[108,198,72],[111,196,69],[113,194,66],
            [115,192,63],[118,190,60],[120,188,57],[122,186,55],[125,183,52],[127,181,49],
            [129,179,46],[132,177,44],[134,175,41],[136,173,38],[139,171,36],[141,169,33],
            [143,167,30],[146,164,28],[148,162,25],[150,160,23],[153,158,20],[155,156,18],
            [157,154,15],[160,151,13],[162,149,10],[164,147,8],[167,145,6],[169,142,4],
            [171,140,2],[174,138,1],[176,135,0],[178,133,0],[181,130,0],[183,128,0],
            [185,126,0],[188,123,0],[190,121,0],[192,118,0],[195,116,0],[197,113,0],
            [199,111,0],[202,108,0],[204,106,0],[206,103,0],[209,100,0],[211,98,0],
            [213,95,0],[215,93,0],[218,90,0],[220,87,0],[222,85,0],[224,82,0],
            [226,80,0],[229,77,0],[231,74,0],[233,72,0],[235,69,0],[237,66,0],
            [239,64,0],[241,61,0],[243,58,0],[245,56,0],[247,53,0],[248,50,0],
            [250,48,0],[252,45,0],[253,43,0],[254,41,0],[255,38,0],[255,36,0],
            [255,34,0],[255,31,0],[255,29,0],[255,27,0],[254,24,0],[253,22,0],
            [252,20,0],[251,17,0],[250,15,0],[249,13,0],[248,10,0],[246,8,0],
            [244,6,0],[242,4,0],[240,2,0],[238,0,0],[235,0,0],[233,0,0],
            [230,0,0],[227,0,0],[224,0,0],[221,0,0],[218,0,0],[215,0,0],
            [212,0,0],[209,0,0],[205,0,0],[202,0,0],[198,0,0],[195,0,0],
            [192,0,0],[188,0,0],[185,0,0],[181,0,0],[177,0,0],[174,0,0],
            [170,0,0],[166,0,0],[163,0,0],[159,0,0],[155,0,0],[151,0,0],
            [148,0,0],[144,0,0],[140,0,0],[136,0,0],[132,0,0],[128,0,0],
        ], dtype=np.uint8)
        _TURBO = lut

    idx = np.clip((x * (len(_TURBO) - 1)).astype(np.int32), 0, len(_TURBO) - 1)
    return _TURBO[idx]


def _depth_to_b64(depth: np.ndarray) -> str:
    colored = _turbo_colormap(depth)
    img = Image.fromarray(colored.astype(np.uint8), mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


PLANE_PALETTE = [
    (255, 80, 80),   # red
    (80, 160, 255),  # blue
    (80, 220, 80),   # green
    (255, 200, 50),  # yellow
    (180, 80, 255),  # purple
    (80, 220, 200),  # teal
    (255, 140, 80),  # orange
    (255, 80, 200),  # pink
]


def _build_overlay(pil_image: Image.Image, plane_pixel_masks: list[np.ndarray]) -> str:
    """
    Blend each plane mask with a distinct colour onto the original image (50% alpha).
    Returns base64 JPEG.
    """
    base = np.array(pil_image).astype(np.float32)
    overlay = base.copy()

    for i, mask in enumerate(plane_pixel_masks):
        colour = np.array(PLANE_PALETTE[i % len(PLANE_PALETTE)], dtype=np.float32)
        overlay[mask] = overlay[mask] * 0.45 + colour * 0.55

    blended = np.clip(overlay, 0, 255).astype(np.uint8)
    img = Image.fromarray(blended)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def run_depth_pipeline(image_bytes: bytes, replicate_token: str) -> dict:
    from segmentation import segment_roof_planes

    t_start = time.time()

    # Step 1 — Depth estimation
    depth_arr, pil_image = _get_depth_map(image_bytes, replicate_token)
    rgb_arr = np.array(pil_image)
    h, w = depth_arr.shape

    # Step 2 — Point cloud
    pcd, pixel_index = _depth_to_pointcloud(depth_arr, rgb_arr)

    # Step 3 — Mesh (Poisson reconstruction)
    mesh = _build_mesh(pcd)

    # Step 4 — Roof plane segmentation (returns planes + inlier point indices)
    planes, inlier_sets = segment_roof_planes(pcd)

    # Step 5 — Build 2D pixel masks for each plane (for overlay visualisation)
    plane_pixel_masks: list[np.ndarray] = []
    for inliers in inlier_sets:
        inlier_set = set(inliers)
        # Map point cloud indices back to pixel indices
        mask = np.zeros(h * w, dtype=bool)
        for pix_idx in range(h * w):
            pt_idx = pixel_index[pix_idx]
            if pt_idx >= 0 and int(pt_idx) in inlier_set:
                mask[pix_idx] = True
        plane_pixel_masks.append(mask.reshape(h, w))

    # Step 6 — Visualisations
    depth_b64 = _depth_to_b64(depth_arr)
    overlay_b64 = _build_overlay(pil_image, plane_pixel_masks) if plane_pixel_masks else None

    elapsed = time.time() - t_start
    logger.info("Total pipeline time: %.1fs", elapsed)

    return {
        "planes": planes,
        "dominant_pitch": planes[0]["pitch_ratio"] if planes else "unknown",
        "dominant_facing": planes[0]["facing"] if planes else "unknown",
        "depth_map_b64": depth_b64,
        "overlay_b64": overlay_b64,
        "stats": {
            "image_size": {"width": w, "height": h},
            "total_points": len(pcd.points),
            "mesh_vertices": len(mesh.vertices),
            "mesh_triangles": len(mesh.triangles),
            "planes_detected": len(planes),
            "elapsed_seconds": round(elapsed, 1),
        },
    }
