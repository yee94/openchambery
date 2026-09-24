import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts'
import './index.css'
import App from './App.tsx'
import { SessionAuthGate } from './components/auth/SessionAuthGate'
import { OpenCodeUpgradeScreen } from './components/update/OpenCodeUpgradeScreen'
import { ThemeSystemProvider } from './contexts/ThemeSystemContext'
import { ThemeProvider } from './components/providers/ThemeProvider'
import './lib/debug'
import { syncDesktopSettings, initializeAppearancePreferences } from './lib/persistence'
import { startAppearanceAutoSave } from './lib/appearanceAutoSave'
import { applyPersistedDirectoryPreferences } from './lib/directoryPersistence'
import { startTypographyWatcher } from './lib/typographyWatcher'
import { startModelPrefsAutoSave } from './lib/modelPrefsAutoSave'
import { initializeLocale, I18nProvider } from './lib/i18n'
import { runSettingsStartup } from './lib/settingsStartup'
import { getRuntimeKey } from './lib/runtime-switch'
import type { RuntimeAPIs } from './lib/api/types'
import { isDesktopShell } from './lib/desktop'
import { beginSessionStartupBarrier } from './lib/session-startup-barrier'
import { QueryRuntimeProvider } from './lib/QueryRuntimeProvider'

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_REFRESH_DEBUG_INSTALLED__?: boolean;
  }
}

if (typeof window !== 'undefined' && !window.__OPENCHAMBER_REFRESH_DEBUG_INSTALLED__) {
  window.__OPENCHAMBER_REFRESH_DEBUG_INSTALLED__ = true;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  console.warn('[refresh-debug] renderer-entry', {
    navigationType: navigation?.type ?? 'unknown',
    protocol: window.location.protocol,
  });
  window.addEventListener('beforeunload', () => {
    console.warn('[refresh-debug] beforeunload', { visibilityState: document.visibilityState });
  });
  window.addEventListener('pagehide', (event) => {
    console.warn('[refresh-debug] pagehide', { persisted: event.persisted });
  });
}

const runtimeAPIs = (typeof window !== 'undefined' && window.__OPENCHAMBER_RUNTIME_APIS__) || (() => {
  throw new Error('Runtime APIs not provided for legacy UI entrypoint.');
})();

initializeLocale();

// Start before React effects so the session pass owns cold-start bandwidth.
if (isDesktopShell()) {
  beginSessionStartupBarrier();
}

// Initialize settings asynchronously — the app renders with defaults first
// and hydrates once persisted preferences are applied. Users with non-default
// themes may briefly see default appearance on cold start; accepted trade-off
// for faster time-to-first-paint.
void runSettingsStartup({
  runtimeKey: getRuntimeKey(),
  initializeAppearance: initializeAppearancePreferences,
  syncSettings: syncDesktopSettings,
  applyDirectory: applyPersistedDirectoryPreferences,
  startWatchers: () => {
    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  },
  onError: (stage, error) => {
    console.error(stage === 'appearance' ? '[main] appearance init failed:' : '[main] settings init failed:', error);
  },
});


const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryRuntimeProvider>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <OpenCodeUpgradeScreen>
              <SessionAuthGate>
                <App apis={runtimeAPIs} />
              </SessionAuthGate>
            </OpenCodeUpgradeScreen>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </QueryRuntimeProvider>
  </StrictMode>,
);
