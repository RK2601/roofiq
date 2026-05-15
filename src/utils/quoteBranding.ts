export interface QuoteBranding {
  companyName: string;
  tagline: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  licenseNo: string;
  logoDataUrl: string | null;
  signatureDataUrl: string | null;
  accentColor: string;
  terms: string;
}

export const DEFAULT_BRANDING: QuoteBranding = {
  companyName: '',
  tagline: '',
  address: '',
  city: '',
  phone: '',
  email: '',
  website: '',
  licenseNo: '',
  logoDataUrl: null,
  signatureDataUrl: null,
  accentColor: '#1e40af',
  terms:
    'This quote is valid for the number of days stated above. Work will commence upon written acceptance and deposit. All materials and workmanship are warranted. Final invoice may vary based on actual field measurements.',
};

const KEY = 'roofiq_quote_branding';

export function loadBranding(): QuoteBranding {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_BRANDING };
}

export function saveBranding(b: QuoteBranding): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch { /* ignore */ }
}

export interface QuoteClient {
  name: string;
  address: string;
  city: string;
  phone: string;
  email: string;
}

export const DEFAULT_CLIENT: QuoteClient = {
  name: '',
  address: '',
  city: '',
  phone: '',
  email: '',
};
