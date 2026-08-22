import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mobileUpdates = {
    checkForOtaUpdate: vi.fn(),
    downloadOtaUpdate: vi.fn(),
    applyOtaUpdateNow: vi.fn(),
    queueOtaUpdateForNextLaunch: vi.fn(),
    getOtaStatus: vi.fn(),
  };
  const legacyCheck = vi.fn();
  return {
    mobileUpdates,
    legacyCheck,
    isCapacitor: true,
    registeredApis: { mobileUpdates } as { mobileUpdates?: typeof mobileUpdates } | null,
  };
});

vi.mock('@/lib/platform', () => ({
  isCapacitorApp: () => mocks.isCapacitor,
  getClientPlatform: () => 'ios',
}));

vi.mock('@/lib/desktop', () => ({
  checkForDesktopUpdates: vi.fn(),
  downloadDesktopUpdate: vi.fn(),
  listenDesktopUpdateProgress: vi.fn(async () => () => undefined),
  listenDesktopUpdateReady: vi.fn(async () => () => undefined),
  restartToApplyUpdate: vi.fn(),
  isDesktopLocalOriginActive: () => false,
  isElectronShell: () => false,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => false,
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: vi.fn(),
}));

vi.mock('@/lib/device', () => ({
  getDeviceInfo: () => ({ deviceType: 'mobile' }),
}));

vi.mock('@/lib/mobileAppVersion', () => ({
  getMobileClientVersion: vi.fn(async () => '1.2.3'),
}));

vi.mock('@/lib/mobileClientUpdateCheck', () => ({
  checkForMobileClientUpdates: mocks.legacyCheck,
}));

vi.mock('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => mocks.registeredApis,
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({ reportUsage: false }),
  },
}));

import { useUpdateStore } from './useUpdateStore';
import type { MobileUpdateDecision } from '@/lib/mobile-updates/types';

const otaAvailableDecision = (): MobileUpdateDecision => ({
  status: 'ok',
  primaryAction: 'apply_ota',
  ota: {
    state: 'available',
    bundle: {
      bundleId: '34ab092a',
      releaseVersion: '1.18.3',
      url: 'https://example.com/bundle.zip',
      size: 100,
      checksum: 'deadbeef',
      minShellApiVersion: 1,
    },
  },
  native: { state: 'current' },
  nextCheckInSec: 1200,
});

describe('useUpdateStore mobile OTA branch', () => {
  beforeEach(() => {
    mocks.isCapacitor = true;
    mocks.registeredApis = { mobileUpdates: mocks.mobileUpdates };
    mocks.mobileUpdates.checkForOtaUpdate.mockReset();
    mocks.legacyCheck.mockReset();
    useUpdateStore.getState().reset();
  });

  test('OTA success sets otaDecision and available', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(otaAvailableDecision());

    const suggested = await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(suggested).toBe(1200);
    expect(state.available).toBe(true);
    expect(state.otaDecision?.primaryAction).toBe('apply_ota');
    expect(state.otaPhase).toBe('available');
    expect(state.info?.version).toBe('1.18.3');
    expect(mocks.legacyCheck).not.toHaveBeenCalled();
  });

  test('OTA throw falls back to legacy mobile client update check', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockRejectedValue(new Error('network'));
    mocks.legacyCheck.mockResolvedValue({
      available: true,
      version: '1.9.0',
      currentVersion: '1.2.3',
      downloadUrl: 'https://github.com/yee94/openchamber/releases',
      nextSuggestedCheckInSec: 600,
    });

    const suggested = await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(suggested).toBe(600);
    expect(mocks.legacyCheck).toHaveBeenCalledOnce();
    expect(state.available).toBe(true);
    expect(state.info?.version).toBe('1.9.0');
    expect(state.otaDecision).toBeNull();
    expect(state.otaPhase).toBe('idle');
  });
});
