import { create } from 'zustand';
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import { getDeviceInfo } from '@/lib/device';
import { useUIStore } from './useUIStore';
import {
  checkForDesktopUpdates,
  downloadDesktopUpdate,
  listenDesktopUpdateProgress,
  listenDesktopUpdateReady,
  restartToApplyUpdate,
  isDesktopLocalOriginActive,
  isElectronShell,
  isVSCodeRuntime,
  isWebRuntime,
} from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';
import { getMobileClientVersion } from '@/lib/mobileAppVersion';
import { checkForMobileClientUpdates } from '@/lib/mobileClientUpdateCheck';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { MobileUpdateDecision } from '@/lib/mobile-updates/types';
import { MobileUpdatesUnsupportedError } from '@/lib/mobile-updates/types';

type OtaPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'pending_restart' | 'error';

type UpdateState = {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  runtimeType: 'desktop' | 'web' | 'vscode' | 'mobile' | null;
  lastChecked: number | null;
  nextCheckInSec: number | null;
  /** Latest Capgo OTA decision from the mobile update service (Capacitor only). */
  otaDecision: MobileUpdateDecision | null;
  /** Capgo download / apply lifecycle phase (Capacitor only). */
  otaPhase: OtaPhase;
};

interface UpdateStore extends UpdateState {
  checkForUpdates: () => Promise<number | null>;
  downloadUpdate: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  /** Wire main-process idle/manual download events into store state. */
  subscribeDesktopUpdateEvents: () => Promise<() => void>;
  setOtaPhase: (phase: OtaPhase, error?: string | null) => void;
  dismiss: () => void;
  reset: () => void;
}

type ClientRuntime = 'desktop' | 'web' | 'vscode' | 'mobile';

function detectDeviceClass(): 'mobile' | 'tablet' | 'desktop' | 'unknown' {
  if (typeof window === 'undefined') return 'unknown';
  try {
    const { deviceType } = getDeviceInfo();
    return deviceType;
  } catch {
    return 'unknown';
  }
}

function detectArch(): 'arm64' | 'x64' | 'unknown' {
  const vscodeArch = typeof window !== 'undefined'
    ? (window as { __VSCODE_CONFIG__?: { arch?: string } }).__VSCODE_CONFIG__?.arch?.toLowerCase?.()
    : undefined;
  if (vscodeArch === 'arm64' || vscodeArch === 'aarch64') return 'arm64';
  if (vscodeArch === 'x64' || vscodeArch === 'amd64' || vscodeArch === 'x86_64') return 'x64';

  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { userAgentData?: { architecture?: string } }).userAgentData : undefined;
  const fromUAData = nav?.architecture?.toLowerCase?.();
  if (fromUAData === 'arm' || fromUAData === 'arm64' || fromUAData === 'aarch64') return 'arm64';
  if (fromUAData === 'x86' || fromUAData === 'x64' || fromUAData === 'amd64') return 'x64';

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  if (ua.includes('aarch64') || ua.includes('arm64') || ua.includes('armv')) return 'arm64';
  if (ua.includes('x86_64') || ua.includes('x64') || ua.includes('amd64') || ua.includes('win64')) return 'x64';
  return 'unknown';
}

function detectPlatform(): 'macos' | 'windows' | 'linux' | 'web' | 'android' | 'ios' {
  const clientPlatform = getClientPlatform();
  if (clientPlatform === 'android' || clientPlatform === 'ios') return clientPlatform;
  if (typeof navigator === 'undefined') return 'web';
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'web';
}

function mapRuntimeParams(runtime: ClientRuntime): URLSearchParams {
  // Check if user has opted in to usage reporting (default: false from UI store)
  const shouldReportUsage = useUIStore.getState().reportUsage;
  
  const params = new URLSearchParams({ reportUsage: shouldReportUsage ? 'true' : 'false' });
  params.set('deviceClass', detectDeviceClass());
  params.set('arch', detectArch());
  params.set('platform', detectPlatform());
  if (runtime === 'desktop') {
    params.set('appType', 'desktop-electron');
    params.set('instanceMode', isDesktopLocalOriginActive() ? 'local' : 'remote');
    return params;
  }

  if (runtime === 'vscode') {
    params.set('appType', 'vscode');
    params.set('instanceMode', 'local');
    return params;
  }

  if (runtime === 'mobile') {
    params.set('appType', 'mobile-capacitor');
    params.set('instanceMode', 'remote');
    return params;
  }

  params.set('appType', 'web');
  params.set('instanceMode', 'unknown');
  return params;
}

async function checkForWebUpdates(runtime: ClientRuntime, currentVersion?: string): Promise<UpdateInfo | null> {
  const resolvedCurrentVersion = currentVersion ?? 'unknown';
  try {
    const params = mapRuntimeParams(runtime);
    const vscodeVersion = typeof window !== 'undefined'
      ? (window as { __VSCODE_CONFIG__?: { extensionVersion?: string } }).__VSCODE_CONFIG__?.extensionVersion
      : undefined;
    if (currentVersion) params.set('currentVersion', currentVersion);
    else if (runtime === 'vscode' && vscodeVersion) params.set('currentVersion', vscodeVersion);
    const response = await runtimeFetch(`/api/openchamber/update-check?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const responseError = typeof data?.error === 'string' && data.error.trim().length > 0
        ? data.error.trim()
        : `Server responded with ${response.status}`;
      return {
        available: false,
        currentVersion: resolvedCurrentVersion,
        error: responseError,
      };
    }

    if (!data) {
      return {
        available: false,
        currentVersion: resolvedCurrentVersion,
        error: 'Update check returned an invalid response',
      };
    }

    const responseError = typeof data.error === 'string' && data.error.trim().length > 0
      ? data.error.trim()
      : undefined;

    return {
      available: data.available === true,
      version: typeof data.version === 'string' ? data.version : undefined,
      currentVersion: typeof data.currentVersion === 'string' ? data.currentVersion : resolvedCurrentVersion,
      body: typeof data.body === 'string' ? data.body : undefined,
      releaseUrl: typeof data.releaseUrl === 'string' ? data.releaseUrl : undefined,
      downloadUrl: typeof data.downloadUrl === 'string' ? data.downloadUrl : undefined,
      nextSuggestedCheckInSec:
        typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
      packageManager: typeof data.packageManager === 'string' ? data.packageManager : undefined,
      updateCommand: typeof data.updateCommand === 'string' ? data.updateCommand : undefined,
      error: responseError,
    };
  } catch (error) {
    console.warn('Failed to check for updates:', error);
    return {
      available: false,
      currentVersion: resolvedCurrentVersion,
      error: error instanceof Error ? error.message : 'Failed to check for updates',
    };
  }
}

function detectRuntimeType(): 'desktop' | 'web' | 'vscode' | 'mobile' | null {
  if (isCapacitorApp()) {
    return 'mobile';
  }
  if (isElectronShell()) {
    return 'desktop';
  }
  if (isVSCodeRuntime()) return 'vscode';
  if (isWebRuntime()) return 'web';
  return null;
}

const initialState: UpdateState = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  info: null,
  progress: null,
  error: null,
  runtimeType: null,
  lastChecked: null,
  nextCheckInSec: null,
  otaDecision: null,
  otaPhase: 'idle',
};

function mapOtaDecisionToUpdateInfo(
  decision: MobileUpdateDecision,
  currentVersion: string,
): { info: UpdateInfo; available: boolean; otaPhase: OtaPhase } {
  if (decision.primaryAction === 'apply_ota' && decision.ota.bundle) {
    return {
      available: true,
      otaPhase: 'available',
      info: {
        available: true,
        version: decision.ota.bundle.releaseVersion,
        currentVersion,
        downloadUrl: decision.ota.bundle.url,
        nextSuggestedCheckInSec: decision.nextCheckInSec,
        inAppApply: true,
      },
    };
  }

  if (decision.primaryAction === 'install_native_required') {
    return {
      available: decision.native.state === 'required' || decision.native.state === 'available',
      otaPhase: 'idle',
      info: {
        available: decision.native.state === 'required' || decision.native.state === 'available',
        version: decision.native.version,
        currentVersion,
        downloadUrl: decision.native.installUrl,
        nextSuggestedCheckInSec: decision.nextCheckInSec,
        manualUpdate: true,
      },
    };
  }

  return {
    available: false,
    otaPhase: 'idle',
    info: {
      available: false,
      currentVersion,
      nextSuggestedCheckInSec: decision.nextCheckInSec,
    },
  };
}

export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  ...initialState,

  checkForUpdates: async () => {
    const runtime = detectRuntimeType();
    if (!runtime) return null;

    set({ checking: true, error: null, runtimeType: runtime });

    try {
      let info: UpdateInfo | null = null;
      let suggestedSec: number | null = null;

      if (runtime === 'desktop') {
        const desktopInfo = await checkForDesktopUpdates();
        const alreadyDownloaded = desktopInfo?.downloaded === true;
        set({
          checking: false,
          available: desktopInfo?.available ?? false,
          // Main may already have finished an idle auto-download for this version.
          // Idle downloads stay silent until the user clicks "Download Update".
          downloaded: alreadyDownloaded,
          // If main already has the package, clear any foreground download UI.
          ...(alreadyDownloaded ? { downloading: false, progress: null } : {}),
          info: desktopInfo,
          error: null,
          lastChecked: Date.now(),
          nextCheckInSec: null,
        });

        return suggestedSec;
      } else if (runtime === 'web') {
        info = await checkForWebUpdates('web');
        suggestedSec = info?.nextSuggestedCheckInSec ?? null;
      } else if (runtime === 'vscode') {
        const vscodeInfo = await checkForWebUpdates('vscode');
        suggestedSec = vscodeInfo?.nextSuggestedCheckInSec ?? null;
      } else if (runtime === 'mobile') {
        const appVersion = await getMobileClientVersion();
        const currentVersion = appVersion ?? 'unknown';
        const mobileUpdates = isCapacitorApp()
          ? getRegisteredRuntimeAPIs()?.mobileUpdates
          : undefined;

        if (mobileUpdates) {
          try {
            set({ otaPhase: 'checking' });
            const decision = await mobileUpdates.checkForOtaUpdate();
            const mapped = mapOtaDecisionToUpdateInfo(decision, currentVersion);

            // Native-required keeps the legacy GitHub/release check for install URLs
            // when the OTA decision did not include one.
            if (
              decision.primaryAction === 'install_native_required'
              && !mapped.info.downloadUrl
            ) {
              const legacy = await checkForMobileClientUpdates({
                currentVersion,
                platform: detectPlatform() === 'ios' ? 'ios' : 'android',
                deviceClass: detectDeviceClass(),
                arch: detectArch(),
                reportUsage: useUIStore.getState().reportUsage,
              });
              mapped.info = {
                ...mapped.info,
                ...legacy,
                available: true,
                manualUpdate: true,
                nextSuggestedCheckInSec: decision.nextCheckInSec,
              };
              mapped.available = true;
            }

            set({
              checking: false,
              available: mapped.available,
              info: mapped.info,
              error: mapped.info.error ?? null,
              lastChecked: Date.now(),
              nextCheckInSec: decision.nextCheckInSec,
              otaDecision: decision,
              otaPhase: mapped.otaPhase,
            });
            return decision.nextCheckInSec;
          } catch (error) {
            if (!(error instanceof MobileUpdatesUnsupportedError)) {
              // Network / service failure: fall back to the existing stable-channel check.
              console.warn('[OTA] check failed, falling back to legacy mobile update check:', error);
            }
          }
        }

        // Capacitor client updates compare the native APK/IPA version against
        // public update feeds directly. Do not route this through the connected
        // OpenChamber Server — that instance's network and version are unrelated.
        info = await checkForMobileClientUpdates({
          currentVersion,
          platform: detectPlatform() === 'ios' ? 'ios' : 'android',
          deviceClass: detectDeviceClass(),
          arch: detectArch(),
          reportUsage: useUIStore.getState().reportUsage,
        });
        suggestedSec = info?.nextSuggestedCheckInSec ?? null;
        set({
          checking: false,
          available: info?.available ?? false,
          info,
          error: info?.error ?? null,
          lastChecked: Date.now(),
          nextCheckInSec: suggestedSec,
          otaDecision: null,
          otaPhase: 'idle',
        });
        return suggestedSec;
      }

      set({
        checking: false,
        available: runtime === 'vscode' ? false : (info?.available ?? false),
        info: runtime === 'vscode' ? null : info,
        error: runtime === 'vscode' ? null : (info?.error ?? null),
        lastChecked: Date.now(),
        nextCheckInSec: suggestedSec,
      });
      return suggestedSec;
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
      return null;
    }
  },

  downloadUpdate: async () => {
    const { available, runtimeType, otaDecision, downloading, downloaded } = get();

    if (
      runtimeType === 'mobile'
      && otaDecision?.primaryAction === 'apply_ota'
      && otaDecision.ota.bundle
    ) {
      if (downloading || downloaded) return;

      const mobileUpdates = getRegisteredRuntimeAPIs()?.mobileUpdates;
      if (!mobileUpdates) {
        set({
          error: 'Mobile OTA updates are unavailable in this runtime',
          otaPhase: 'error',
        });
        return;
      }

      set({ downloading: true, error: null, progress: null, otaPhase: 'downloading' });
      try {
        await mobileUpdates.downloadOtaUpdate(otaDecision.ota.bundle);
        await mobileUpdates.queueOtaUpdateForNextLaunch();
        set({
          downloading: false,
          downloaded: true,
          progress: null,
          otaPhase: 'pending_restart',
        });
        await mobileUpdates.applyOtaUpdateNow();
      } catch (error) {
        set({
          downloading: false,
          error: error instanceof Error ? error.message : 'Failed to download update',
          otaPhase: 'error',
        });
      }
      return;
    }

    // For web runtime, there's no download - user uses in-app update or CLI
    if (runtimeType !== 'desktop' || !available) {
      return;
    }

    // Enter the foreground download UI only after the user clicks Download.
    // If main already has an idle download in flight, seed progress from that
    // snapshot so the bar does not restart at 0%.
    set({ downloading: true, error: null, progress: null });

    try {
      const desktopInfo = await checkForDesktopUpdates();
      if (!desktopInfo?.available) {
        throw new Error('Update detected, but desktop package is not ready yet. Retry in a moment.');
      }

      set((state) => ({
        info: state.info
          ? {
            ...state.info,
            ...desktopInfo,
            // Keep the richer sidecar-sourced changelog; desktopInfo.body is
            // often the bare "See release notes at..." fallback from the
            // updater and would otherwise clobber the nice changelog.
            body: state.info.body || desktopInfo.body,
            available: state.info.available,
          }
          : desktopInfo,
      }));

      // Already idle-downloaded while the dialog was open — just flip the CTA.
      if (desktopInfo.downloaded || get().downloaded) {
        set({ downloading: false, downloaded: true, progress: null });
        return;
      }

      // Promote an in-flight idle download into the dialog progress UI.
      if (desktopInfo.downloading) {
        set({
          downloading: true,
          progress: desktopInfo.progress ?? { downloaded: 0 },
        });
      }

      const ok = await downloadDesktopUpdate((progress) => {
        set({ progress });
      });
      if (!ok) {
        throw new Error('Failed to download update');
      }
      set({ downloading: false, downloaded: true, progress: null });
    } catch (error) {
      set({
        downloading: false,
        error: error instanceof Error ? error.message : 'Failed to download update',
      });
    }
  },

  subscribeDesktopUpdateEvents: async () => {
    if (!isElectronShell()) {
      return () => {};
    }

    const cleanups: Array<() => void | Promise<void>> = [];

    const unlistenProgress = await listenDesktopUpdateProgress((payload) => {
      const eventName = payload.event;
      const eventData = payload.data ?? null;

      // Idle auto-download stays silent. Progress only drives the dialog bar
      // after the user clicks "Download Update" (store.downloading === true).
      if (eventName === 'Started') {
        if (!get().downloading) return;
        set({
          error: null,
          progress: {
            downloaded: 0,
            total: typeof eventData?.contentLength === 'number' ? eventData.contentLength : undefined,
          },
        });
        return;
      }

      if (eventName === 'Progress') {
        if (!get().downloading) return;
        const downloaded = typeof eventData?.downloaded === 'number' ? eventData.downloaded : 0;
        const total = typeof eventData?.total === 'number' ? eventData.total : undefined;
        set({ progress: { downloaded, total } });
        return;
      }

      if (eventName === 'Finished') {
        set({ downloading: false, downloaded: true, progress: null });
      }
    });
    if (unlistenProgress) cleanups.push(unlistenProgress);

    const unlistenReady = await listenDesktopUpdateReady((payload) => {
      if (payload.downloaded) {
        // Idle or manual completion: flip CTA to Restart without forcing a
        // progress bar if the user never entered the foreground download UI.
        set({ downloading: false, downloaded: true, available: true, progress: null });
      }
    });
    if (unlistenReady) cleanups.push(unlistenReady);

    return async () => {
      for (const cleanup of cleanups) {
        try {
          const result = cleanup();
          if (result instanceof Promise) await result;
        } catch {
          // ignore listener teardown failures
        }
      }
    };
  },

  restartToUpdate: async () => {
    const { downloaded, runtimeType, otaDecision } = get();

    if (
      runtimeType === 'mobile'
      && otaDecision?.primaryAction === 'apply_ota'
    ) {
      if (!downloaded) return;

      const mobileUpdates = getRegisteredRuntimeAPIs()?.mobileUpdates;
      if (!mobileUpdates) {
        set({
          error: 'Mobile OTA updates are unavailable in this runtime',
          otaPhase: 'error',
        });
        return;
      }

      try {
        await mobileUpdates.applyOtaUpdateNow();
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to restart',
          otaPhase: 'error',
        });
      }
      return;
    }

    if (runtimeType !== 'desktop' || !downloaded) {
      return;
    }

    try {
      const ok = await restartToApplyUpdate();
      if (!ok) {
        throw new Error('Failed to restart');
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to restart',
      });
    }
  },

  setOtaPhase: (phase, error = null) => {
    set({
      otaPhase: phase,
      ...(error !== undefined ? { error } : {}),
    });
  },

  dismiss: () => {
    set({ available: false, downloaded: false, info: null, otaDecision: null, otaPhase: 'idle' });
  },

  reset: () => {
    set(initialState);
  },
}));
