import { Capacitor } from '@capacitor/core';

import type { MobileUpdatesAPI } from '@/lib/api/types';

import { getCapgoUpdater, isCapgoUpdaterSupported } from './capgoAdapter';
import {
  applyDownloadedBundleNow,
  checkMobileOtaUpdate,
  downloadOtaBundle,
  queueDownloadedBundle,
} from './coordinator';
import type { MobileOtaBundleInfo } from './types';
import { MobileUpdatesUnsupportedError } from './types';

declare const __APP_VERSION__: string | undefined;

/** Last Capgo download id from `downloadOtaUpdate` — used by queue/apply helpers. */
let lastDownloadedBundleId: string | null = null;

const nonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const resolveNativeVersion = async (): Promise<string> => {
  const bundled = typeof __APP_VERSION__ !== 'undefined' ? nonEmptyString(__APP_VERSION__) : null;
  try {
    if (Capacitor.isNativePlatform()) {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      return nonEmptyString(info.version) ?? bundled ?? 'unknown';
    }
  } catch {
    // Fall through.
  }
  return bundled ?? 'unknown';
};

/**
 * Capacitor-native OTA surface. Web / desktop / VS Code hosts compose this
 * factory too; non-native callers get explicit unsupported semantics.
 */
export const createMobileUpdatesAPI = (): MobileUpdatesAPI => ({
  async checkForOtaUpdate() {
    if (!isCapgoUpdaterSupported() && !Capacitor.isNativePlatform()) {
      throw new MobileUpdatesUnsupportedError();
    }
    return checkMobileOtaUpdate();
  },

  async downloadOtaUpdate(bundle: MobileOtaBundleInfo) {
    if (!isCapgoUpdaterSupported()) throw new MobileUpdatesUnsupportedError();
    lastDownloadedBundleId = await downloadOtaBundle(bundle);
  },

  async applyOtaUpdateNow() {
    if (!isCapgoUpdaterSupported()) throw new MobileUpdatesUnsupportedError();
    await applyDownloadedBundleNow();
  },

  async queueOtaUpdateForNextLaunch() {
    if (!isCapgoUpdaterSupported()) throw new MobileUpdatesUnsupportedError();
    const id = lastDownloadedBundleId;
    if (!id) throw new Error('No downloaded OTA bundle to queue');
    await queueDownloadedBundle(id);
  },

  async getOtaStatus() {
    if (!isCapgoUpdaterSupported()) {
      return {
        supported: false,
        currentBundleId: 'builtin',
        nativeVersion: await resolveNativeVersion(),
      };
    }

    const updater = await getCapgoUpdater();
    if (!updater) {
      return {
        supported: false,
        currentBundleId: 'builtin',
        nativeVersion: await resolveNativeVersion(),
      };
    }

    try {
      const [current, nativeVersion] = await Promise.all([
        updater.current(),
        resolveNativeVersion(),
      ]);
      const bundleId = nonEmptyString(current.bundle?.id) || 'builtin';
      return {
        supported: true,
        currentBundleId: bundleId,
        nativeVersion,
      };
    } catch {
      return {
        supported: true,
        currentBundleId: 'builtin',
        nativeVersion: await resolveNativeVersion(),
      };
    }
  },
});
