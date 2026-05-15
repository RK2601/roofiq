import type { AppView, Coordinates, RoofSection, User } from '../types';

export const AUTH_SESSION_KEY = 'roofiq_auth_session_v1';

const DEFAULT_COORDS: Coordinates = { lat: 37.422, lng: -122.084 };

const APP_VIEWS: AppView[] = [
  'landing',
  'login',
  'dashboard',
  'analysis',
  'quote',
  'projects',
  'quotes-list',
  'settings',
  'reports',
  'marketing',
  'analysis-hub',
  'hover-measure',
  'depth-measure',
  'accu-measure',
  'roof-wizard',
];

function parseAppView(raw: unknown): AppView | null {
  if (typeof raw !== 'string') return null;
  return (APP_VIEWS as readonly string[]).includes(raw) ? (raw as AppView) : null;
}

/** In-app routes to restore after refresh when the user is signed in. */
const AUTH_RESTORE_VIEWS: AppView[] = [
  'dashboard',
  'analysis',
  'analysis-hub',
  'hover-measure',
  'depth-measure',
  'accu-measure',
  'roof-wizard',
  'quote',
  'projects',
  'quotes-list',
  'settings',
  'reports',
  'marketing',
];

function isAuthRestoreView(v: AppView): boolean {
  return AUTH_RESTORE_VIEWS.includes(v);
}

/** Saved with auth session so refresh keeps the Smart Roof Mapping wizard open. */
export type WizardAttachSnapshot = {
  mode: 'inherit' | 'new' | 'existing';
  projectId?: string;
  newProjectName?: string;
  existingDisplayName?: string;
};

export type AuthSessionSnapshot = {
  view: AppView;
  address: string;
  coordinates: Coordinates;
  roofSections: Omit<RoofSection, 'polygon'>[];
  projectId: string | null;
  /** Hub → analysis (manual smart wizard). */
  wizardFromHub?: boolean;
  /** Hub → analysis (DSM auto-map). */
  wizardAutoSegment?: boolean;
  /** RoofMappingWizard full-screen overlay was open. */
  wizardOverlayOpen?: boolean;
  /** Folder attach for the wizard (null = inherit / not set). */
  wizardAttach?: WizardAttachSnapshot | null;
};

function parseWizardAttach(raw: unknown): WizardAttachSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (mode !== 'inherit' && mode !== 'new' && mode !== 'existing') return null;
  return {
    mode,
    projectId: typeof o.projectId === 'string' ? o.projectId : undefined,
    newProjectName: typeof o.newProjectName === 'string' ? o.newProjectName : undefined,
    existingDisplayName: typeof o.existingDisplayName === 'string' ? o.existingDisplayName : undefined,
  };
}

/** Restore last in-app route after refresh (same tab). */
export function readAuthSession(user: User | null): AuthSessionSnapshot {
  const fallbackLoggedOut: AuthSessionSnapshot = {
    view: 'landing',
    address: '',
    coordinates: { ...DEFAULT_COORDS },
    roofSections: [],
    projectId: null,
    wizardFromHub: undefined,
    wizardAutoSegment: undefined,
    wizardOverlayOpen: undefined,
    wizardAttach: null,
  };
  const fallbackLoggedIn: AuthSessionSnapshot = {
    ...fallbackLoggedOut,
    view: 'dashboard',
  };

  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return user ? fallbackLoggedIn : fallbackLoggedOut;

    const s = JSON.parse(raw) as Record<string, unknown>;
    const view = parseAppView(s.view);
    if (!view) return user ? fallbackLoggedIn : fallbackLoggedOut;

    if (!user) {
      if (view === 'landing' || view === 'login') {
        return { ...fallbackLoggedOut, view };
      }
      return fallbackLoggedOut;
    }

    if (view === 'landing' || view === 'login' || !isAuthRestoreView(view)) {
      return fallbackLoggedIn;
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
      wizardFromHub: typeof s.wizardFromHub === 'boolean' ? s.wizardFromHub : undefined,
      wizardAutoSegment: typeof s.wizardAutoSegment === 'boolean' ? s.wizardAutoSegment : undefined,
      wizardOverlayOpen: typeof s.wizardOverlayOpen === 'boolean' ? s.wizardOverlayOpen : undefined,
      wizardAttach: parseWizardAttach(s.wizardAttach),
    };
  } catch {
    return user ? fallbackLoggedIn : fallbackLoggedOut;
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
