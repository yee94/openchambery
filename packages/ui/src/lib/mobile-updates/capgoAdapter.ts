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

type CapgoUpdaterPlugin = {
  notifyAppReady(): Promise<void>;
  download(options: CapgoDownloadOptions): Promise<{ id: string }>;
  next(options: { id: string }): Promise<void>;
  reload(): Promise<void>;
  current(): Promise<CapgoCurrentBundle>;
  getDeviceId(): Promise<{ deviceId: string }>;
  addListener(
    eventName: 'downloadComplete' | 'appReady' | 'appReloaded' | 'autoRevert' | 'noNeedUpdate' | 'majorAvailable',
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
  async addListener(eventName, listener) {
    if (!isCapgoUpdaterAvailable()) unsupported();
    return CapacitorUpdater.addListener(eventName, listener);
  },
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
