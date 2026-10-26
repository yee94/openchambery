import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Build-default Capgo channel for self-hosted OTA.
 * Overridable at sync time via YURI_OTA_CHANNEL=stable (mirrors
 * capacitor.config.ts `otaChannel`); keep the default in sync with that gating.
 */
export const YURI_OTA_CHANNEL = 'beta';

/**
 * Native bridge contract version for custom Capacitor plugin surfaces.
 * Bump when any custom plugin method surface changes; OTA manifests declare
 * minShellApiVersion and older shells get install_native_required instead of a broken bundle.
 * Keep in sync with capacitor.config.ts YuriOTA.shellApiVersion.
 */
export const YURI_SHELL_API_VERSION = 3;

export type YuriOtaBundleInfo = {
  id: string;
  version: string;
};

export type YuriOtaDownloadOptions = {
  url: string;
  version: string;
  checksum: string;
  sessionKey?: string;
};

export type YuriOtaCurrentResult = {
  bundle: YuriOtaBundleInfo;
  native: string;
};

export type YuriOtaDeviceIdResult = {
  deviceId: string;
};

export type YuriOtaEventName =
  | 'downloadComplete'
  | 'appReady'
  | 'appReloaded'
  | 'autoRevert'
  | 'noNeedUpdate'
  | 'majorAvailable'
  | 'downloadFailed'
  | 'updateFailed';

export interface YuriUpdaterPlugin {
  notifyAppReady(): Promise<{ bundle: YuriOtaBundleInfo }>;
  download(options: YuriOtaDownloadOptions): Promise<YuriOtaBundleInfo>;
  next(options: { id: string }): Promise<YuriOtaBundleInfo>;
  reload(): Promise<void>;
  current(): Promise<YuriOtaCurrentResult>;
  getDeviceId(): Promise<YuriOtaDeviceIdResult>;
  addListener(
    eventName: YuriOtaEventName,
    listenerFunc: (event: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
  removeListener(handle: PluginListenerHandle): Promise<void>;
  removeAllListeners(): Promise<void>;
}

export const CapacitorUpdaterBridge = registerPlugin<YuriUpdaterPlugin>('CapacitorUpdater');
