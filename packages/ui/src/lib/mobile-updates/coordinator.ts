import { Capacitor } from '@capacitor/core';

import { isCapacitorApp, getClientPlatform } from '@/lib/platform';
import { createUuid } from '@/lib/uuid';

import { getCapgoUpdater, type CapgoUpdater } from './capgoAdapter';
import type {
  MobileOtaBundleInfo,
  MobileUpdateChannel,
  MobileUpdateCheckRequest,
  MobileUpdateDecision,
  MobileUpdatePlatform,
} from './types';
import { MobileUpdatesUnsupportedError } from './types';

export const MOBILE_OTA_EDGEONE_CHECK_URL = 'https://openchamber.xiaobe.top/v1/mobile/update/check';
export const MOBILE_OTA_VERCEL_CHECK_URL = 'https://openchamber-update.vercel.app/v1/mobile/update/check';
const MOBILE_OTA_CHECK_TIMEOUT_MS = 10_000;

const DEVICE_ID_STORAGE_KEY = 'openchamber.mobile-ota.device-id.v1';

declare const __APP_VERSION__: string | undefined;

type OpenChamberOtaConfig = {
  shellApiVersion?: number;
  channel?: MobileUpdateChannel;
};

type CapacitorConfigWithOta = {
  OpenChamberOTA?: OpenChamberOtaConfig;
};

type HttpResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type CheckMobileOtaUpdateOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  updater?: CapgoUpdater | null;
};

const nonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

type CapacitorWithOptionalConfig = typeof Capacitor & {
  getConfig?: () => CapacitorConfigWithOta | undefined;
  config?: CapacitorConfigWithOta;
};

const readOtaConfig = (): OpenChamberOtaConfig => {
  try {
    const cap = Capacitor as CapacitorWithOptionalConfig;
    // packages/mobile injects OpenChamberOTA into capacitor.config; Capgo builds
    // expose it via getConfig() (newer) or the static `config` field.
    const config = (typeof cap.getConfig === 'function' ? cap.getConfig() : undefined)
      ?? cap.config;
    return config?.OpenChamberOTA ?? {};
  } catch {
    return {};
  }
};

const readChannel = (): MobileUpdateChannel => {
  const channel = readOtaConfig().channel;
  return channel === 'stable' ? 'stable' : 'beta';
};

const readShellApiVersion = (): number => {
  const raw = readOtaConfig().shellApiVersion;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
};

const resolvePlatform = (): MobileUpdatePlatform => {
  const client = getClientPlatform();
  if (client === 'ios' || client === 'android') return client;
  try {
    const platform = Capacitor.getPlatform();
    if (platform === 'ios' || platform === 'android') return platform;
  } catch {
    // Fall through.
  }
  return 'android';
};

const readPersistedDeviceId = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return nonEmptyString(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY));
  } catch {
    return null;
  }
};

const persistDeviceId = (deviceId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  } catch {
    // Local storage may be unavailable.
  }
};

const resolveDeviceId = async (updater: CapgoUpdater | null): Promise<string> => {
  if (updater) {
    try {
      const result = await updater.getDeviceId();
      const deviceId = nonEmptyString(result.deviceId);
      if (deviceId) {
        persistDeviceId(deviceId);
        return deviceId;
      }
    } catch {
      // Fall through to local stable id.
    }
  }

  const existing = readPersistedDeviceId();
  if (existing) return existing;

  const generated = createUuid();
  persistDeviceId(generated);
  return generated;
};

const resolveNativeInfo = async (): Promise<{ version: string; build: number }> => {
  const bundled = typeof __APP_VERSION__ !== 'undefined' ? nonEmptyString(__APP_VERSION__) : null;
  if (isCapacitorApp()) {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      const version = nonEmptyString(info.version) ?? bundled ?? '0.0.0';
      const buildRaw = nonEmptyString(info.build);
      const build = buildRaw ? Number.parseInt(buildRaw, 10) : 0;
      return {
        version,
        build: Number.isFinite(build) ? build : 0,
      };
    } catch {
      // Fall through.
    }
  }
  return {
    version: bundled ?? '0.0.0',
    build: 0,
  };
};

/**
 * Capgo reports `builtin` for the shell-embedded web bundle. The update
 * service treats `currentBundleId === activeBundle.releaseVersion` as already
 * current, so a builtin shell must report the baked `__APP_VERSION__` or it
 * will be offered the same zip forever (iOS 1.18.2-beta.36 → 1.18.2-beta.36).
 */
export const resolveReportedBundleId = (
  capgoBundleId: string | null | undefined,
  bundledReleaseVersion: string | null | undefined,
): string => {
  const id = nonEmptyString(capgoBundleId);
  if (id && id !== 'builtin') return id;
  return nonEmptyString(bundledReleaseVersion) ?? 'builtin';
};

const bundledReleaseVersion = (): string | null => (
  typeof __APP_VERSION__ !== 'undefined' ? nonEmptyString(__APP_VERSION__) : null
);

const resolveCurrentBundleId = async (updater: CapgoUpdater | null): Promise<string> => {
  const bundled = bundledReleaseVersion();
  if (!updater) return resolveReportedBundleId(null, bundled);
  try {
    const current = await updater.current();
    return resolveReportedBundleId(current.bundle?.id, bundled);
  } catch {
    return resolveReportedBundleId(null, bundled);
  }
};

const getUpdateCheckUrls = (): string[] => [MOBILE_OTA_EDGEONE_CHECK_URL, MOBILE_OTA_VERCEL_CHECK_URL];

const getTimeoutMs = (deadline: number, remainingSources: number, now: () => number): number | null => {
  const remainingMs = deadline - now();
  if (remainingMs <= 0 || remainingSources <= 0) return null;
  return Math.max(1, Math.ceil(remainingMs / remainingSources));
};

async function requestWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<HttpResponseLike | null> {
  try {
    if (isCapacitorApp()) {
      try {
        const { CapacitorHttp } = await import('@capacitor/core');
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        let data: unknown;
        if (typeof init.body === 'string') {
          try {
            data = JSON.parse(init.body) as unknown;
          } catch {
            data = init.body;
          }
        }

        const response = await Promise.race([
          CapacitorHttp.request({
            url,
            method: init.method || 'GET',
            headers,
            data,
            connectTimeout: timeoutMs,
            readTimeout: timeoutMs,
          }),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);

        if (!response) return null;
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => {
            if (typeof response.data === 'string') {
              try {
                return JSON.parse(response.data) as unknown;
              } catch {
                return response.data;
              }
            }
            return response.data;
          },
        };
      } catch {
        // Fall through to browser fetch.
      }
    }

    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
    };
  } catch {
    return null;
  }
}

const isMobileUpdateDecision = (value: unknown): value is MobileUpdateDecision => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.status !== 'ok') return false;
  if (record.primaryAction !== 'none' && record.primaryAction !== 'apply_ota' && record.primaryAction !== 'install_native_required') {
    return false;
  }
  if (!record.ota || typeof record.ota !== 'object') return false;
  if (!record.native || typeof record.native !== 'object') return false;
  if (typeof record.nextCheckInSec !== 'number' || !Number.isFinite(record.nextCheckInSec)) return false;
  return true;
};

async function postUpdateCheck(
  url: string,
  body: MobileUpdateCheckRequest,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<MobileUpdateDecision | null> {
  const response = await requestWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    fetchImpl,
  );

  if (!response?.ok) return null;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return null;
  }

  return isMobileUpdateDecision(data) ? data : null;
}

/**
 * Assemble device identity + shell metadata and ask the update service for an
 * OTA / native decision. Network failure throws — callers must not treat it as
 * "already current".
 */
export async function checkMobileOtaUpdate(
  options: CheckMobileOtaUpdateOptions = {},
): Promise<MobileUpdateDecision> {
  const updater = options.updater === undefined ? await getCapgoUpdater() : options.updater;
  if (!updater && !isCapacitorApp()) {
    throw new MobileUpdatesUnsupportedError();
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const [deviceId, nativeInfo, currentBundleId] = await Promise.all([
    resolveDeviceId(updater),
    resolveNativeInfo(),
    resolveCurrentBundleId(updater),
  ]);

  const body: MobileUpdateCheckRequest = {
    channel: readChannel(),
    platform: resolvePlatform(),
    deviceId,
    nativeVersion: nativeInfo.version,
    nativeBuild: nativeInfo.build,
    shellApiVersion: readShellApiVersion(),
    currentBundleId,
  };

  const urls = getUpdateCheckUrls();
  const deadline = now() + MOBILE_OTA_CHECK_TIMEOUT_MS;
  let lastError: Error | null = null;

  for (const [index, url] of urls.entries()) {
    const timeoutMs = getTimeoutMs(deadline, urls.length - index, now);
    if (timeoutMs === null) break;

    try {
      const decision = await postUpdateCheck(url, body, timeoutMs, fetchImpl);
      if (decision) return decision;
      lastError = new Error(`Mobile OTA check failed at ${url}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Mobile OTA check failed');
    }
  }

  throw lastError ?? new Error('Unable to check for mobile OTA updates');
}

export async function downloadOtaBundle(bundle: MobileOtaBundleInfo): Promise<string> {
  const updater = await getCapgoUpdater();
  if (!updater) throw new MobileUpdatesUnsupportedError();

  const result = await updater.download({
    url: bundle.url,
    version: bundle.releaseVersion,
    checksum: bundle.checksum,
    ...(bundle.sessionKey ? { sessionKey: bundle.sessionKey } : {}),
  });
  return result.id;
}

export async function applyDownloadedBundleNow(): Promise<void> {
  const updater = await getCapgoUpdater();
  if (!updater) throw new MobileUpdatesUnsupportedError();
  await updater.reload();
}

export async function queueDownloadedBundle(bundleId: string): Promise<void> {
  const updater = await getCapgoUpdater();
  if (!updater) throw new MobileUpdatesUnsupportedError();
  await updater.next({ id: bundleId });
}

/** Exported for tests — builds the request body without posting. */
export async function assembleMobileOtaCheckRequest(
  options: CheckMobileOtaUpdateOptions = {},
): Promise<MobileUpdateCheckRequest> {
  const updater = options.updater === undefined ? await getCapgoUpdater() : options.updater;
  const [deviceId, nativeInfo, currentBundleId] = await Promise.all([
    resolveDeviceId(updater),
    resolveNativeInfo(),
    resolveCurrentBundleId(updater),
  ]);
  return {
    channel: readChannel(),
    platform: resolvePlatform(),
    deviceId,
    nativeVersion: nativeInfo.version,
    nativeBuild: nativeInfo.build,
    shellApiVersion: readShellApiVersion(),
    currentBundleId,
  };
}
