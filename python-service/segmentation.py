"""
Roof plane segmentation via iterative RANSAC on an Open3D point cloud.

Returns:
    planes     : list of dicts with pitch_deg, pitch_ratio, facing, area_rel, point_count
    inlier_sets: list of lists of point indices (aligned with planes)
"""

import logging
import numpy as np

logger = logging.getLogger(__name__)

# --- tuning knobs ---------------------------------------------------------
MAX_PLANES = 8
RANSAC_DISTANCE_THRESHOLD = 0.02   # in normalised depth units
RANSAC_N = 3                        # min points to fit a plane
RANSAC_ITERATIONS = 1000
MIN_INLIER_FRACTION = 0.03          # skip planes with < 3% of remaining points
MAX_PITCH_DEG = 72                  # steeper than this → wall, skip
# --------------------------------------------------------------------------


def _normal_to_pitch_facing(nx: float, ny: float, nz: float) -> tuple[float, str]:
    """
    Convert a unit plane normal → (pitch_degrees, cardinal_facing).

    Convention (Open3D / our pipeline):
        x = right, y = down, z = away-from-camera
    The plane normal for an upward-facing surface points in -y direction
    (y = down, so a roof normal tilted toward -y is "up").

    pitch_degrees: 0° = flat, 90° = vertical wall.
    """
    # Ensure unit normal
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    if length < 1e-9:
        return 0.0, "N"
    nx, ny, nz = nx / length, ny / length, nz / length

    # Flip if pointing downward (into the scene) so normals face camera
    if ny > 0:
        nx, ny, nz = -nx, -ny, -nz

    # Pitch = angle between normal and vertical (y axis, flipped)
    cos_pitch = abs(ny)
    pitch_deg = float(np.degrees(np.arccos(np.clip(cos_pitch, 0.0, 1.0))))

    # Facing: project normal onto XZ plane and find cardinal direction
    # x > 0 → east, z > 0 → away (south in camera coords)
    if abs(nx) < 0.15 and abs(nz) < 0.15:
        facing = "Flat"
    else:
        angle_xz = float(np.degrees(np.arctan2(nx, nz)))  # 0 = towards camera (N), 90 = E
        dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        idx = int((angle_xz + 180 + 22.5) / 45) % 8
        facing = dirs[idx]

    return pitch_deg, facing


def segment_roof_planes(
    pcd,
    max_planes: int = MAX_PLANES,
) -> tuple[list[dict], list[list[int]]]:
    """
    Iteratively segment planar surfaces from the point cloud using RANSAC.

    Returns (planes_meta, inlier_sets):
        planes_meta  : list of dicts, sorted by point count desc
        inlier_sets  : parallel list of point index arrays
    """
    import open3d as o3d

    remaining = pcd
    remaining_indices = list(range(len(pcd.points)))  # maps local → original index

    planes_meta: list[dict] = []
    inlier_sets: list[list[int]] = []

    total_points = len(pcd.points)
    if total_points == 0:
        return [], []

    for iteration in range(max_planes):
        if len(remaining.points) < RANSAC_N * 10:
            break

        plane_model, local_inliers = remaining.segment_plane(
            distance_threshold=RANSAC_DISTANCE_THRESHOLD,
            ransac_n=RANSAC_N,
            num_iterations=RANSAC_ITERATIONS,
        )

        if len(local_inliers) < MIN_INLIER_FRACTION * len(remaining.points):
            logger.info("Plane %d: too few inliers (%d), stopping", iteration, len(local_inliers))
            break

        nx, ny, nz, _d = plane_model
        pitch_deg, facing = _normal_to_pitch_facing(nx, ny, nz)

        if pitch_deg > MAX_PITCH_DEG:
            logger.info("Plane %d: pitch %.1f° > %.1f° — wall, skipping", iteration, pitch_deg, MAX_PITCH_DEG)
            # Still remove inliers so RANSAC can find the next plane
            outlier_mask = np.ones(len(remaining.points), dtype=bool)
            outlier_mask[local_inliers] = False
            remaining_indices = [remaining_indices[i] for i in range(len(remaining_indices)) if outlier_mask[i]]
            remaining = remaining.select_by_index(
                [i for i in range(len(remaining.points)) if outlier_mask[i]]
            )
            continue

        # Map local inlier indices → original point cloud indices
        original_inliers = [remaining_indices[i] for i in local_inliers]

        # Pitch ratio (rise/run) = tan(pitch)
        pitch_ratio = round(float(np.tan(np.radians(pitch_deg))), 3)

        area_rel = round(len(local_inliers) / total_points, 4)

        planes_meta.append({
            "plane_id": len(planes_meta),
            "pitch_deg": round(pitch_deg, 1),
            "pitch_ratio": pitch_ratio,
            "facing": facing,
            "area_rel": area_rel,
            "point_count": len(local_inliers),
            "normal": [round(nx, 4), round(ny, 4), round(nz, 4)],
        })
        inlier_sets.append(original_inliers)

        logger.info(
            "Plane %d: pitch=%.1f° facing=%s inliers=%d (%.1f%% of cloud)",
            len(planes_meta) - 1,
            pitch_deg,
            facing,
            len(local_inliers),
            100.0 * len(local_inliers) / total_points,
        )

        # Remove inliers and continue searching for next plane
        outlier_mask = np.ones(len(remaining.points), dtype=bool)
        outlier_mask[local_inliers] = False
        remaining_indices = [remaining_indices[i] for i in range(len(remaining_indices)) if outlier_mask[i]]
        remaining = remaining.select_by_index(
            [i for i in range(len(remaining.points)) if outlier_mask[i]]
        )

    # Sort by point count (largest roof face first)
    paired = sorted(zip(planes_meta, inlier_sets), key=lambda p: p[0]["point_count"], reverse=True)
    if paired:
        planes_meta, inlier_sets = zip(*paired)
        return list(planes_meta), list(inlier_sets)

    return [], []
