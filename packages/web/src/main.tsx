import { createConfiguredWebAPIs, getDesktopRelayRestoreReady } from './runtimeConfig';
import { registerSW } from 'virtual:pwa-register';

import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import type { HostedSurface } from '@openchamber/ui/lib/runtimeSurface';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

const isCoarsePointer = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches;
};

const detectHostedSurface = (): HostedSurface => {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('surface');
  if (override === 'mobile') return 'mobile';
  if (override === 'desktop') return 'desktop';

  const width = Math.min(window.innerWidth || 0, window.screen?.width || window.innerWidth || 0);
  const touchPoints = navigator.maxTouchPoints || 0;
  const likelyPhone = width > 0 && width <= 760 && (touchPoints > 0 || isCoarsePointer());
  return likelyPhone ? 'mobile' : 'desktop';
};

const hostedSurface = detectHostedSurface();
window.__OPENCHAMBER_SURFACE__ = hostedSurface;

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    try {
      registerSW({
        onRegisterError(error: unknown) {
          console.warn('[PWA] service worker registration skipped:', error);
        },
      });
    } catch (error) {
      console.warn('[PWA] service worker registration skipped:', error);
    }
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

const RELOAD_ONCE_KEY = 'openchamber.dev.module-reload';

const isStaleViteOptimizeDepError = (error: unknown): boolean => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  // Vite answers 504 for optimized-dep URLs whose browserHash no longer matches
  // the server's current prebundle; the dynamic import then fails with TypeError.
  return (
    message.includes('Failed to fetch dynamically imported module')
    || message.includes('Outdated Optimize Dep')
    || message.includes('error loading dynamically imported module')
  );
};

/**
 * Vite can leave open tabs holding stale optimized-dep URLs after a dep
 * re-optimization. One hard navigation with a cache-bust query recovers;
 * only runs for the known stale-dep failure shape, and only once per session.
 */
const recoverFromStaleModuleImport = (error: unknown, label: string): void => {
  console.error(`[openchamber] failed to load ${label}:`, error);
  if (typeof window === 'undefined' || !import.meta.env.DEV) return;
  if (!isStaleViteOptimizeDepError(error)) return;
  try {
    if (sessionStorage.getItem(RELOAD_ONCE_KEY) === '1') {
      sessionStorage.removeItem(RELOAD_ONCE_KEY);
      return;
    }
    sessionStorage.setItem(RELOAD_ONCE_KEY, '1');
    const url = new URL(window.location.href);
    url.searchParams.set('_oc_vite', String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    // sessionStorage/URL may be unavailable; leave the console error as the signal.
  }
};

if (hostedSurface === 'mobile') {
  void import('@openchamber/ui/apps/renderMobileApp')
    .then(({ renderMobileApp }) => {
      try {
        sessionStorage.removeItem(RELOAD_ONCE_KEY);
      } catch {
        // ignore
      }
      renderMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
    })
    .catch((error) => recoverFromStaleModuleImport(error, 'renderMobileApp'));
} else {
  // Hold the render (HTML splash stays up) until a desktop relay-host restore
  // has picked its transport — otherwise the app boots against a not-yet-chosen
  // endpoint and flashes the auth screen before the tunnel connects. Resolves
  // immediately when no relay host is involved.
  void getDesktopRelayRestoreReady()
    .then(() => import('@openchamber/ui/main'))
    .then(() => {
      try {
        sessionStorage.removeItem(RELOAD_ONCE_KEY);
      } catch {
        // ignore
      }
    })
    .catch((error) => recoverFromStaleModuleImport(error, 'desktop main'));
}

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
