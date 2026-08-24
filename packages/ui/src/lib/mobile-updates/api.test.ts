import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativePlatform: false,
  isPluginAvailable: false,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNativePlatform,
    isPluginAvailable: (name: string) => name === 'CapacitorUpdater' && mocks.isPluginAvailable,
    getPlatform: () => 'web',
    getConfig: () => ({}),
  },
  registerPlugin: () => ({
    notifyAppReady: vi.fn(),
    download: vi.fn(),
    next: vi.fn(),
    reload: vi.fn(),
    current: vi.fn(),
    getDeviceId: vi.fn(),
    addListener: vi.fn(),
  }),
}));

import { createMobileUpdatesAPI } from './api';
import { resetCapgoUpdaterCache } from './capgoAdapter';
import { MobileUpdatesUnsupportedError } from './types';

describe('createMobileUpdatesAPI', () => {
  beforeEach(() => {
    resetCapgoUpdaterCache();
    mocks.isNativePlatform = false;
    mocks.isPluginAvailable = false;
  });

  test('non-native hosts report unsupported status', async () => {
    const api = createMobileUpdatesAPI();
    const status = await api.getOtaStatus();
    expect(status.supported).toBe(false);
    expect(status.currentBundleId).toBe('builtin');
  });

  test('non-native checkForOtaUpdate throws MobileUpdatesUnsupportedError', async () => {
    const api = createMobileUpdatesAPI();
    await expect(api.checkForOtaUpdate()).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
  });

  test('non-native download / apply / queue throw unsupported', async () => {
    const api = createMobileUpdatesAPI();
    const bundle = {
      bundleId: 'b1',
      releaseVersion: '1.0.0',
      url: 'https://example.com/b.zip',
      size: 1,
      checksum: 'x',
      minShellApiVersion: 1,
    };
    await expect(api.downloadOtaUpdate(bundle)).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
    await expect(api.applyOtaUpdateNow()).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
    await expect(api.queueOtaUpdateForNextLaunch()).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
  });
});
