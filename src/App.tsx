import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppView, Coordinates, RoofSection, User } from './types';
import LandingPage from './components/LandingPage';
import AnalysisPage from './components/AnalysisPage';
import Analysis2Page from './components/Analysis2Page';
import QuotePage from './components/QuotePage';
import ApiKeySetup from './components/ApiKeySetup';
import LoginPage from './components/LoginPage';
import DashboardLayout from './components/DashboardLayout';
import DashboardHome from './components/DashboardHome';
import ProjectsPage from './components/ProjectsPage';
import QuotesListPage from './components/QuotesListPage';
import SettingsPage from './components/SettingsPage';
import ReportsPage from './components/ReportsPage';
import MarketingPage from './components/MarketingPage';
import { initDb, isDbConfigured, getProjectDetails, getProjectSections } from './utils/db';
import { readMapsApiKey } from './utils/googleMapsKey';
import { readAuthSession, writeAuthSession, clearAuthSession } from './utils/authSession';

function mapDbRowToRoofSection(row: Record<string, unknown>): Omit<RoofSection, 'polygon'> {
  const pathRaw = row.polygon_path;
  let polygonPath: RoofSection['polygonPath'];
  if (Array.isArray(pathRaw)) {
    polygonPath = pathRaw as NonNullable<RoofSection['polygonPath']>;
  } else if (typeof pathRaw === 'string') {
    try {
      polygonPath = JSON.parse(pathRaw) as NonNullable<RoofSection['polygonPath']>;
    } catch {
      polygonPath = undefined;
    }
  } else {
    polygonPath = undefined;
  }
  const base: Omit<RoofSection, 'polygon'> = {
    id: String(row.id),
    name: String(row.name),
    flatArea: Number(row.flat_area),
    pitch: String(row.pitch),
    pitchMultiplier: Number(row.pitch_multiplier),
    actualArea: Number(row.actual_area),
    color: String(row.color),
  };
  if (polygonPath && polygonPath.length > 0) {
    return { ...base, polygonPath };
  }
  return base;
}

function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem('roofiq_user');
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const initial = useMemo(() => {
    const u = getStoredUser();
    const s = readAuthSession(u);
    return { user: u, ...s };
  }, []);

  const [view, setView] = useState<AppView>(() => initial.view);
  const [address, setAddress] = useState(() => initial.address);
  const [coordinates, setCoordinates] = useState<Coordinates>(() => initial.coordinates);
  const [roofSections, setRoofSections] = useState<Omit<RoofSection, 'polygon'>[]>(() => initial.roofSections);
  const [apiKey, setApiKey] = useState(() => readMapsApiKey());
  const [showKeySetup, setShowKeySetup] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(() => initial.projectId);
  const [openProjectDetailRequest, setOpenProjectDetailRequest] = useState<{
    projectId: string;
    initialTab: 'overview' | 'wizard';
  } | null>(null);
  /** Bumped when navigating from Analysis 2 to open the Smart Roof Mapping Wizard on New Analysis. */
  const [wizardAutoOpenSignal, setWizardAutoOpenSignal] = useState(0);
  /** True only after user picks "Quick analysis" on Analysis 2 (hides wizard promo on the map sidebar). */
  const [fromQuickAnalysisChoice, setFromQuickAnalysisChoice] = useState(false);
  /** True after user picks Smart Roof Mapping Wizard on Analysis 2 — map sidebar omits draw/quote onboarding until a property is chosen. */
  const [fromWizardAnalysis2Choice, setFromWizardAnalysis2Choice] = useState(false);
  const [user, setUser] = useState<User | null>(() => initial.user);
  // pending address/coords saved before login
  const [pendingAddr, setPendingAddr] = useState('');
  const [pendingCoords, setPendingCoords] = useState<Coordinates>({ lat: 37.422, lng: -122.084 });
  const [dbBanner, setDbBanner] = useState<string | null>(null);

  useEffect(() => {
    setApiKey(readMapsApiKey());
    if (!isDbConfigured()) {
      setDbBanner(
        import.meta.env.DEV
          ? null
          : 'Not connected. Use `DATABASE_URL` or `VITE_DATABASE_URL` in `.env` (Neon). Git-based Vercel builds cannot read your laptop `.env` — run `npm run deploy:vercel` from this machine, or set one of those variables for the build on Vercel.'
      );
      return;
    }
    initDb()
      .then(() => setDbBanner(null))
      .catch((e: unknown) => {
        console.error('[RoofIQ] initDb', e);
        const msg = e instanceof Error ? e.message : 'Initialization failed.';
        setDbBanner(`Could not reach the database: ${msg}`);
      });
  }, []);

  useEffect(() => {
    if (!user) return;
    if (view === 'landing' || view === 'login') return;
    writeAuthSession({ view, address, coordinates, roofSections, projectId });
  }, [user, view, address, coordinates, roofSections, projectId]);

  useEffect(() => {
    if (view !== 'analysis') {
      setWizardAutoOpenSignal(0);
      setFromQuickAnalysisChoice(false);
      setFromWizardAnalysis2Choice(false);
    }
  }, [view]);

  useEffect(() => {
    if (!user) {
      clearAuthSession();
      if (view !== 'landing' && view !== 'login') {
        setView('landing');
      }
    }
  }, [user, view]);

  const handleAnalysisPropertySelect = useCallback((addr: string, coords: Coordinates) => {
    setAddress(addr);
    setCoordinates(coords);
    setRoofSections([]);
    setProjectId(null);
  }, []);

  const handleAddressSelect = (addr: string, coords: Coordinates) => {
    if (!user) {
      setPendingAddr(addr);
      setPendingCoords(coords);
      setView('login');
      return;
    }
    setAddress(addr);
    setCoordinates(coords);
    setRoofSections([]);
    setProjectId(null);
    setView('analysis');
  };

  const handleLogin = (loggedInUser: User) => {
    setUser(loggedInUser);
    localStorage.setItem('roofiq_user', JSON.stringify(loggedInUser));
    if (pendingAddr) {
      setAddress(pendingAddr);
      setCoordinates(pendingCoords);
      setPendingAddr('');
      setRoofSections([]);
      setProjectId(null);
      setView('analysis');
    } else {
      setView('dashboard');
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('roofiq_user');
    clearAuthSession();
    setAddress('');
    setRoofSections([]);
    setProjectId(null);
    setView('landing');
  };

  const handleAnalysisComplete = (sections: Omit<RoofSection, 'polygon'>[], savedProjectId: string | null) => {
    setRoofSections(sections);
    setProjectId(savedProjectId);
    setView('quote');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleRestart = () => {
    setAddress('');
    setCoordinates({ lat: 37.422, lng: -122.084 });
    setRoofSections([]);
    setProjectId(null);
    setView(user ? 'dashboard' : 'landing');
  };

  /** From dashboard / projects — stay in app shell and open a fresh analysis tab. */
  const handleNewAnalysisFromPanel = useCallback(() => {
    setAddress('');
    setCoordinates({ lat: 37.422, lng: -122.084 });
    setRoofSections([]);
    setProjectId(null);
    setWizardAutoOpenSignal(0);
    setFromWizardAnalysis2Choice(false);
    setView('analysis');
  }, []);

  const handleAnalysis2Quick = useCallback(() => {
    setAddress('');
    setCoordinates({ lat: 37.422, lng: -122.084 });
    setRoofSections([]);
    setProjectId(null);
    setWizardAutoOpenSignal(0);
    setFromQuickAnalysisChoice(true);
    setFromWizardAnalysis2Choice(false);
    setView('analysis');
  }, []);

  const handleAnalysis2Wizard = useCallback(() => {
    setAddress('');
    setCoordinates({ lat: 37.422, lng: -122.084 });
    setRoofSections([]);
    setProjectId(null);
    setWizardAutoOpenSignal(n => n + 1);
    setFromQuickAnalysisChoice(false);
    setFromWizardAnalysis2Choice(true);
    setView('analysis');
  }, []);

  const handleWizardReportReady = useCallback((ctx: { projectId: string }) => {
    setProjectId(ctx.projectId);
    setOpenProjectDetailRequest({ projectId: ctx.projectId, initialTab: 'wizard' });
    setView('dashboard');
  }, []);

  const handleOpenQuoteFromProject = useCallback(async (pid: string) => {
    if (!isDbConfigured()) return;
    try {
      const details = await getProjectDetails(pid);
      const rows = (await getProjectSections(pid)) as Record<string, unknown>[];
      const mapped = rows.map(mapDbRowToRoofSection);
      setAddress(details.address);
      setCoordinates({ lat: details.lat, lng: details.lng });
      setRoofSections(mapped);
      setProjectId(pid);
      setView('quote');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.error('[RoofIQ] open quote from project', e);
    }
  }, []);

  const handleApiKeySave = (key: string) => {
    setApiKey(key);
    setShowKeySetup(false);
  };

  // Full-page overlays (no layout)
  if (showKeySetup) return <ApiKeySetup onSave={handleApiKeySave} />;
  if (view === 'landing') return (
    <LandingPage
      apiKey={apiKey}
      onAddressSelect={handleAddressSelect}
      onSignIn={() => setView('login')}
    />
  );
  if (view === 'login') return (
    <LoginPage onLogin={handleLogin} onBack={() => setView('landing')} />
  );

  // Authenticated routes without a user (stale state): effect resets view; show placeholder instead of a blank frame
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  /** Flex column + overflow-hidden on main so children can use flex-1 min-h-0 and scroll (mobile Safari). */
  const fullHeightMain =
    view === 'analysis' ||
    view === 'analysis-2' ||
    view === 'marketing' ||
    view === 'quote' ||
    view === 'projects' ||
    view === 'quotes-list';

  return (
    <DashboardLayout
      view={view}
      user={user}
      onNavigate={setView}
      onLogout={handleLogout}
      fullHeight={fullHeightMain}
      dbBanner={dbBanner}
    >
      {view === 'dashboard' && (
        <DashboardHome
          onNewAnalysis={handleNewAnalysisFromPanel}
          openProjectDetailRequest={openProjectDetailRequest}
          onOpenProjectDetailRequestHandled={() => setOpenProjectDetailRequest(null)}
          onOpenQuoteFromProject={handleOpenQuoteFromProject}
        />
      )}
      {view === 'analysis' && (
        <AnalysisPage
          apiKey={apiKey}
          address={address}
          coordinates={coordinates}
          projectId={projectId}
          wizardAutoOpenSignal={wizardAutoOpenSignal}
          fromQuickAnalysisChoice={fromQuickAnalysisChoice}
          fromWizardAnalysis2Choice={fromWizardAnalysis2Choice}
          onPropertySelect={handleAnalysisPropertySelect}
          onComplete={handleAnalysisComplete}
          onWizardReportReady={handleWizardReportReady}
        />
      )}
      {view === 'analysis-2' && (
        <Analysis2Page
          onQuickAnalysis={handleAnalysis2Quick}
          onSmartRoofMappingWizard={handleAnalysis2Wizard}
        />
      )}
      {view === 'quote' && (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-slate-50 py-4 sm:py-6 [-webkit-overflow-scrolling:touch]">
          <QuotePage
            address={address}
            coordinates={coordinates}
            sections={roofSections}
            projectId={projectId}
            mapsApiKey={apiKey}
            onBack={() => setView('analysis')}
            onRestart={handleRestart}
          />
        </div>
      )}
      {view === 'projects' && (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ProjectsPage onNewAnalysis={handleNewAnalysisFromPanel} onOpenQuoteFromProject={handleOpenQuoteFromProject} />
        </div>
      )}
      {view === 'marketing' && <MarketingPage apiKey={apiKey} />}
      {view === 'quotes-list' && (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
          <QuotesListPage />
        </div>
      )}
      {view === 'reports' && <ReportsPage />}
      {view === 'settings' && (
        <SettingsPage apiKey={apiKey} user={user} onNeedApiKey={() => setShowKeySetup(true)} onLogout={handleLogout} />
      )}
    </DashboardLayout>
  );
}
