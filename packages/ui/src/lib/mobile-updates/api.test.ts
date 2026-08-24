import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativePlatform: false,
  isPluginAvailable: false,
  findDownloadedOtaBundle: vi.fn(async (): Promise<string | null> => null),
  downloadOtaBundle: vi.fn(async () => 'dl-fresh'),
  applyDownloadedBundleNow: vi.fn(async () => undefined),
  queueDownloadedBundle: vi.fn(async () => undefined),
  checkMobileOtaUpdate: vi.fn(async () => ({
    status: 'ok' as const,
    primaryAction: 'none' as const,
    ota: { state: 'current' as const },
    native: { state: 'current' as const },
    nextCheckInSec: 3600,
  })),
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
    list: vi.fn(),
    addListener: vi.fn(),
  }),
}));

vi.mock('./coordinator', () => ({
  checkMobileOtaUpdate: mocks.checkMobileOtaUpdate,
  downloadOtaBundle: mocks.downloadOtaBundle,
  findDownloadedOtaBundle: mocks.findDownloadedOtaBundle,
  applyDownloadedBundleNow: mocks.applyDownloadedBundleNow,
  queueDownloadedBundle: mocks.queueDownloadedBundle,
}));

import { createMobileUpdatesAPI } from './api';
import { resetCapgoUpdaterCache } from './capgoAdapter';
import { MobileUpdatesUnsupportedError } from './types';

const sampleBundle = {
  bundleId: 'b1',
  releaseVersion: '1.0.0',
  url: 'https://example.com/b.zip',
  size: 1,
  checksum: 'x',
  minShellApiVersion: 1,
};

describe('createMobileUpdatesAPI', () => {
  beforeEach(() => {
    resetCapgoUpdaterCache();
    mocks.isNativePlatform = false;
    mocks.isPluginAvailable = false;
    mocks.findDownloadedOtaBundle.mockResolvedValue(null);
    mocks.downloadOtaBundle.mockResolvedValue('dl-fresh');
    vi.clearAllMocks();
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
    await expect(api.downloadOtaUpdate(sampleBundle)).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
    await expect(api.applyOtaUpdateNow()).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
    await expect(api.queueOtaUpdateForNextLaunch()).rejects.toBeInstanceOf(MobileUpdatesUnsupportedError);
  });

  test('downloadOtaUpdate skips download when a local bundle already matches', async () => {
    mocks.isNativePlatform = true;
    mocks.isPluginAvailable = true;
    mocks.findDownloadedOtaBundle.mockResolvedValue('local-existing');

    const api = createMobileUpdatesAPI();
    const result = await api.downloadOtaUpdate(sampleBundle);

    expect(result).toEqual({ skipped: true });
    expect(mocks.findDownloadedOtaBundle).toHaveBeenCalledWith(sampleBundle);
    expect(mocks.downloadOtaBundle).not.toHaveBeenCalled();

    await api.queueOtaUpdateForNextLaunch();
    expect(mocks.queueDownloadedBundle).toHaveBeenCalledWith('local-existing');
  });

  test('downloadOtaUpdate downloads when no reusable local bundle exists', async () => {
    mocks.isNativePlatform = true;
    mocks.isPluginAvailable = true;
    mocks.findDownloadedOtaBundle.mockResolvedValue(null);
    mocks.downloadOtaBundle.mockResolvedValue('dl-fresh');

    const api = createMobileUpdatesAPI();
    const result = await api.downloadOtaUpdate(sampleBundle);

    expect(result).toEqual({ skipped: false });
    expect(mocks.downloadOtaBundle).toHaveBeenCalledWith(sampleBundle);

    await api.queueOtaUpdateForNextLaunch();
    expect(mocks.queueDownloadedBundle).toHaveBeenCalledWith('dl-fresh');
  });
});
