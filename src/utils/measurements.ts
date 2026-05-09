import type { RoofSection } from '../types';

export interface LatLng { lat: number; lng: number }

export interface SectionMeasurements {
  sectionId: string;
  perimeterFt: number;
  edges: number[]; // individual edge lengths in feet
  longestEdgeFt: number;
  shortestEdgeFt: number;
}

export interface RoofMeasurementSummary {
  facets: number;
  totalFlatAreaSqFt: number;
  totalActualAreaSqFt: number;
  totalSquares: number;
  predominantPitch: string;
  totalPerimeterFt: number;
  estimatedEavesFt: number;
  sections: SectionMeasurements[];
}

export function haversineDistanceFt(p1: LatLng, p2: LatLng): number {
  const R = 20902231; // Earth radius in feet
  const φ1 = (p1.lat * Math.PI) / 180;
  const φ2 = (p2.lat * Math.PI) / 180;
  const Δφ = ((p2.lat - p1.lat) * Math.PI) / 180;
  const Δλ = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function computeSectionMeasurements(
  sectionId: string,
  path: LatLng[]
): SectionMeasurements {
  if (path.length < 2) {
    return { sectionId, perimeterFt: 0, edges: [], longestEdgeFt: 0, shortestEdgeFt: 0 };
  }
  const edges: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    edges.push(haversineDistanceFt(a, b));
  }
  const perimeterFt = edges.reduce((s, e) => s + e, 0);
  return {
    sectionId,
    perimeterFt,
    edges,
    longestEdgeFt: Math.max(...edges),
    shortestEdgeFt: Math.min(...edges),
  };
}

export function computeRoofMeasurements(
  sections: Omit<RoofSection, 'polygon'>[]
): RoofMeasurementSummary {
  const sectionMeasurements = sections.map(s =>
    computeSectionMeasurements(s.id, s.polygonPath ?? [])
  );

  const totalPerimeterFt = sectionMeasurements.reduce((sum, m) => sum + m.perimeterFt, 0);
  const totalFlatAreaSqFt = sections.reduce((s, r) => s + r.flatArea, 0);
  const totalActualAreaSqFt = sections.reduce((s, r) => s + r.actualArea, 0);
  const totalSquares = Math.ceil((totalActualAreaSqFt * 1.12) / 100);

  // Predominant pitch = pitch of the largest-area section
  const predominantPitch =
    sections.length === 0
      ? '—'
      : sections.reduce((best, s) => (s.actualArea > best.actualArea ? s : best), sections[0])
          .pitch;

  return {
    facets: sections.length,
    totalFlatAreaSqFt,
    totalActualAreaSqFt,
    totalSquares,
    predominantPitch,
    totalPerimeterFt,
    // Eaves ≈ total external perimeter (good proxy without full topology)
    estimatedEavesFt: totalPerimeterFt,
    sections: sectionMeasurements,
  };
}

export function formatFt(ft: number): string {
  const whole = Math.floor(ft);
  const inches = Math.round((ft - whole) * 12);
  if (inches === 0) return `${whole.toLocaleString()} ft`;
  return `${whole.toLocaleString()} ft ${inches} in`;
}
