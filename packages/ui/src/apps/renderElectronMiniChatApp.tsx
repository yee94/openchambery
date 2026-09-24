import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { OpenCodeUpgradeScreen } from '@/components/update/OpenCodeUpgradeScreen';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { QueryRuntimeProvider } from '@/lib/QueryRuntimeProvider';
import { ElectronMiniChatApp } from './ElectronMiniChatApp';

const initializeSharedPreferences = () => {
  initializeLocale();

  void initializeAppearancePreferences().then(() => {
    void Promise.all([
      syncDesktopSettings(),
      applyPersistedDirectoryPreferences(),
    ]).catch((err) => {
      console.error('[mini-chat-main] settings init failed:', err);
    });

    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error('[mini-chat-main] appearance init failed:', err);
  });
};

export function renderElectronMiniChatApp(apis: RuntimeAPIs) {
  initializeSharedPreferences();

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
                  <ElectronMiniChatApp apis={apis} />
                </SessionAuthGate>
              </OpenCodeUpgradeScreen>
            </ThemeProvider>
          </ThemeSystemProvider>
        </I18nProvider>
      </QueryRuntimeProvider>
    </StrictMode>,
  );
}
