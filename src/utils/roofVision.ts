import type { AiRoofCue, Vec2 } from './roofStructure';
import type { SolarLatLng, SolarRoofSegment } from './solar';

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

function latLngToMeters(point: SolarLatLng, origin: SolarLatLng): Vec2 {
  return {
    x: (point.longitude - origin.longitude) * metersPerDegLng(origin.latitude),
    y: (point.latitude - origin.latitude) * METERS_PER_DEG_LAT,
  };
}

function cueTypeFromPitchAndAzimuth(
  pitchDegrees: number,
  azimuthDegrees: number
): AiRoofCue['type'] {
  if (pitchDegrees < 2) return 'eave';
  const mod = ((azimuthDegrees % 180) + 180) % 180;
  if (mod < 22.5 || mod > 157.5) return 'ridge';
  if (mod > 67.5 && mod < 112.5) return 'valley';
  return 'hip';
}

/**
 * Sprint-3 AI cue bootstrap:
 * Generates deterministic line cues from Solar segments so the reconstruction pipeline
 * can consume `aiCues` immediately. This can later be replaced with Gemini/CV outputs.
 */
export function deriveHeuristicRoofCues(
  segments: SolarRoofSegment[],
  center: SolarLatLng
): AiRoofCue[] {
  if (segments.length === 0) return [];
  return segments.map(segment => {
    const centroid = latLngToMeters(segment.center, center);
    const azRad = (segment.azimuthDegrees * Math.PI) / 180;
    const dir: Vec2 = { x: Math.sin(azRad), y: Math.cos(azRad) };
    const halfLengthMeters = Math.max(1.5, Math.sqrt(Math.max(1, segment.stats.areaMeters2)) * 0.35);
    const p1: Vec2 = {
      x: centroid.x - dir.x * halfLengthMeters,
      y: centroid.y - dir.y * halfLengthMeters,
    };
    const p2: Vec2 = {
      x: centroid.x + dir.x * halfLengthMeters,
      y: centroid.y + dir.y * halfLengthMeters,
    };
    return {
      type: cueTypeFromPitchAndAzimuth(segment.pitchDegrees, segment.azimuthDegrees),
      p1,
      p2,
      confidence: 0.58,
    };
  });
}
