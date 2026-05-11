import type { AppView, Coordinates, RoofSection, User } from '../types';

export const AUTH_SESSION_KEY = 'roofiq_auth_session_v1';

const DEFAULT_COORDS: Coordinates = { lat: 37.422, lng: -122.084 };

export type AuthSessionSnapshot = {
  view: AppView;
  address: string;
  coordinates: Coordinates;
  roofSections: Omit<RoofSection, 'polygon'>[];
  projectId: string | null;
};

const SHELL_VIEWS: AppView[] = [
  'dashboard',
  'analysis',
  'analysis-2',
  'quote',
  'projects',
  'quotes-list',
  'settings',
  'reports',
  'marketing',
];

function isPersistableShellView(v: AppView): boolean {
  return SHELL_VIEWS.includes(v);
}

/** Restore last in-app route after refresh (same tab). */
export function readAuthSession(user: User | null): AuthSessionSnapshot {
  const fallback: AuthSessionSnapshot = {
    view: user ? 'dashboard' : 'landing',
    address: '',
    coordinates: { ...DEFAULT_COORDS },
    roofSections: [],
    projectId: null,
  };
  if (!user) return fallback;

  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Record<string, unknown>;
    const view = s.view as AppView | undefined;
    if (!view || !isPersistableShellView(view)) return fallback;

    if (view === 'quote') {
      const rs = s.roofSections;
      if (!Array.isArray(rs) || rs.length === 0) return fallback;
    }

    const coordinates = (() => {
      const c = s.coordinates as Coordinates | undefined;
      if (c && typeof c.lat === 'number' && typeof c.lng === 'number') return c;
      return { ...DEFAULT_COORDS };
    })();

    return {
      view,
      address: typeof s.address === 'string' ? s.address : '',
      coordinates,
      roofSections: Array.isArray(s.roofSections)
        ? (s.roofSections as Omit<RoofSection, 'polygon'>[])
        : [],
      projectId: s.projectId === null || typeof s.projectId === 'string' ? (s.projectId as string | null) : null,
    };
  } catch {
    return fallback;
  }
}

export function writeAuthSession(payload: AuthSessionSnapshot): void {
  try {
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function clearAuthSession(): void {
  try {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    /* */
  }
}
