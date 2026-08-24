import { Capacitor, registerPlugin } from '@capacitor/core';

import { MobileUpdatesUnsupportedError } from './types';

type PluginListenerHandle = {
  remove: () => Promise<void>;
};

type CapgoDownloadOptions = {
  url: string;
  version: string;
  checksum: string;
  sessionKey?: string;
};

type CapgoCurrentBundle = {
  bundle: { id: string; version: string };
  native: string;
};

export type CapgoLocalBundleStatus =
  | 'success'
  | 'error'
  | 'pending'
  | 'downloading'
  | 'deleted'
  | 'deleting';

/** Local Capgo bundle row from `list()` — mirrors plugin BundleInfo. */
export type CapgoLocalBundleInfo = {
  id: string;
  version: string;
  downloaded: string;
  checksum: string;
  status: CapgoLocalBundleStatus;
};

export type CapgoDownloadEvent = {
  percent: number;
  bundle: { id: string; version: string };
};

export type CapgoDownloadFailedEvent = {
  version: string;
};

type CapgoLegacyEventName =
  | 'downloadComplete'
  | 'appReady'
  | 'appReloaded'
  | 'autoRevert'
  | 'noNeedUpdate'
  | 'majorAvailable';

type CapgoUpdaterPlugin = {
  notifyAppReady(): Promise<void>;
  download(options: CapgoDownloadOptions): Promise<{ id: string }>;
  next(options: { id: string }): Promise<void>;
  reload(): Promise<void>;
  current(): Promise<CapgoCurrentBundle>;
  getDeviceId(): Promise<{ deviceId: string }>;
  list(): Promise<{ bundles: CapgoLocalBundleInfo[] }>;
  addListener(
    eventName: 'download',
    listener: (event: CapgoDownloadEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'downloadFailed',
    listener: (event: CapgoDownloadFailedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: CapgoLegacyEventName,
    listener: (event: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
};

const CapacitorUpdater = registerPlugin<CapgoUpdaterPlugin>('CapacitorUpdater');

const isCapgoUpdaterAvailable = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('CapacitorUpdater');
  } catch {
    return false;
  }
};

const unsupported = (): never => {
  throw new MobileUpdatesUnsupportedError();
};

/** Thin typed wrapper that fails closed on web / non-native hosts. */
export type CapgoUpdater = {
  notifyAppReady(): Promise<void>;
  download(options: CapgoDownloadOptions): Promise<{ id: string }>;
  next(options: { id: string }): Promise<void>;
  reload(): Promise<void>;
  current(): Promise<CapgoCurrentBundle>;
  getDeviceId(): Promise<{ deviceId: string }>;
  list(): Promise<{ bundles: CapgoLocalBundleInfo[] }>;
  addListener: CapgoUpdaterPlugin['addListener'];
};

const createCapgoUpdater = (): CapgoUpdater => ({
  async notifyAppReady() {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.notifyAppReady();
  },
  async download(options) {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.download(options);
  },
  async next(options) {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.next(options);
  },
  async reload() {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.reload();
  },
  async current() {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.current();
  },
  async getDeviceId() {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.getDeviceId();
  },
  async list() {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.list();
  },
  // Implementation signature collapses overload unions; cast preserves typed addListener.
  addListener: ((async (eventName: string, listener: (event: never) => void) => {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return (CapacitorUpdater.addListener as (
      eventName: string,
      listener: (event: never) => void,
    ) => Promise<PluginListenerHandle>)(eventName, listener);
  }) as CapgoUpdaterPlugin['addListener']),
});

let cachedUpdater: CapgoUpdater | null | undefined;

/**
 * Returns the Capgo updater adapter when the native plugin is present.
 * Web / hosted-mobile callers receive `null` instead of throwing.
 */
export const getCapgoUpdater = async (): Promise<CapgoUpdater | null> => {
  if (cachedUpdater !== undefined) return cachedUpdater;
  if (!isCapgoUpdaterAvailable()) {
    cachedUpdater = null;
    return null;
  }
  cachedUpdater = createCapgoUpdater();
  return cachedUpdater;
};

/** Test helper — clears the memoized adapter. */
export const resetCapgoUpdaterCache = (): void => {
  cachedUpdater = undefined;
};

export const isCapgoUpdaterSupported = (): boolean => isCapgoUpdaterAvailable();
