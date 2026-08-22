import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Default Capgo channel for self-hosted OTA (must match capacitor.config.ts OpenChamberOTA.channel / CapacitorUpdater.defaultChannel). */
export const OPENCHAMBER_OTA_CHANNEL = 'beta';

/**
 * Native bridge contract version for custom Capacitor plugin surfaces.
 * Bump when any custom plugin method surface changes; OTA manifests declare
 * minShellApiVersion and older shells get install_native_required instead of a broken bundle.
 * Keep in sync with capacitor.config.ts OpenChamberOTA.shellApiVersion.
 */
export const OPENCHAMBER_SHELL_API_VERSION = 1;

export type OpenChamberOtaBundleInfo = {
  id: string;
  version: string;
};

export type OpenChamberOtaDownloadOptions = {
  url: string;
  version: string;
  checksum: string;
  sessionKey?: string;
};

export type OpenChamberOtaCurrentResult = {
  bundle: OpenChamberOtaBundleInfo;
  native: string;
};

export type OpenChamberOtaDeviceIdResult = {
  deviceId: string;
};

export type OpenChamberOtaEventName =
  | 'downloadComplete'
  | 'appReady'
  | 'appReloaded'
  | 'autoRevert'
  | 'noNeedUpdate'
  | 'majorAvailable'
  | 'downloadFailed'
  | 'updateFailed';

export interface OpenChamberUpdaterPlugin {
  notifyAppReady(): Promise<{ bundle: OpenChamberOtaBundleInfo }>;
  download(options: OpenChamberOtaDownloadOptions): Promise<OpenChamberOtaBundleInfo>;
  next(options: { id: string }): Promise<OpenChamberOtaBundleInfo>;
  reload(): Promise<void>;
  current(): Promise<OpenChamberOtaCurrentResult>;
  getDeviceId(): Promise<OpenChamberOtaDeviceIdResult>;
  addListener(
    eventName: OpenChamberOtaEventName,
    listenerFunc: (event: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
  removeListener(handle: PluginListenerHandle): Promise<void>;
  removeAllListeners(): Promise<void>;
}

export const CapacitorUpdaterBridge = registerPlugin<OpenChamberUpdaterPlugin>('CapacitorUpdater');
