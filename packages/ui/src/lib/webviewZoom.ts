import '@/lib/brand-storage-bootstrap';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';

/** Chromium/webview zoom bounds — matches typical Electron zoomIn/Out range. */
export const WEBVIEW_ZOOM_MIN = 0.5;
export const WEBVIEW_ZOOM_MAX = 3;
export const WEBVIEW_ZOOM_STEP = 0.1;
export const WEBVIEW_ZOOM_DEFAULT = 1;

const WEB_ZOOM_STORAGE_KEY = 'yuri.webviewZoomFactor';

const clampZoomFactor = (factor: number): number => {
  if (!Number.isFinite(factor)) return WEBVIEW_ZOOM_DEFAULT;
  return Math.min(WEBVIEW_ZOOM_MAX, Math.max(WEBVIEW_ZOOM_MIN, Math.round(factor * 100) / 100));
};

const readStoredWebZoomFactor = (): number => {
  if (typeof window === 'undefined') return WEBVIEW_ZOOM_DEFAULT;
  try {
    const raw = window.localStorage.getItem(WEB_ZOOM_STORAGE_KEY);
    if (!raw) return WEBVIEW_ZOOM_DEFAULT;
    return clampZoomFactor(Number.parseFloat(raw));
  } catch {
    return WEBVIEW_ZOOM_DEFAULT;
  }
};

const writeStoredWebZoomFactor = (factor: number): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_ZOOM_STORAGE_KEY, String(factor));
  } catch {
    // ignore quota / private-mode failures
  }
};

const applyCssZoomFactor = (factor: number): number => {
  const next = clampZoomFactor(factor);
  if (typeof document !== 'undefined') {
    document.documentElement.style.zoom = next === WEBVIEW_ZOOM_DEFAULT ? '' : String(next);
  }
  writeStoredWebZoomFactor(next);
  return next;
};

const readCssZoomFactor = (): number => {
  if (typeof document === 'undefined') return WEBVIEW_ZOOM_DEFAULT;
  const raw = document.documentElement.style.zoom;
  if (!raw) return readStoredWebZoomFactor();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? clampZoomFactor(parsed) : readStoredWebZoomFactor();
};

/** Restore CSS zoom on web/VS Code after reload (Electron restores via main). */
export const restoreWebviewZoomFactor = (): void => {
  if (canUseElectronDesktopIPC()) return;
  const stored = readStoredWebZoomFactor();
  if (stored !== WEBVIEW_ZOOM_DEFAULT) {
    applyCssZoomFactor(stored);
  }
};

/** Increase Chromium/webview zoom (desktop IPC or CSS zoom fallback). */
export const zoomWebviewIn = async (): Promise<number> => {
  if (canUseElectronDesktopIPC()) {
    try {
      const result = await invokeDesktop<number>('desktop_zoom_in');
      if (typeof result === 'number' && Number.isFinite(result)) {
        return clampZoomFactor(result);
      }
    } catch (error) {
      // Old Electron main without desktop_zoom_* — fall through to CSS zoom.
      console.warn('[webview-zoom] desktop_zoom_in failed, using CSS zoom', error);
    }
  }
  return applyCssZoomFactor(readCssZoomFactor() + WEBVIEW_ZOOM_STEP);
};

/** Decrease Chromium/webview zoom (desktop IPC or CSS zoom fallback). */
export const zoomWebviewOut = async (): Promise<number> => {
  if (canUseElectronDesktopIPC()) {
    try {
      const result = await invokeDesktop<number>('desktop_zoom_out');
      if (typeof result === 'number' && Number.isFinite(result)) {
        return clampZoomFactor(result);
      }
    } catch (error) {
      console.warn('[webview-zoom] desktop_zoom_out failed, using CSS zoom', error);
    }
  }
  return applyCssZoomFactor(readCssZoomFactor() - WEBVIEW_ZOOM_STEP);
};

/** Reset Chromium/webview zoom to 100%. */
export const resetWebviewZoom = async (): Promise<number> => {
  if (canUseElectronDesktopIPC()) {
    try {
      const result = await invokeDesktop<number>('desktop_zoom_reset');
      if (typeof result === 'number' && Number.isFinite(result)) {
        return clampZoomFactor(result);
      }
    } catch (error) {
      console.warn('[webview-zoom] desktop_zoom_reset failed, using CSS zoom', error);
    }
  }
  return applyCssZoomFactor(WEBVIEW_ZOOM_DEFAULT);
};
