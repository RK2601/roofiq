import type { RoofSection } from '../types';
import type { LatLng } from '../utils/measurements';
import { formatArea } from '../utils/roofCalculations';

interface RoofDiagramProps {
  sections: Omit<RoofSection, 'polygon'>[];
  width?: number;
  height?: number;
  /** Blueprint (dark blue bg) or Plan (white bg) style */
  style?: 'blueprint' | 'plan';
  className?: string;
}

function normalizePaths(
  sections: Omit<RoofSection, 'polygon'>[],
  width: number,
  height: number,
  padding: number
): { points: string; cx: number; cy: number; label: string; area: string; color: string }[] {
  const allPts = sections.flatMap(s => s.polygonPath ?? []);
  if (allPts.length === 0) return [];

  const minLat = Math.min(...allPts.map(p => p.lat));
  const maxLat = Math.max(...allPts.map(p => p.lat));
  const minLng = Math.min(...allPts.map(p => p.lng));
  const maxLng = Math.max(...allPts.map(p => p.lng));

  const rangeW = maxLng - minLng || 1e-6;
  const rangeH = maxLat - minLat || 1e-6;
  const drawW = width - padding * 2;
  const drawH = height - padding * 2;
  const scale = Math.min(drawW / rangeW, drawH / rangeH);

  const toX = (lng: number) => padding + (lng - minLng) * scale;
  const toY = (lat: number) => height - padding - (lat - minLat) * scale;

  return sections
    .filter(s => (s.polygonPath?.length ?? 0) >= 3)
    .map(s => {
      const pts = (s.polygonPath as LatLng[]).map(p => `${toX(p.lng).toFixed(1)},${toY(p.lat).toFixed(1)}`).join(' ');
      const cx = s.polygonPath!.reduce((sum, p) => sum + toX(p.lng), 0) / s.polygonPath!.length;
      const cy = s.polygonPath!.reduce((sum, p) => sum + toY(p.lat), 0) / s.polygonPath!.length;
      return { points: pts, cx, cy, label: s.name, area: formatArea(s.actualArea), color: s.color };
    });
}

export default function RoofDiagram({
  sections,
  width = 480,
  height = 360,
  style = 'plan',
  className = '',
}: RoofDiagramProps) {
  const padding = 28;
  const polys = normalizePaths(sections, width, height, padding);

  const isBlueprint = style === 'blueprint';
  const bg = isBlueprint ? '#0f2044' : '#f8fafc';
  const stroke = isBlueprint ? '#7eb3ff' : '#2563eb';
  const fill = isBlueprint ? 'rgba(126,179,255,0.12)' : 'rgba(37,99,235,0.07)';
  const textColor = isBlueprint ? '#bfdbfe' : '#1e40af';
  const subTextColor = isBlueprint ? '#93c5fd' : '#3b82f6';

  if (polys.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl ${className}`}
        style={{ width, height, background: bg }}
      >
        <p style={{ color: textColor, opacity: 0.4, fontSize: 13 }}>No sections drawn</p>
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ background: bg, borderRadius: 12 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Grid lines */}
      {Array.from({ length: 6 }).map((_, i) => (
        <line
          key={`h${i}`}
          x1={padding}
          y1={padding + ((height - padding * 2) / 5) * i}
          x2={width - padding}
          y2={padding + ((height - padding * 2) / 5) * i}
          stroke={isBlueprint ? 'rgba(126,179,255,0.08)' : 'rgba(37,99,235,0.06)'}
          strokeWidth={0.5}
        />
      ))}
      {Array.from({ length: 8 }).map((_, i) => (
        <line
          key={`v${i}`}
          x1={padding + ((width - padding * 2) / 7) * i}
          y1={padding}
          x2={padding + ((width - padding * 2) / 7) * i}
          y2={height - padding}
          stroke={isBlueprint ? 'rgba(126,179,255,0.08)' : 'rgba(37,99,235,0.06)'}
          strokeWidth={0.5}
        />
      ))}

      {/* Section polygons */}
      {polys.map((p, i) => (
        <g key={i}>
          <polygon
            points={p.points}
            fill={isBlueprint ? fill : `${p.color}18`}
            stroke={isBlueprint ? stroke : p.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {/* Dashed corner marks */}
          <polygon
            points={p.points}
            fill="none"
            stroke={isBlueprint ? 'rgba(126,179,255,0.3)' : `${p.color}55`}
            strokeWidth={0.5}
            strokeDasharray="3,3"
          />
        </g>
      ))}

      {/* Labels */}
      {polys.map((p, i) => (
        <g key={`label-${i}`}>
          <text
            x={p.cx}
            y={p.cy - 6}
            textAnchor="middle"
            fontSize={10}
            fontWeight="600"
            fill={textColor}
            fontFamily="Inter, system-ui, sans-serif"
          >
            {p.label}
          </text>
          <text
            x={p.cx}
            y={p.cy + 8}
            textAnchor="middle"
            fontSize={9}
            fill={subTextColor}
            fontFamily="Inter, system-ui, sans-serif"
          >
            {p.area}
          </text>
        </g>
      ))}

      {/* North indicator */}
      <g transform={`translate(${width - padding + 8}, ${padding + 4})`}>
        <text fontSize={8} fill={isBlueprint ? '#93c5fd' : '#94a3b8'} fontFamily="Inter, system-ui, sans-serif">N↑</text>
      </g>
    </svg>
  );
}
