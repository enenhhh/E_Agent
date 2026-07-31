import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';

import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { I18nProvider } from './context/I18nContext';
import { TransportProvider } from './context/TransportContext';
import { AuthGate } from './features/auth/AuthGate';
import { LoginPage } from './features/auth/LoginPage';
import { SetupPage } from './features/auth/SetupPage';
import type { EAgentTransport } from './lib/transport';
import { useSettingsStore } from './stores/settings-store';
import type { AppMode } from './types';

const CURRENT_TUTORIAL_VERSION = 1;

const WorkspacePage = lazy(() =>
  import('./features/workspace/WorkspacePage').then((module) => ({
    default: module.WorkspacePage,
  })),
);
const ModelsPage = lazy(() =>
  import('./features/models/ModelsPage').then((module) => ({ default: module.ModelsPage })),
);
const CredentialsPage = lazy(() =>
  import('./features/credentials/CredentialsPage').then((module) => ({
    default: module.CredentialsPage,
  })),
);
const CostsPage = lazy(() =>
  import('./features/costs/CostsPage').then((module) => ({ default: module.CostsPage })),
);
const SkillsPage = lazy(() =>
  import('./features/extensions/SkillsPage').then((module) => ({ default: module.SkillsPage })),
);
const PluginsPage = lazy(() =>
  import('./features/extensions/PluginsPage').then((module) => ({
    default: module.PluginsPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then((module) => ({
    default: module.SettingsPage,
  })),
);
const AdminPage = lazy(() =>
  import('./features/admin/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const TutorialPage = lazy(() =>
  import('./features/tutorial/TutorialPage').then((module) => ({
    default: module.TutorialPage,
  })),
);

export interface EAgentAppProps {
  mode?: AppMode;
  transport?: EAgentTransport;
}

function TutorialAwareWorkspace({
  settingsHydrated,
}: {
  settingsHydrated: boolean;
}): React.JSX.Element {
  const location = useLocation();
  const completedVersion = useSettingsStore((state) => state.settings.tutorialCompletedVersion);
  const tutorialPreview =
    typeof location.state === 'object' &&
    location.state !== null &&
    'tutorialPreview' in location.state &&
    location.state.tutorialPreview === true;

  if (!settingsHydrated && !tutorialPreview) {
    return <div className="route-loading">正在加载工作区…</div>;
  }
  if (!tutorialPreview && completedVersion < CURRENT_TUTORIAL_VERSION) {
    return <Navigate replace to="/tutorial" />;
  }
  return <WorkspacePage />;
}

function AppRoutes(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings);
  const settingsLoading = useSettingsStore((state) => state.loading);
  const settingsError = useSettingsStore((state) => state.error);
  const initialSettings = useRef(settings);
  const observedLoading = useRef(settingsLoading);
  const [settingsHydrated, setSettingsHydrated] = useState(
    settings.tutorialCompletedVersion >= CURRENT_TUTORIAL_VERSION,
  );

  useEffect(() => {
    if (settingsLoading) {
      observedLoading.current = true;
    }
    if (
      settings !== initialSettings.current ||
      settingsError !== null ||
      (observedLoading.current && !settingsLoading)
    ) {
      setSettingsHydrated(true);
    }
  }, [settings, settingsError, settingsLoading]);

  return (
    <Suspense fallback={<div className="route-loading">正在加载工作区…</div>}>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        <Route element={<SetupPage />} path="/setup" />
        <Route
          element={
            <AuthGate>
              <AppShell />
            </AuthGate>
          }
        >
          <Route element={<Navigate replace to="/workspace" />} index />
          <Route
            element={<TutorialAwareWorkspace settingsHydrated={settingsHydrated} />}
            path="/workspace"
          />
          <Route element={<TutorialPage />} path="/tutorial" />
          <Route element={<ModelsPage />} path="/models" />
          <Route element={<CredentialsPage />} path="/credentials" />
          <Route element={<CostsPage />} path="/costs" />
          <Route element={<SkillsPage />} path="/skills" />
          <Route element={<PluginsPage />} path="/plugins" />
          <Route element={<SettingsPage />} path="/settings" />
          <Route element={<AdminPage />} path="/admin" />
        </Route>
        <Route element={<Navigate replace to="/workspace" />} path="*" />
      </Routes>
    </Suspense>
  );
}

export function EAgentApp({
  mode = window.eAgent ? 'desktop' : 'web',
  transport,
}: EAgentAppProps): React.JSX.Element {
  const Router = mode === 'desktop' ? HashRouter : BrowserRouter;
  return (
    <ErrorBoundary>
      <TransportProvider mode={mode} transport={transport}>
        <I18nProvider>
          <Router>
            <AppRoutes />
          </Router>
        </I18nProvider>
      </TransportProvider>
    </ErrorBoundary>
  );
}

export const App = EAgentApp;
