export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RoofSection {
  id: string;
  name: string;
  polygon: google.maps.Polygon | null;
  flatArea: number; // sq ft (plan area)
  pitch: string;
  pitchMultiplier: number;
  actualArea: number; // sq ft (true roof area)
  color: string;
}

export interface Material {
  id: string;
  name: string;
  description: string;
  pricePerSquare: number; // per 100 sq ft
  laborPerSquare: number;
  warranty: string;
  lifespan: string;
  pros: string[];
  icon: string;
}

export interface AdditionalCost {
  label: string;
  amount: number;
}

export interface QuoteData {
  address: string;
  coordinates: Coordinates;
  sections: Omit<RoofSection, 'polygon'>[];
  totalFlatArea: number;
  totalActualArea: number;
  wasteFactor: number;
  orderSquares: number;
  material: Material;
  materialCost: number;
  laborCost: number;
  additionalCosts: AdditionalCost[];
  subtotal: number;
  tax: number;
  total: number;
  generatedAt: Date;
}

export type AppView = 'landing' | 'login' | 'dashboard' | 'analysis' | 'quote' | 'projects' | 'quotes-list' | 'settings' | 'reports' | 'marketing';

export interface User {
  email: string;
  name: string;
  role: string;
  avatar: string; // initials e.g. "AD"
}
