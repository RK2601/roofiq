import { Material, RoofSection, QuoteData, Coordinates } from '../types';

export const PITCH_OPTIONS: { value: string; label: string; multiplier: number }[] = [
  { value: '2/12', label: '2/12 (Low)', multiplier: 1.014 },
  { value: '3/12', label: '3/12 (Low)', multiplier: 1.031 },
  { value: '4/12', label: '4/12 (Moderate)', multiplier: 1.054 },
  { value: '5/12', label: '5/12 (Moderate)', multiplier: 1.083 },
  { value: '6/12', label: '6/12 (Standard)', multiplier: 1.118 },
  { value: '7/12', label: '7/12 (Standard)', multiplier: 1.158 },
  { value: '8/12', label: '8/12 (Steep)', multiplier: 1.202 },
  { value: '9/12', label: '9/12 (Steep)', multiplier: 1.250 },
  { value: '10/12', label: '10/12 (Very Steep)', multiplier: 1.302 },
  { value: '12/12', label: '12/12 (Extreme)', multiplier: 1.414 },
];

export const SECTION_COLORS = [
  '#3b82f6', // blue
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#eab308', // yellow
  '#ec4899', // pink
];

export const MATERIALS: Material[] = [
  {
    id: 'asphalt',
    name: 'Asphalt Shingles',
    description: 'Most popular choice. Durable, cost-effective, and available in many styles.',
    pricePerSquare: 120,
    laborPerSquare: 80,
    warranty: '25–30 years',
    lifespan: '20–30 years',
    pros: ['Cost-effective', 'Wide variety', 'Easy installation'],
    icon: '🏠',
  },
  {
    id: 'metal',
    name: 'Metal Roofing',
    description: 'Premium durability with excellent energy efficiency and longevity.',
    pricePerSquare: 350,
    laborPerSquare: 150,
    warranty: '40–50 years',
    lifespan: '40–70 years',
    pros: ['Long lifespan', 'Energy efficient', 'Low maintenance'],
    icon: '⚡',
  },
  {
    id: 'tile',
    name: 'Clay / Concrete Tile',
    description: 'Timeless aesthetic appeal with superior fire resistance and longevity.',
    pricePerSquare: 500,
    laborPerSquare: 200,
    warranty: '50 years',
    lifespan: '50–100 years',
    pros: ['Fire resistant', 'Premium look', 'Very durable'],
    icon: '🏛️',
  },
  {
    id: 'tpo',
    name: 'TPO / Flat Roof',
    description: 'Ideal for low-slope and flat roofs. Energy-efficient white membrane.',
    pricePerSquare: 200,
    laborPerSquare: 120,
    warranty: '20–30 years',
    lifespan: '15–30 years',
    pros: ['Great for flat roofs', 'UV reflective', 'Weld-seam waterproof'],
    icon: '🔲',
  },
];

export function computeActualArea(flatArea: number, pitchMultiplier: number): number {
  return flatArea * pitchMultiplier;
}

/** Parse a pitch label like `4/12` into slope angle in degrees (for structure / Solar hints). */
export function pitchStringToPitchDegrees(pitch: string): number {
  const m = pitch.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*12$/i);
  if (!m) return (Math.atan2(4, 12) * 180) / Math.PI;
  const rise = Number(m[1]);
  if (!Number.isFinite(rise) || rise <= 0) return (Math.atan2(4, 12) * 180) / Math.PI;
  return (Math.atan2(rise, 12) * 180) / Math.PI;
}

export function generateQuote(
  address: string,
  coordinates: Coordinates,
  sections: Omit<RoofSection, 'polygon'>[],
  material: Material,
  wasteFactor = 0.12
): QuoteData {
  const totalFlatArea = sections.reduce((sum, s) => sum + s.flatArea, 0);
  const totalActualArea = sections.reduce((sum, s) => sum + s.actualArea, 0);
  const orderAreaWithWaste = totalActualArea * (1 + wasteFactor);
  const orderSquares = Math.ceil(orderAreaWithWaste / 100);

  const materialCost = orderSquares * material.pricePerSquare;
  const laborCost = orderSquares * material.laborPerSquare;

  const additionalCosts = [
    { label: 'Underlayment & Ice Shield', amount: orderSquares * 15 },
    { label: 'Flashing & Ridge Cap', amount: orderSquares * 10 },
    { label: 'Disposal / Tear-off', amount: orderSquares * 20 },
    { label: 'Permits & Inspection', amount: 350 },
  ];

  const additionalTotal = additionalCosts.reduce((s, c) => s + c.amount, 0);
  const subtotal = materialCost + laborCost + additionalTotal;
  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  return {
    address,
    coordinates,
    sections,
    totalFlatArea,
    totalActualArea,
    wasteFactor,
    orderSquares,
    material,
    materialCost,
    laborCost,
    additionalCosts,
    subtotal,
    tax,
    total,
    generatedAt: new Date(),
  };
}

export function formatArea(sqft: number): string {
  return sqft.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' sq ft';
}

export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
