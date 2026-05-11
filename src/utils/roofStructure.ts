import {
  azimuthLabel,
  pitchDegreesToOption,
  haversineDistanceMeters,
  type SolarLatLng,
  type SolarRoofSegment,
} from './solar';
import { pitchStringToPitchDegrees } from './roofCalculations';
import type { HeightModel } from './heightModel';

const METERS_PER_DEG_LAT = 111_320;
const M2FT = 3.28084;
const M2SQFT = 10.76391;
const FLAT_PITCH_THRESHOLD_DEG = 2;
const BBOX_ADJACENCY_THRESHOLD_M = 2.5;
const LAYOUT_PX_PER_FT = 4;
const LAYOUT_PADDING_PX = 40;
const LAYOUT_GAP_PX = 20;

export type Vec2 = { x: number; y: number };
export type FacetSide = 'top' | 'bottom' | 'left' | 'right';
export type EdgeKind = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake' | 'step';
export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface AiRoofCue {
  type: 'ridge' | 'hip' | 'valley' | 'eave' | 'rake';
  p1: Vec2;
  p2: Vec2;
  confidence: number;
}

export interface RoofStructureContext {
  imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
  hasDsm?: boolean;
  heightModel?: HeightModel;
  aiCues?: AiRoofCue[];
}

export interface ConfidenceBreakdown {
  overall: number;
  imagery: number;
  topology: number;
  height: number;
  aiAgreement: number;
  segmentCoverage: number;
}

export interface QualityFlag {
  code:
    | 'LOW_IMAGERY'
    | 'SPARSE_SEGMENTS'
    | 'NO_HEIGHT_DATA'
    | 'TOPOLOGY_INCONSISTENT'
    | 'HIGH_STEP_RATIO'
    | 'AI_DISAGREEMENT';
  message: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface DataSourceMeta {
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  hasSolarSegments: boolean;
  hasDsm: boolean;
  heightSource?: HeightModel['source'];
  heightQuality?: number;
  hasAiCues: boolean;
  sourceTimestampIso: string;
}

export interface FacetEdge {
  kind: EdgeKind;
  lengthFt: number;
  side: FacetSide;
  adjacentFacetIndex: number | null;
  confidence: number;
}

export interface RoofFacet {
  index: number;
  pitchDegrees: number;
  azimuthDegrees: number;
  pitchLabel: string;
  facingLabel: string;
  actualAreaSqFt: number;
  groundAreaSqFt: number;
  centroidMeters: Vec2;
  bboxMeters: {
    sw: Vec2;
    ne: Vec2;
    corners: Vec2[];
  };
  slopeDir: Vec2;
  perpDir: Vec2;
  groundRunFt: number;
  widthFt: number;
  slopedLengthFt: number;
  planeHeightAtCenterMeters?: number;
  edges: FacetEdge[];
  /** Map-traced section only: polygon vertices in meters (building frame) for diagram fidelity. */
  diagramFootprintMeters?: Vec2[];
}

export interface RoofStructureMeasurements {
  facetCount: number;
  predominantPitch: string;
  totalRoofAreaSqFt: number;
  totalPitchedAreaSqFt: number;
  totalFlatAreaSqFt: number;
  totalGroundAreaSqFt: number;
  totalSquares: number;
  totalRidgeFt: number;
  totalHipFt: number;
  totalValleyFt: number;
  totalEaveFt: number;
  totalRakeFt: number;
  hipsAndRidgesFt: number;
  eavesAndRakesFt: number;
}

export interface UnfoldedFacetPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  rotationDeg: number;
  /** When set, diagram fill uses this closed polygon in local px (0…w, 0…h) instead of a rectangle. */
  outlinePx?: { x: number; y: number }[];
}

export interface RoofStructureFacet extends RoofFacet {
  placement: UnfoldedFacetPlacement;
}

export interface RoofStructureAnalysis {
  version: 'v2';
  facets: RoofStructureFacet[];
  measurements: RoofStructureMeasurements;
  confidenceBand: ConfidenceBand;
  confidence: ConfidenceBreakdown;
  qualityFlags: QualityFlag[];
  dataSources: DataSourceMeta;
  aiCuesUsed?: AiRoofCue[];
  review?: {
    reviewed: boolean;
    reviewedAtIso?: string;
    reviewerNote?: string;
    editsCount?: number;
  };
  notes: string[];
  svg: {
    viewBox: string;
    width: number;
    height: number;
    pxPerFt: number;
  };
}

interface PairAdjacency {
  i: number;
  j: number;
  sideI: FacetSide;
  sideJ: FacetSide;
  sharedLengthFt: number;
  kind: Exclude<EdgeKind, 'eave' | 'rake'>;
  confidence: number;
}

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

function latLngToMeters(point: SolarLatLng, origin: SolarLatLng): Vec2 {
  return {
    x: (point.longitude - origin.longitude) * metersPerDegLng(origin.latitude),
    y: (point.latitude - origin.latitude) * METERS_PER_DEG_LAT,
  };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smallestAngleDiff(aDeg: number, bDeg: number): number {
  const raw = Math.abs(((aDeg - bDeg + 540) % 360) - 180);
  return raw > 180 ? 360 - raw : raw;
}

function expandBbox(
  bbox: RoofFacet['bboxMeters'],
  expandByMeters: number
): { sw: Vec2; ne: Vec2 } {
  return {
    sw: { x: bbox.sw.x - expandByMeters, y: bbox.sw.y - expandByMeters },
    ne: { x: bbox.ne.x + expandByMeters, y: bbox.ne.y + expandByMeters },
  };
}

function bboxesIntersect(a: { sw: Vec2; ne: Vec2 }, b: { sw: Vec2; ne: Vec2 }): boolean {
  return a.sw.x <= b.ne.x && a.ne.x >= b.sw.x && a.sw.y <= b.ne.y && a.ne.y >= b.sw.y;
}

function inferContactSide(from: RoofFacet, to: RoofFacet): FacetSide {
  const relative: Vec2 = {
    x: to.centroidMeters.x - from.centroidMeters.x,
    y: to.centroidMeters.y - from.centroidMeters.y,
  };
  const alongSlope = dot(relative, from.slopeDir);
  const alongPerp = dot(relative, from.perpDir);
  if (Math.abs(alongSlope) > Math.abs(alongPerp)) {
    return alongSlope > 0 ? 'bottom' : 'top';
  }
  return alongPerp > 0 ? 'right' : 'left';
}

function classifyPair(
  a: RoofFacet,
  b: RoofFacet,
  context?: RoofStructureContext
): { kind: PairAdjacency['kind']; confidence: number } {
  const azDiff = smallestAngleDiff(a.azimuthDegrees, b.azimuthDegrees);
  const heightDiff = Math.abs((a.planeHeightAtCenterMeters ?? 0) - (b.planeHeightAtCenterMeters ?? 0));
  const hasDsm = !!context?.hasDsm || context?.heightModel?.source === 'dsm';
  const heightQuality = context?.heightModel?.quality ?? (hasDsm ? 0.9 : 0.35);
  const stepThreshold = hasDsm ? 0.45 : 0.75;

  if (azDiff >= 150) {
    return { kind: 'ridge', confidence: clamp((azDiff - 150) / 30, 0.4, 1) };
  }
  if (azDiff >= 60) {
    return { kind: 'hip', confidence: clamp(1 - Math.abs(90 - azDiff) / 45, 0.35, 1) };
  }
  if (heightDiff < stepThreshold) {
    return { kind: 'step', confidence: clamp(0.35 + 0.25 * heightQuality, 0.35, 0.7) };
  }
  return { kind: 'valley', confidence: clamp(heightDiff / 3 + 0.2 * heightQuality, 0.4, 1) };
}

function findNearestSolarSegmentByPathCentroid(
  path: { lat: number; lng: number }[],
  segments: SolarRoofSegment[]
): SolarRoofSegment | null {
  if (segments.length === 0) return null;
  const cLat = path.reduce((s, p) => s + p.lat, 0) / path.length;
  const cLng = path.reduce((s, p) => s + p.lng, 0) / path.length;
  const from: SolarLatLng = { latitude: cLat, longitude: cLng };
  let best = segments[0]!;
  let bestD = Infinity;
  for (const seg of segments) {
    const d = haversineDistanceMeters(from, seg.center);
    if (d < bestD) {
      bestD = d;
      best = seg;
    }
  }
  return best;
}

/** User-traced polygon footprint in meters + Solar hints for pitch/azimuth (not Solar bbox quads). */
function buildRoofFacetFromDrawnSection(
  path: { lat: number; lng: number }[],
  index: number,
  buildingCenter: SolarLatLng,
  flatAreaSqFt: number,
  actualAreaSqFt: number,
  nearest: SolarRoofSegment | null,
  userPitch: string
): RoofFacet {
  const pitchDegrees = nearest?.pitchDegrees ?? pitchStringToPitchDegrees(userPitch);
  const azimuthDegrees = nearest?.azimuthDegrees ?? 180;

  const corners = path.map(p => latLngToMeters({ latitude: p.lat, longitude: p.lng }, buildingCenter));
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const sw: Vec2 = { x: Math.min(...xs), y: Math.min(...ys) };
  const ne: Vec2 = { x: Math.max(...xs), y: Math.max(...ys) };

  const cLat = path.reduce((s, p) => s + p.lat, 0) / path.length;
  const cLng = path.reduce((s, p) => s + p.lng, 0) / path.length;
  const centroidMeters = latLngToMeters({ latitude: cLat, longitude: cLng }, buildingCenter);

  const azimuthRad = (azimuthDegrees * Math.PI) / 180;
  const slopeDir = { x: Math.sin(azimuthRad), y: Math.cos(azimuthRad) };
  const perpDir = { x: Math.cos(azimuthRad), y: -Math.sin(azimuthRad) };

  const slopeProjections = corners.map(corner => dot(corner, slopeDir));
  const perpProjections = corners.map(corner => dot(corner, perpDir));

  const groundRunM = Math.max(0.05, Math.max(...slopeProjections) - Math.min(...slopeProjections));
  const widthM = Math.max(0.05, Math.max(...perpProjections) - Math.min(...perpProjections));
  const pitchRad = (pitchDegrees * Math.PI) / 180;
  const safeCosPitch = Math.max(Math.cos(pitchRad), 0.05);
  const slopedLengthM = groundRunM / safeCosPitch;

  const pitchOption = pitchDegreesToOption(pitchDegrees);
  const groundAreaSqFt = flatAreaSqFt;

  return {
    index,
    pitchDegrees,
    azimuthDegrees,
    pitchLabel: pitchOption.value,
    facingLabel: azimuthLabel(azimuthDegrees),
    actualAreaSqFt,
    groundAreaSqFt,
    centroidMeters,
    bboxMeters: { sw, ne, corners },
    slopeDir,
    perpDir,
    groundRunFt: groundRunM * M2FT,
    widthFt: widthM * M2FT,
    slopedLengthFt: slopedLengthM * M2FT,
    planeHeightAtCenterMeters: nearest?.planeHeightAtCenterMeters,
    edges: [],
    diagramFootprintMeters: corners.map(c => ({ x: c.x, y: c.y })),
  };
}

function extractFacet(segment: SolarRoofSegment, index: number, center: SolarLatLng): RoofFacet {
  const sw = latLngToMeters(segment.boundingBox.sw, center);
  const ne = latLngToMeters(segment.boundingBox.ne, center);
  const corners: Vec2[] = [
    { x: sw.x, y: sw.y },
    { x: ne.x, y: sw.y },
    { x: ne.x, y: ne.y },
    { x: sw.x, y: ne.y },
  ];
  const centroidMeters = latLngToMeters(segment.center, center);

  const azimuthRad = (segment.azimuthDegrees * Math.PI) / 180;
  const slopeDir = { x: Math.sin(azimuthRad), y: Math.cos(azimuthRad) };
  const perpDir = { x: Math.cos(azimuthRad), y: -Math.sin(azimuthRad) };

  const slopeProjections = corners.map(corner => dot(corner, slopeDir));
  const perpProjections = corners.map(corner => dot(corner, perpDir));

  const groundRunM = Math.max(...slopeProjections) - Math.min(...slopeProjections);
  const widthM = Math.max(...perpProjections) - Math.min(...perpProjections);
  const pitchRad = (segment.pitchDegrees * Math.PI) / 180;
  const safeCosPitch = Math.max(Math.cos(pitchRad), 0.05);
  const slopedLengthM = groundRunM / safeCosPitch;

  const pitchOption = pitchDegreesToOption(segment.pitchDegrees);
  const actualAreaSqFt = segment.stats.areaMeters2 * M2SQFT;
  const groundAreaSqFt = segment.stats.groundAreaMeters2
    ? segment.stats.groundAreaMeters2 * M2SQFT
    : actualAreaSqFt * safeCosPitch;

  return {
    index,
    pitchDegrees: segment.pitchDegrees,
    azimuthDegrees: segment.azimuthDegrees,
    pitchLabel: pitchOption.value,
    facingLabel: azimuthLabel(segment.azimuthDegrees),
    actualAreaSqFt,
    groundAreaSqFt,
    centroidMeters,
    bboxMeters: { sw, ne, corners },
    slopeDir,
    perpDir,
    groundRunFt: groundRunM * M2FT,
    widthFt: widthM * M2FT,
    slopedLengthFt: slopedLengthM * M2FT,
    planeHeightAtCenterMeters: segment.planeHeightAtCenterMeters,
    edges: [],
  };
}

function buildPairAdjacencies(facets: RoofFacet[], context?: RoofStructureContext): PairAdjacency[] {
  const pairs: PairAdjacency[] = [];
  for (let i = 0; i < facets.length; i += 1) {
    for (let j = i + 1; j < facets.length; j += 1) {
      const a = facets[i];
      const b = facets[j];
      const aExpanded = expandBbox(a.bboxMeters, BBOX_ADJACENCY_THRESHOLD_M);
      if (!bboxesIntersect(aExpanded, b.bboxMeters)) continue;

      const overlapX =
        Math.min(a.bboxMeters.ne.x, b.bboxMeters.ne.x) -
        Math.max(a.bboxMeters.sw.x, b.bboxMeters.sw.x);
      const overlapY =
        Math.min(a.bboxMeters.ne.y, b.bboxMeters.ne.y) -
        Math.max(a.bboxMeters.sw.y, b.bboxMeters.sw.y);
      const sharedLengthM = Math.max(0, Math.max(overlapX, overlapY));
      if (sharedLengthM <= 0.05) continue;

      const sharedLengthFt = clamp(
        sharedLengthM * M2FT,
        0,
        Math.max(2, Math.min(a.widthFt, b.widthFt, a.slopedLengthFt, b.slopedLengthFt))
      );
      if (sharedLengthFt <= 0) continue;

      const sideI = inferContactSide(a, b);
      const sideJ = inferContactSide(b, a);
      const { kind, confidence } = classifyPair(a, b, context);
      pairs.push({ i, j, sideI, sideJ, sharedLengthFt, kind, confidence });
    }
  }
  return pairs;
}

function edgeLengthForSide(facet: RoofFacet, side: FacetSide): number {
  return side === 'top' || side === 'bottom' ? facet.widthFt : facet.slopedLengthFt;
}

function addPerimeterEdges(facets: RoofFacet[]): void {
  for (const facet of facets) {
    const occupied = new Set<FacetSide>(facet.edges.map(edge => edge.side));
    (['top', 'bottom', 'left', 'right'] as FacetSide[]).forEach(side => {
      if (occupied.has(side)) return;
      facet.edges.push({
        side,
        kind: side === 'bottom' ? 'eave' : 'rake',
        lengthFt: edgeLengthForSide(facet, side),
        adjacentFacetIndex: null,
        confidence: 1,
      });
    });
  }
}

function buildEdges(facets: RoofFacet[], pairs: PairAdjacency[]): void {
  pairs.forEach(pair => {
    facets[pair.i].edges.push({
      side: pair.sideI,
      kind: pair.kind,
      lengthFt: pair.sharedLengthFt,
      adjacentFacetIndex: pair.j,
      confidence: pair.confidence,
    });
    facets[pair.j].edges.push({
      side: pair.sideJ,
      kind: pair.kind,
      lengthFt: pair.sharedLengthFt,
      adjacentFacetIndex: pair.i,
      confidence: pair.confidence,
    });
  });
  addPerimeterEdges(facets);
}

function computeMeasurements(facets: RoofFacet[]): RoofStructureMeasurements {
  let totalRidgeFt = 0;
  let totalHipFt = 0;
  let totalValleyFt = 0;
  let totalEaveFt = 0;
  let totalRakeFt = 0;

  for (const facet of facets) {
    for (const edge of facet.edges) {
      if (edge.adjacentFacetIndex !== null && edge.adjacentFacetIndex < facet.index) continue;
      switch (edge.kind) {
        case 'ridge':
          totalRidgeFt += edge.lengthFt;
          break;
        case 'hip':
          totalHipFt += edge.lengthFt;
          break;
        case 'valley':
          totalValleyFt += edge.lengthFt;
          break;
        case 'eave':
          totalEaveFt += edge.lengthFt;
          break;
        case 'rake':
          totalRakeFt += edge.lengthFt;
          break;
        default:
          break;
      }
    }
  }

  const totalRoofAreaSqFt = facets.reduce((sum, facet) => sum + facet.actualAreaSqFt, 0);
  const totalGroundAreaSqFt = facets.reduce((sum, facet) => sum + facet.groundAreaSqFt, 0);
  const totalPitchedAreaSqFt = facets
    .filter(facet => facet.pitchDegrees > FLAT_PITCH_THRESHOLD_DEG)
    .reduce((sum, facet) => sum + facet.actualAreaSqFt, 0);
  const totalFlatAreaSqFt = Math.max(0, totalRoofAreaSqFt - totalPitchedAreaSqFt);

  const largestFacet = facets.reduce(
    (best, facet) => (facet.actualAreaSqFt > best.actualAreaSqFt ? facet : best),
    facets[0]
  );

  return {
    facetCount: facets.length,
    predominantPitch: largestFacet?.pitchLabel ?? '—',
    totalRoofAreaSqFt,
    totalPitchedAreaSqFt,
    totalFlatAreaSqFt,
    totalGroundAreaSqFt,
    totalSquares: Math.ceil((totalRoofAreaSqFt * 1.12) / 100),
    totalRidgeFt,
    totalHipFt,
    totalValleyFt,
    totalEaveFt,
    totalRakeFt,
    hipsAndRidgesFt: totalHipFt + totalRidgeFt,
    eavesAndRakesFt: totalEaveFt + totalRakeFt,
  };
}

export function recomputeMeasurementsFromFacets(
  facets: Array<Pick<RoofFacet, 'index' | 'edges' | 'pitchDegrees' | 'pitchLabel' | 'actualAreaSqFt' | 'groundAreaSqFt'>>
): RoofStructureMeasurements {
  const normalized = facets.map(facet => ({
    ...facet,
  })) as RoofFacet[];
  return computeMeasurements(normalized);
}

function overlapsAny(rect: UnfoldedFacetPlacement, existing: UnfoldedFacetPlacement[]): boolean {
  return existing.some(other => {
    const separated =
      rect.x + rect.w <= other.x ||
      other.x + other.w <= rect.x ||
      rect.y + rect.h <= other.y ||
      other.y + other.h <= rect.y;
    return !separated;
  });
}

function placeNeighbor(
  current: UnfoldedFacetPlacement,
  neighbor: UnfoldedFacetPlacement,
  side: FacetSide
): UnfoldedFacetPlacement {
  if (side === 'top') {
    return {
      ...neighbor,
      x: current.x + current.w / 2 - neighbor.w / 2,
      y: current.y - neighbor.h,
    };
  }
  if (side === 'bottom') {
    return {
      ...neighbor,
      x: current.x + current.w / 2 - neighbor.w / 2,
      y: current.y + current.h,
    };
  }
  if (side === 'left') {
    return {
      ...neighbor,
      x: current.x - neighbor.w,
      y: current.y + current.h / 2 - neighbor.h / 2,
    };
  }
  return {
    ...neighbor,
    x: current.x + current.w,
    y: current.y + current.h / 2 - neighbor.h / 2,
  };
}

function nudgePlacement(
  placement: UnfoldedFacetPlacement,
  side: FacetSide,
  attempt: number
): UnfoldedFacetPlacement {
  const step = 10 + attempt * 6;
  if (side === 'top' || side === 'bottom') {
    const direction = attempt % 2 === 0 ? 1 : -1;
    return { ...placement, x: placement.x + direction * step };
  }
  const direction = attempt % 2 === 0 ? 1 : -1;
  return { ...placement, y: placement.y + direction * step };
}

/** Diagram placement: real traced footprint vs. schematic rectangle from pitch/run. */
function initialPlacementForFacet(facet: RoofFacet): UnfoldedFacetPlacement {
  const fp = facet.diagramFootprintMeters;
  if (fp && fp.length >= 3) {
    const xs = fp.map(p => p.x);
    const ys = fp.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanXM = Math.max(0.05, maxX - minX);
    const spanYM = Math.max(0.05, maxY - minY);
    const w = Math.max(28, spanXM * M2FT * LAYOUT_PX_PER_FT * 1.06);
    const h = Math.max(28, spanYM * M2FT * LAYOUT_PX_PER_FT * 1.06);
    const outlinePx = fp.map(p => ({
      x: ((p.x - minX) / spanXM) * w,
      y: ((p.y - minY) / spanYM) * h,
    }));
    return { x: 0, y: 0, w, h, rotationDeg: 0, outlinePx };
  }
  return {
    x: 0,
    y: 0,
    w: Math.max(24, facet.widthFt * LAYOUT_PX_PER_FT),
    h: Math.max(24, facet.slopedLengthFt * LAYOUT_PX_PER_FT),
    rotationDeg: 0,
  };
}

function layoutFacets(facets: RoofFacet[]): RoofStructureFacet[] {
  const withPlacement: RoofStructureFacet[] = facets.map(facet => ({
    ...facet,
    placement: initialPlacementForFacet(facet),
  }));

  if (withPlacement.length === 0) return withPlacement;

  const root = withPlacement.reduce((best, facet) =>
    facet.actualAreaSqFt > best.actualAreaSqFt ? facet : best
  );
  const placed = new Set<number>([root.index]);
  const queue: number[] = [root.index];

  while (queue.length > 0) {
    const currentIndex = queue.shift();
    if (currentIndex === undefined) break;
    const current = withPlacement[currentIndex];

    const candidateEdges = current.edges
      .filter(edge => edge.adjacentFacetIndex !== null)
      .sort((a, b) => b.confidence - a.confidence);

    for (const edge of candidateEdges) {
      const neighborIndex = edge.adjacentFacetIndex;
      if (neighborIndex === null || placed.has(neighborIndex)) continue;
      const neighbor = withPlacement[neighborIndex];
      let nextPlacement = placeNeighbor(current.placement, neighbor.placement, edge.side);

      const existing = withPlacement
        .filter(facet => placed.has(facet.index))
        .map(facet => facet.placement);
      for (let attempt = 0; attempt < 8 && overlapsAny(nextPlacement, existing); attempt += 1) {
        nextPlacement = nudgePlacement(nextPlacement, edge.side, attempt);
      }
      if (overlapsAny(nextPlacement, existing)) continue;

      neighbor.placement = nextPlacement;
      placed.add(neighborIndex);
      queue.push(neighborIndex);
    }
  }

  const placedFacets = withPlacement.filter(facet => placed.has(facet.index));
  const maxY = placedFacets.length
    ? Math.max(...placedFacets.map(facet => facet.placement.y + facet.placement.h))
    : 0;
  let rowX = 0;
  let rowY = maxY + LAYOUT_GAP_PX;
  let rowHeight = 0;

  withPlacement.forEach(facet => {
    if (placed.has(facet.index)) return;
    if (rowX > 0 && rowX + facet.placement.w > 1200) {
      rowX = 0;
      rowY += rowHeight + LAYOUT_GAP_PX;
      rowHeight = 0;
    }
    facet.placement = { ...facet.placement, x: rowX, y: rowY };
    rowX += facet.placement.w + LAYOUT_GAP_PX;
    rowHeight = Math.max(rowHeight, facet.placement.h);
    placed.add(facet.index);
  });

  return withPlacement;
}

function computeSvgBounds(facets: RoofStructureFacet[]): RoofStructureAnalysis['svg'] {
  if (facets.length === 0) {
    return { viewBox: '0 0 640 360', width: 640, height: 360, pxPerFt: LAYOUT_PX_PER_FT };
  }

  const minX = Math.min(...facets.map(facet => facet.placement.x));
  const minY = Math.min(...facets.map(facet => facet.placement.y));
  const maxX = Math.max(...facets.map(facet => facet.placement.x + facet.placement.w));
  const maxY = Math.max(...facets.map(facet => facet.placement.y + facet.placement.h));

  const width = Math.max(320, Math.round(maxX - minX + LAYOUT_PADDING_PX * 2));
  const height = Math.max(220, Math.round(maxY - minY + LAYOUT_PADDING_PX * 2));
  const viewBox = `${Math.round(minX - LAYOUT_PADDING_PX)} ${Math.round(minY - LAYOUT_PADDING_PX)} ${width} ${height}`;
  return { viewBox, width, height, pxPerFt: LAYOUT_PX_PER_FT };
}

function computeStepRatio(facets: RoofFacet[]): number {
  let classifiedSharedEdges = 0;
  let stepEdges = 0;
  facets.forEach(facet => {
    facet.edges.forEach(edge => {
      if (edge.adjacentFacetIndex === null || edge.adjacentFacetIndex < facet.index) return;
      classifiedSharedEdges += 1;
      if (edge.kind === 'step') stepEdges += 1;
    });
  });
  if (classifiedSharedEdges === 0) return 0;
  return stepEdges / classifiedSharedEdges;
}

function computeTopologyScore(facets: RoofFacet[]): number {
  let sharedEdges = 0;
  let reciprocalMatches = 0;
  facets.forEach(facet => {
    facet.edges.forEach(edge => {
      if (edge.adjacentFacetIndex === null || edge.adjacentFacetIndex < facet.index) return;
      sharedEdges += 1;
      const reciprocal = facets[edge.adjacentFacetIndex]?.edges.find(
        other =>
          other.adjacentFacetIndex === facet.index &&
          other.kind === edge.kind
      );
      if (reciprocal) reciprocalMatches += 1;
    });
  });
  if (sharedEdges === 0) return 0.55;
  const reciprocalRatio = reciprocalMatches / sharedEdges;
  const stepPenalty = clamp(computeStepRatio(facets) * 0.4, 0, 0.4);
  return clamp(reciprocalRatio - stepPenalty, 0, 1);
}

function computeSegmentCoverageScore(facets: RoofFacet[]): number {
  if (facets.length === 0) return 0;
  return clamp(facets.length / 10, 0.35, 1);
}

function computeHeightScore(facets: RoofFacet[], context?: RoofStructureContext): number {
  if (context?.heightModel) return clamp(context.heightModel.quality, 0, 1);
  if (context?.hasDsm) return 0.9;
  const withPlaneHeight = facets.filter(facet => facet.planeHeightAtCenterMeters !== undefined).length;
  if (withPlaneHeight > 0) return clamp(withPlaneHeight / facets.length, 0.45, 0.75);
  return 0.2;
}

function computeImageryScore(quality: 'HIGH' | 'MEDIUM' | 'LOW'): number {
  if (quality === 'HIGH') return 1;
  if (quality === 'MEDIUM') return 0.7;
  return 0.4;
}

function vecLength(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

function normalize(v: Vec2): Vec2 {
  const len = vecLength(v);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function edgeSegmentMeters(facet: RoofFacet, edge: FacetEdge): { p1: Vec2; p2: Vec2 } {
  const center = facet.centroidMeters;
  const halfRunM = (facet.groundRunFt / M2FT) / 2;
  const halfWidthM = (facet.widthFt / M2FT) / 2;
  const edgeLenM = edge.lengthFt / M2FT;

  if (edge.side === 'top' || edge.side === 'bottom') {
    const sideOffset = edge.side === 'top' ? -halfRunM : halfRunM;
    const edgeCenter: Vec2 = {
      x: center.x + facet.slopeDir.x * sideOffset,
      y: center.y + facet.slopeDir.y * sideOffset,
    };
    const dir = normalize(facet.perpDir);
    return {
      p1: {
        x: edgeCenter.x - dir.x * (edgeLenM / 2),
        y: edgeCenter.y - dir.y * (edgeLenM / 2),
      },
      p2: {
        x: edgeCenter.x + dir.x * (edgeLenM / 2),
        y: edgeCenter.y + dir.y * (edgeLenM / 2),
      },
    };
  }

  const sideOffset = edge.side === 'left' ? -halfWidthM : halfWidthM;
  const edgeCenter: Vec2 = {
    x: center.x + facet.perpDir.x * sideOffset,
    y: center.y + facet.perpDir.y * sideOffset,
  };
  const dir = normalize(facet.slopeDir);
  return {
    p1: {
      x: edgeCenter.x - dir.x * (edgeLenM / 2),
      y: edgeCenter.y - dir.y * (edgeLenM / 2),
    },
    p2: {
      x: edgeCenter.x + dir.x * (edgeLenM / 2),
      y: edgeCenter.y + dir.y * (edgeLenM / 2),
    },
  };
}

function segmentMidpoint(p1: Vec2, p2: Vec2): Vec2 {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function orientationSimilarity(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  const va = normalize({ x: a2.x - a1.x, y: a2.y - a1.y });
  const vb = normalize({ x: b2.x - b1.x, y: b2.y - b1.y });
  return Math.abs(dot(va, vb));
}

function computeAiAgreement(facets: RoofFacet[], aiCues?: AiRoofCue[]): number {
  if (!aiCues || aiCues.length === 0) return 0.5;
  if (facets.length === 0) return 0;

  const edgeSegments = facets.flatMap(facet =>
    facet.edges.map(edge => ({
      kind: edge.kind,
      confidence: edge.confidence,
      ...edgeSegmentMeters(facet, edge),
    }))
  );

  if (edgeSegments.length === 0) return 0.25;

  let aggregate = 0;
  for (const cue of aiCues) {
    const cueMid = segmentMidpoint(cue.p1, cue.p2);
    const candidates = edgeSegments.filter(edge => edge.kind === cue.type);
    if (candidates.length === 0) {
      aggregate += 0.2 * cue.confidence;
      continue;
    }

    let best = 0;
    for (const edge of candidates) {
      const edgeMid = segmentMidpoint(edge.p1, edge.p2);
      const dist = Math.hypot(cueMid.x - edgeMid.x, cueMid.y - edgeMid.y);
      const distScore = clamp(1 - dist / 10, 0, 1); // 10m decay
      const dirScore = orientationSimilarity(cue.p1, cue.p2, edge.p1, edge.p2);
      const score = 0.45 * dirScore + 0.4 * distScore + 0.15 * edge.confidence;
      if (score > best) best = score;
    }
    aggregate += best * cue.confidence;
  }
  return clamp(aggregate / aiCues.length, 0, 1);
}

function toConfidenceBand(overall: number): ConfidenceBand {
  if (overall >= 0.75) return 'high';
  if (overall >= 0.55) return 'medium';
  return 'low';
}

function buildQualityFlags(
  facets: RoofFacet[],
  breakdown: ConfidenceBreakdown,
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW',
  hasDsm: boolean,
  aiCues?: AiRoofCue[]
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (imageryQuality === 'LOW') {
    flags.push({
      code: 'LOW_IMAGERY',
      message: 'Imagery quality is low, so linework and edge classes may be less reliable.',
      severity: 'warn',
    });
  }
  if (facets.length <= 2) {
    flags.push({
      code: 'SPARSE_SEGMENTS',
      message: 'Very few roof segments detected; report likely under-segmented.',
      severity: 'warn',
    });
  }
  if (!hasDsm && breakdown.height < 0.4) {
    flags.push({
      code: 'NO_HEIGHT_DATA',
      message: 'No height raster/DSM source detected; valley vs step decisions are heuristic.',
      severity: 'info',
    });
  }
  if (breakdown.topology < 0.5) {
    flags.push({
      code: 'TOPOLOGY_INCONSISTENT',
      message: 'Facet adjacency graph has low consistency.',
      severity: 'warn',
    });
  }
  if (computeStepRatio(facets) > 0.35) {
    flags.push({
      code: 'HIGH_STEP_RATIO',
      message: 'Many transitions are classified as step edges; verify critical lines manually.',
      severity: 'warn',
    });
  }
  if (aiCues && aiCues.length > 0 && breakdown.aiAgreement < 0.45) {
    flags.push({
      code: 'AI_DISAGREEMENT',
      message: 'AI line cues disagree with geometric reconstruction.',
      severity: 'critical',
    });
  }
  return flags;
}

function computeConfidence(
  facets: RoofFacet[],
  context?: RoofStructureContext
): {
  band: ConfidenceBand;
  breakdown: ConfidenceBreakdown;
  flags: QualityFlag[];
  dataSources: DataSourceMeta;
} {
  const imageryQuality = context?.imageryQuality ?? 'MEDIUM';
  const hasDsm = !!context?.hasDsm || context?.heightModel?.source === 'dsm';
  const imagery = computeImageryScore(imageryQuality);
  const topology = computeTopologyScore(facets);
  const height = computeHeightScore(facets, context);
  const aiAgreement = computeAiAgreement(facets, context?.aiCues);
  const segmentCoverage = computeSegmentCoverageScore(facets);
  const overall = clamp(
    0.3 * imagery +
      0.25 * topology +
      0.2 * height +
      0.15 * aiAgreement +
      0.1 * segmentCoverage,
    0,
    1
  );
  const breakdown: ConfidenceBreakdown = {
    overall,
    imagery,
    topology,
    height,
    aiAgreement,
    segmentCoverage,
  };
  const flags = buildQualityFlags(facets, breakdown, imageryQuality, hasDsm, context?.aiCues);
  const dataSources: DataSourceMeta = {
    imageryQuality,
    hasSolarSegments: facets.length > 0,
    hasDsm,
    heightSource: context?.heightModel?.source,
    heightQuality: context?.heightModel?.quality,
    hasAiCues: !!context?.aiCues?.length,
    sourceTimestampIso: new Date().toISOString(),
  };
  return { band: toConfidenceBand(overall), breakdown, flags, dataSources };
}

function emptyAnalysis(context?: RoofStructureContext): RoofStructureAnalysis {
  const imageryQuality = context?.imageryQuality ?? 'MEDIUM';
  return {
    version: 'v2',
    facets: [],
    measurements: {
      facetCount: 0,
      predominantPitch: '—',
      totalRoofAreaSqFt: 0,
      totalPitchedAreaSqFt: 0,
      totalFlatAreaSqFt: 0,
      totalGroundAreaSqFt: 0,
      totalSquares: 0,
      totalRidgeFt: 0,
      totalHipFt: 0,
      totalValleyFt: 0,
      totalEaveFt: 0,
      totalRakeFt: 0,
      hipsAndRidgesFt: 0,
      eavesAndRakesFt: 0,
    },
    confidenceBand: 'low',
    confidence: {
      overall: 0,
      imagery: computeImageryScore(imageryQuality),
      topology: 0,
      height: context?.heightModel?.quality ?? (context?.hasDsm ? 0.9 : 0.2),
      aiAgreement: context?.aiCues?.length ? 0.2 : 0.5,
      segmentCoverage: 0,
    },
    qualityFlags: [
      {
        code: 'SPARSE_SEGMENTS',
        message: 'No roof segments were detected from Solar data.',
        severity: 'critical',
      },
    ],
    dataSources: {
      imageryQuality,
      hasSolarSegments: false,
      hasDsm: !!context?.hasDsm || context?.heightModel?.source === 'dsm',
      heightSource: context?.heightModel?.source,
      heightQuality: context?.heightModel?.quality,
      hasAiCues: !!context?.aiCues?.length,
      sourceTimestampIso: new Date().toISOString(),
    },
    aiCuesUsed: context?.aiCues,
    review: { reviewed: false, editsCount: 0 },
    notes: ['No segments available for reconstruction.'],
    svg: { viewBox: '0 0 640 360', width: 640, height: 360, pxPerFt: LAYOUT_PX_PER_FT },
  };
}

export interface DrawnRoofSectionInput {
  id: string;
  path: { lat: number; lng: number }[];
  flatAreaSqFt: number;
  actualAreaSqFt: number;
  pitch: string;
}

/**
 * Build roof structure from **user-drawn** section polygons (map traces), using Solar segments only
 * to pick **nearest facet pitch/azimuth** (and plane height when present) — not Solar bbox footprints.
 */
export function analyzeDrawnRoofSections(
  drawn: DrawnRoofSectionInput[],
  buildingCenter: SolarLatLng,
  solarSegmentsForHints: SolarRoofSegment[],
  context?: RoofStructureContext
): RoofStructureAnalysis {
  const valid = drawn.filter(d => d.path.length >= 3);
  if (valid.length === 0) return emptyAnalysis(context);

  const facets = valid.map((d, index) => {
    const nearest =
      solarSegmentsForHints.length > 0
        ? findNearestSolarSegmentByPathCentroid(d.path, solarSegmentsForHints)
        : null;
    return buildRoofFacetFromDrawnSection(
      d.path,
      index,
      buildingCenter,
      d.flatAreaSqFt,
      d.actualAreaSqFt,
      nearest,
      d.pitch
    );
  });

  const pairAdjacencies = buildPairAdjacencies(facets, context);
  buildEdges(facets, pairAdjacencies);
  const measurements = computeMeasurements(facets);
  const laidOutFacets = layoutFacets(facets);
  const svg = computeSvgBounds(laidOutFacets);
  const { band, breakdown, flags, dataSources } = computeConfidence(laidOutFacets, context);

  return {
    version: 'v2',
    facets: laidOutFacets,
    measurements,
    confidenceBand: band,
    confidence: breakdown,
    qualityFlags: flags,
    dataSources,
    aiCuesUsed: context?.aiCues,
    review: { reviewed: false, editsCount: 0 },
    notes: [
      'Structure derived from user-drawn roof sections on the map.',
      'Indicative diagram uses your traced footprint shape; pitch/azimuth use the nearest Solar facet where available.',
      'Low-confidence reports should be reviewed with additional imagery or Tier B/C capture.',
    ],
    svg,
  };
}

export function analyzeSolarSegments(
  segments: SolarRoofSegment[],
  buildingCenter: SolarLatLng,
  context?: RoofStructureContext
): RoofStructureAnalysis {
  if (!segments.length) return emptyAnalysis(context);

  const facets = segments.map((segment, index) => extractFacet(segment, index, buildingCenter));
  const pairAdjacencies = buildPairAdjacencies(facets, context);
  buildEdges(facets, pairAdjacencies);
  const measurements = computeMeasurements(facets);
  const laidOutFacets = layoutFacets(facets);
  const svg = computeSvgBounds(laidOutFacets);
  const { band, breakdown, flags, dataSources } = computeConfidence(laidOutFacets, context);

  return {
    version: 'v2',
    facets: laidOutFacets,
    measurements,
    confidenceBand: band,
    confidence: breakdown,
    qualityFlags: flags,
    dataSources,
    aiCuesUsed: context?.aiCues,
    review: { reviewed: false, editsCount: 0 },
    notes: [
      'Geometry and edge classes are estimated from Solar segment boxes.',
      'Low-confidence reports should be reviewed with additional imagery.',
    ],
    svg,
  };
}

export function applyAiCuesToAnalysis(
  analysis: RoofStructureAnalysis,
  aiCues: AiRoofCue[]
): RoofStructureAnalysis {
  const { band, breakdown, flags, dataSources } = computeConfidence(analysis.facets, {
    imageryQuality: analysis.dataSources.imageryQuality,
    hasDsm: analysis.dataSources.hasDsm,
    aiCues,
  });
  return {
    ...analysis,
    confidenceBand: band,
    confidence: breakdown,
    qualityFlags: flags,
    dataSources,
    aiCuesUsed: aiCues,
    notes: [
      ...analysis.notes,
      `Applied ${aiCues.length} multi-angle AI cues to confidence scoring.`,
    ],
  };
}
