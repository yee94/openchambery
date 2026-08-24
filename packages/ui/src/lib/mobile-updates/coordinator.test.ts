import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const updater = {
    notifyAppReady: vi.fn(async () => undefined),
    download: vi.fn(async () => ({ id: 'dl-1' })),
    next: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    current: vi.fn(async () => ({ bundle: { id: 'builtin', version: 'builtin' }, native: '1.2.3' })),
    getDeviceId: vi.fn(async () => ({ deviceId: 'device-abc' })),
    list: vi.fn(async () => ({ bundles: [] as Array<{
      id: string;
      version: string;
      downloaded: string;
      checksum: string;
      status: 'success' | 'error' | 'pending' | 'downloading' | 'deleted' | 'deleting';
    }> })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  };
  const capacitorState: {
    isNativePlatform: boolean;
    isPluginAvailable: boolean;
    platform: string;
    config: {
      OpenChamberOTA?: {
        channel: 'beta' | 'stable';
        shellApiVersion: number;
      };
    };
  } = {
    isNativePlatform: true,
    isPluginAvailable: true,
    platform: 'ios',
    config: {
      OpenChamberOTA: {
        channel: 'beta',
        shellApiVersion: 2,
      },
    },
  };
  return { updater, capacitorState };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.capacitorState.isNativePlatform,
    isPluginAvailable: (name: string) => name === 'CapacitorUpdater' && mocks.capacitorState.isPluginAvailable,
    getPlatform: () => mocks.capacitorState.platform,
    getConfig: () => mocks.capacitorState.config,
  },
  // Force the browser-fetch path so tests can inject fetchImpl.
  CapacitorHttp: {
    request: vi.fn(async () => {
      throw new Error('capacitor_http_unavailable');
    }),
  },
  registerPlugin: () => mocks.updater,
}));

vi.mock('@capacitor/app', () => ({
  App: {
    getInfo: vi.fn(async () => ({ version: '1.2.3', build: '45', id: 'app', name: 'OpenChamber' })),
  },
}));

vi.mock('@/lib/platform', () => ({
  isCapacitorApp: () => mocks.capacitorState.isNativePlatform,
  getClientPlatform: () => (mocks.capacitorState.platform === 'ios' ? 'ios' : 'android'),
}));

import {
  assembleMobileOtaCheckRequest,
  checkMobileOtaUpdate,
  findDownloadedOtaBundle,
  MOBILE_OTA_EDGEONE_CHECK_URL,
  MOBILE_OTA_VERCEL_CHECK_URL,
  resolveReportedBundleId,
} from './coordinator';
import { getCapgoUpdater, resetCapgoUpdaterCache } from './capgoAdapter';
import type { MobileOtaBundleInfo, MobileUpdateDecision } from './types';

const sampleDecision = (overrides: Partial<MobileUpdateDecision> = {}): MobileUpdateDecision => ({
  status: 'ok',
  primaryAction: 'none',
  ota: { state: 'current' },
  native: { state: 'current' },
  nextCheckInSec: 3600,
  ...overrides,
});

describe('mobile OTA coordinator', () => {
  beforeEach(() => {
    resetCapgoUpdaterCache();
    mocks.capacitorState.isNativePlatform = true;
    mocks.capacitorState.isPluginAvailable = true;
    mocks.capacitorState.platform = 'ios';
    mocks.capacitorState.config = {
      OpenChamberOTA: { channel: 'beta', shellApiVersion: 2 },
    };
    mocks.updater.current.mockResolvedValue({ bundle: { id: 'builtin', version: 'builtin' }, native: '1.2.3' });
    mocks.updater.getDeviceId.mockResolvedValue({ deviceId: 'device-abc' });
    mocks.updater.list.mockResolvedValue({ bundles: [] });
    vi.clearAllMocks();
  });

  test('assembles request body with channel, platform, shellApiVersion, and currentBundleId fallbacks', async () => {
    const body = await assembleMobileOtaCheckRequest({ updater: mocks.updater });
    expect(body).toMatchObject({
      channel: 'beta',
      platform: 'ios',
      deviceId: 'device-abc',
      nativeVersion: '1.2.3',
      nativeBuild: 45,
      shellApiVersion: 2,
      currentBundleId: 'builtin',
    });
  });

  test('defaults channel to beta and shellApiVersion to 1 when config is missing', async () => {
    mocks.capacitorState.config = {};
    const body = await assembleMobileOtaCheckRequest({ updater: mocks.updater });
    expect(body.channel).toBe('beta');
    expect(body.shellApiVersion).toBe(1);
  });

  test('builtin Capgo id reports the baked release version so same-version OTA is not re-offered', () => {
    expect(resolveReportedBundleId({ id: 'builtin', version: 'builtin' }, '1.18.2-beta.36')).toBe('1.18.2-beta.36');
    expect(resolveReportedBundleId(null, '1.18.2-beta.36')).toBe('1.18.2-beta.36');
    expect(resolveReportedBundleId({ id: 'builtin' }, '1.18.2-beta.36')).toBe('1.18.2-beta.36');
    expect(resolveReportedBundleId({ id: 'builtin', version: 'builtin' }, null)).toBe('builtin');
  });

  test('beta channel reports the web bundle version, never the stripped iOS marketing version', () => {
    expect(resolveReportedBundleId(
      { id: 'builtin', version: '1.18.2' },
      '1.18.2-beta.66',
      'beta',
    )).toBe('1.18.2-beta.66');
    expect(resolveReportedBundleId(
      { id: 'c02a8f76562d97ec', version: '1.18.2' },
      '1.18.2-beta.66',
      'beta',
    )).toBe('1.18.2-beta.66');
  });

  test('stable channel still reports a real installed bundle version', () => {
    expect(resolveReportedBundleId(
      { id: 'c02a8f76562d97ec', version: '1.18.2' },
      '1.18.2',
      'stable',
    )).toBe('1.18.2');
  });

  test('installed bundle reports its release version so changelog filtering anchors on it', () => {
    // The plugin's `version` is the releaseVersion the bundle was downloaded
    // with; the server parses it for "already current" and changelog ranges.
    expect(resolveReportedBundleId({ id: 'c02a8f76562d97ec', version: '1.18.2-beta.36' }, '1.18.1')).toBe('1.18.2-beta.36');
    // Legacy bundles without a usable version fall back to the hex id.
    expect(resolveReportedBundleId({ id: 'c02a8f76562d97ec' }, '1.18.2-beta.36')).toBe('c02a8f76562d97ec');
  });

  test('uses current Capgo bundle version when present', async () => {
    mocks.updater.current.mockResolvedValue({
      bundle: { id: '34ab092a', version: '1.18.3' },
      native: '1.2.3',
    });
    const body = await assembleMobileOtaCheckRequest({ updater: mocks.updater });
    expect(body.currentBundleId).toBe('1.18.3');
  });

  test('dual-URL failover: first fetch fails, second succeeds', async () => {
    const decision = sampleDecision({ primaryAction: 'apply_ota', ota: { state: 'available', bundle: {
      bundleId: 'b1',
      releaseVersion: '1.18.3',
      url: 'https://example.com/b1.zip',
      size: 10,
      checksum: 'abc',
      minShellApiVersion: 1,
    } } });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === MOBILE_OTA_EDGEONE_CHECK_URL) {
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      expect(url).toBe(MOBILE_OTA_VERCEL_CHECK_URL);
      return {
        ok: true,
        status: 200,
        json: async () => decision,
      } as Response;
    });

    const result = await checkMobileOtaUpdate({
      updater: mocks.updater,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.primaryAction).toBe('apply_ota');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('network failure propagates and is not swallowed as current', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'offline' }),
    } as Response));

    await expect(
      checkMobileOtaUpdate({
        updater: mocks.updater,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Unable to check for mobile OTA updates|Mobile OTA check failed/);
  });
});

describe('findDownloadedOtaBundle', () => {
  const targetBundle: MobileOtaBundleInfo = {
    bundleId: '34ab092a8e7f6d21',
    releaseVersion: '1.18.3',
    url: 'https://example.com/b.zip',
    size: 10,
    checksum: 'abc123checksum',
    minShellApiVersion: 1,
  };

  beforeEach(() => {
    resetCapgoUpdaterCache();
    mocks.capacitorState.isNativePlatform = true;
    mocks.capacitorState.isPluginAvailable = true;
    mocks.updater.list.mockResolvedValue({ bundles: [] });
    vi.clearAllMocks();
  });

  test('returns id for success or pending bundles that match checksum and version', async () => {
    mocks.updater.list.mockResolvedValue({
      bundles: [
        {
          id: 'local-success',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'success',
        },
      ],
    });
    await expect(findDownloadedOtaBundle(targetBundle)).resolves.toBe('local-success');

    mocks.updater.list.mockResolvedValue({
      bundles: [
        {
          id: 'local-pending',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'pending',
        },
      ],
    });
    await expect(findDownloadedOtaBundle(targetBundle)).resolves.toBe('local-pending');
  });

  test('ignores non-reusable statuses and checksum/version mismatches', async () => {
    mocks.updater.list.mockResolvedValue({
      bundles: [
        {
          id: 'err',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'error',
        },
        {
          id: 'del',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'deleted',
        },
        {
          id: 'deling',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'deleting',
        },
        {
          id: 'dl',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'downloading',
        },
        {
          id: 'wrong-sum',
          version: '1.18.3',
          downloaded: '2026-01-01',
          checksum: 'other',
          status: 'success',
        },
        {
          id: 'wrong-ver',
          version: '9.9.9',
          downloaded: '2026-01-01',
          checksum: 'abc123checksum',
          status: 'success',
        },
      ],
    });
    await expect(findDownloadedOtaBundle(targetBundle)).resolves.toBeNull();
  });

  test('returns null when updater is unavailable', async () => {
    mocks.capacitorState.isPluginAvailable = false;
    resetCapgoUpdaterCache();
    await expect(getCapgoUpdater()).resolves.toBeNull();
    await expect(findDownloadedOtaBundle(targetBundle)).resolves.toBeNull();
    expect(mocks.updater.list).not.toHaveBeenCalled();
  });

  test('returns null when list throws (caller may still download)', async () => {
    mocks.updater.list.mockRejectedValue(new Error('list failed'));
    await expect(findDownloadedOtaBundle(targetBundle)).resolves.toBeNull();
  });
});
