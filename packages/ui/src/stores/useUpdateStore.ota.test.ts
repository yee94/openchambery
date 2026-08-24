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

  test('same-version apply_ota is not an available update', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue({
      ...otaAvailableDecision(),
      ota: {
        state: 'available',
        bundle: {
          ...otaAvailableDecision().ota.bundle!,
          releaseVersion: '1.2.3',
        },
      },
    });

    await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(state.available).toBe(false);
    expect(state.info?.available).toBe(false);
    expect(state.otaPhase).toBe('idle');
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
    mocks.mobileUpdates.downloadOtaUpdate.mockResolvedValue({ skipped: true });
    mocks.mobileUpdates.queueOtaUpdateForNextLaunch.mockResolvedValue(undefined);

    await useUpdateStore.getState().checkForUpdates();
    await useUpdateStore.getState().downloadUpdate();

    const state = useUpdateStore.getState();
    expect(mocks.mobileUpdates.downloadOtaUpdate).toHaveBeenCalledWith(
      otaAvailableDecision().ota.bundle,
    );
    expect(mocks.mobileUpdates.queueOtaUpdateForNextLaunch).toHaveBeenCalledOnce();
    expect(mocks.mobileUpdates.applyOtaUpdateNow).not.toHaveBeenCalled();
    expect(state.downloaded).toBe(true);
    expect(state.downloading).toBe(false);
    expect(state.otaPhase).toBe('pending_restart');
    expect(state.otaDownloadSkipped).toBe(true);
  });

  test('maps OTA download percent to bundle bytes and deduplicates integer progress', async () => {
    const decision = otaAvailableDecision();
    decision.ota.bundle!.size = 1000;
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(decision);
    await useUpdateStore.getState().checkForUpdates();
    useUpdateStore.setState({ downloading: true });

    useUpdateStore.getState().setOtaDownloadPercent(25.4);
    const firstProgress = useUpdateStore.getState().progress;
    expect(firstProgress).toEqual({ downloaded: 254, total: 1000 });

    useUpdateStore.getState().setOtaDownloadPercent(25.49);
    expect(useUpdateStore.getState().progress).toBe(firstProgress);
  });

  test('uses percentage units when the OTA bundle size is unavailable', async () => {
    const decision = otaAvailableDecision();
    decision.ota.bundle!.size = 0;
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(decision);
    await useUpdateStore.getState().checkForUpdates();
    useUpdateStore.setState({ downloading: true });

    useUpdateStore.getState().setOtaDownloadPercent(40);

    expect(useUpdateStore.getState().progress).toEqual({ downloaded: 40, total: 100 });
  });

  test('ignores OTA download progress outside an active valid download', () => {
    useUpdateStore.getState().setOtaDownloadPercent(50);
    useUpdateStore.setState({ downloading: true });
    useUpdateStore.getState().setOtaDownloadPercent(Number.NaN);
    useUpdateStore.getState().setOtaDownloadPercent(-1);
    useUpdateStore.getState().setOtaDownloadPercent(101);

    expect(useUpdateStore.getState().progress).toBeNull();
  });

  test('marks a native OTA download event failure', () => {
    useUpdateStore.setState({ downloading: true, downloaded: true });

    useUpdateStore.getState().setOtaDownloadFailed();

    const state = useUpdateStore.getState();
    expect(state.downloading).toBe(false);
    expect(state.downloaded).toBe(false);
    expect(state.error).toBe('Failed to download update');
    expect(state.otaPhase).toBe('error');
  });

  test('keeps a queued mobile OTA update when the dialog is dismissed', async () => {
    const decision = otaAvailableDecision();
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue(decision);
    await useUpdateStore.getState().checkForUpdates();
    useUpdateStore.setState({
      downloaded: true,
      otaPhase: 'pending_restart',
      otaDownloadSkipped: true,
    });

    useUpdateStore.getState().dismiss();

    const state = useUpdateStore.getState();
    expect(state.available).toBe(true);
    expect(state.downloaded).toBe(true);
    expect(state.otaPhase).toBe('pending_restart');
    expect(state.otaDownloadSkipped).toBe(true);
    expect(state.otaDecision).toBe(decision);
    expect(state.info?.version).toBe('1.18.3');
  });

  test('clears a downloaded OTA bundle when a new bundle id is returned', async () => {
    mocks.mobileUpdates.checkForOtaUpdate
      .mockResolvedValueOnce(otaAvailableDecision())
      .mockResolvedValueOnce({
        ...otaAvailableDecision(),
        ota: {
          state: 'available',
          bundle: {
            ...otaAvailableDecision().ota.bundle!,
            bundleId: 'new-bundle-id',
            releaseVersion: '1.18.4',
          },
        },
      });
    await useUpdateStore.getState().checkForUpdates();
    useUpdateStore.setState({
      downloaded: true,
      otaPhase: 'pending_restart',
      otaDownloadSkipped: true,
      progress: { downloaded: 100, total: 100 },
    });

    await useUpdateStore.getState().checkForUpdates();

    const state = useUpdateStore.getState();
    expect(state.downloaded).toBe(false);
    expect(state.otaDownloadSkipped).toBe(false);
    expect(state.progress).toBeNull();
    expect(state.otaPhase).toBe('available');
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

  test('install_native_required uses only the protocol installUrl', async () => {
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
    const state = useUpdateStore.getState();

    expect(state.info?.downloadUrl).toBe('https://example.com/app.apk');
    expect(state.info?.manualUpdate).toBe(true);
    expect(state.info?.inAppApply).toBeUndefined();
    expect(mocks.legacyCheck).not.toHaveBeenCalled();
  });

  test('install_native_required without installUrl does not invent a GitHub URL', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockResolvedValue({
      status: 'ok',
      primaryAction: 'install_native_required',
      ota: { state: 'incompatible' },
      native: { state: 'required', version: '1.19.0' },
      nextCheckInSec: 1200,
    });

    await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(state.info?.downloadUrl).toBeUndefined();
    expect(mocks.legacyCheck).not.toHaveBeenCalled();
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

  test('OTA throw does not invent a GitHub update', async () => {
    mocks.mobileUpdates.checkForOtaUpdate.mockRejectedValue(new Error('network'));

    const suggested = await useUpdateStore.getState().checkForUpdates();
    const state = useUpdateStore.getState();

    expect(suggested).toBeNull();
    expect(mocks.legacyCheck).not.toHaveBeenCalled();
    expect(state.available).toBe(false);
    expect(state.error).toBe('network');
    expect(state.otaPhase).toBe('error');
  });
});
