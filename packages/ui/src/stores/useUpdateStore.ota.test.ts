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
    mocks.mobileUpdates.downloadOtaUpdate.mockReset();
    mocks.mobileUpdates.queueOtaUpdateForNextLaunch.mockReset();
    mocks.mobileUpdates.applyOtaUpdateNow.mockReset();
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
    expect(state.info?.inAppApply).toBe(true);
    expect(mocks.legacyCheck).not.toHaveBeenCalled();
  });

  test('apply_ota maps releaseNotes onto UpdateInfo.body', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue({
      ...otaAvailableDecision(),
      releaseNotes: '## [1.18.3] - 2026-08-20\n\n- OTA changelog',
    });

    await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(state.info?.body).toBe('## [1.18.3] - 2026-08-20\n\n- OTA changelog');
  });

  test('apply_ota download queues the bundle for in-app restart', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(otaAvailableDecision());
    mocks.mobileUpdates.downloadOtaUpdate.mockResolvedValue(undefined);
    mocks.mobileUpdates.queueOtaUpdateForNextLaunch.mockResolvedValue(undefined);

    await useUpdateStore.getState().checkForUpdates();
    await useUpdateStore.getState().downloadUpdate();

    const state = useUpdateStore.getState();
    expect(mocks.mobileUpdates.downloadOtaUpdate).toHaveBeenCalledWith(
      otaAvailableDecision().ota.bundle,
    );
    expect(mocks.mobileUpdates.queueOtaUpdateForNextLaunch).toHaveBeenCalledOnce();
    expect(mocks.mobileUpdates.applyOtaUpdateNow).toHaveBeenCalledOnce();
    expect(state.downloaded).toBe(true);
    expect(state.downloading).toBe(false);
    expect(state.otaPhase).toBe('pending_restart');
  });

  test('apply_ota restart applies the queued bundle now', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(otaAvailableDecision());
    mocks.mobileUpdates.applyOtaUpdateNow.mockResolvedValue(undefined);

    await useUpdateStore.getState().checkForUpdates();
    useUpdateStore.setState({ downloaded: true });
    await useUpdateStore.getState().restartToUpdate();

    expect(mocks.mobileUpdates.applyOtaUpdateNow).toHaveBeenCalledOnce();
  });

  test('apply_ota download failure stays available and does not mark downloaded', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(otaAvailableDecision());
    mocks.mobileUpdates.downloadOtaUpdate.mockRejectedValue(new Error('disk full'));

    await useUpdateStore.getState().checkForUpdates();
    await useUpdateStore.getState().downloadUpdate();

    const state = useUpdateStore.getState();
    expect(state.downloaded).toBe(false);
    expect(state.downloading).toBe(false);
    expect(state.available).toBe(true);
    expect(state.otaPhase).toBe('error');
    expect(state.error).toBe('disk full');
    expect(mocks.mobileUpdates.queueOtaUpdateForNextLaunch).not.toHaveBeenCalled();
  });

  test('install_native_required does not use the in-app OTA download path', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue({
      status: 'ok',
      primaryAction: 'install_native_required',
      ota: { state: 'incompatible' },
      native: {
        state: 'required',
        version: '1.19.0',
        installUrl: 'https://example.com/app.apk',
      },
      nextCheckInSec: 1200,
    });

    await useUpdateStore.getState().checkForUpdates();
    await useUpdateStore.getState().downloadUpdate();

    const state = useUpdateStore.getState();
    expect(state.info?.inAppApply).toBeUndefined();
    expect(state.info?.manualUpdate).toBe(true);
    expect(state.downloaded).toBe(false);
    expect(mocks.mobileUpdates.downloadOtaUpdate).not.toHaveBeenCalled();
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
