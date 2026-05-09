import type { SolarDataLayersResponse, SolarRoofSegment } from './solar';

export type HeightSource = 'dsm' | 'solar-plane' | 'none';

export interface HeightModel {
  source: HeightSource;
  hasHeightData: boolean;
  quality: number; // 0..1
  meanPlaneHeightMeters: number | null;
  planeHeightVariationMeters: number | null;
  notes: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildHeightModel(
  segments: SolarRoofSegment[],
  dataLayers: SolarDataLayersResponse | null
): HeightModel {
  const planeHeights = segments
    .map(segment => segment.planeHeightAtCenterMeters)
    .filter((value): value is number => typeof value === 'number');

  const hasDsm = !!dataLayers?.dsmUrl;
  if (hasDsm) {
    const mean =
      planeHeights.length > 0
        ? planeHeights.reduce((sum, value) => sum + value, 0) / planeHeights.length
        : null;
    const variation =
      planeHeights.length > 1
        ? Math.max(...planeHeights) - Math.min(...planeHeights)
        : null;
    const planeSupport = planeHeights.length === 0 ? 0.25 : clamp(planeHeights.length / Math.max(segments.length, 1), 0.25, 1);
    return {
      source: 'dsm',
      hasHeightData: true,
      quality: clamp(0.75 + 0.25 * planeSupport, 0, 1),
      meanPlaneHeightMeters: mean,
      planeHeightVariationMeters: variation,
      notes: ['DSM layer URL available from Solar dataLayers endpoint.'],
    };
  }

  if (planeHeights.length > 0) {
    const mean = planeHeights.reduce((sum, value) => sum + value, 0) / planeHeights.length;
    const variation =
      planeHeights.length > 1 ? Math.max(...planeHeights) - Math.min(...planeHeights) : 0;
    return {
      source: 'solar-plane',
      hasHeightData: true,
      quality: clamp(0.45 + (planeHeights.length / Math.max(segments.length, 1)) * 0.3, 0, 0.78),
      meanPlaneHeightMeters: mean,
      planeHeightVariationMeters: variation,
      notes: ['Using planeHeightAtCenterMeters from Solar roof segments.'],
    };
  }

  return {
    source: 'none',
    hasHeightData: false,
    quality: 0.2,
    meanPlaneHeightMeters: null,
    planeHeightVariationMeters: null,
    notes: ['No DSM URL and no plane heights found in roof segments.'],
  };
}
