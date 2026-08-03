import type { UpdateInfo } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';

export const MOBILE_EDGEONE_UPDATE_CHECK_URL = 'https://openchamber.xiaobe.top/v1/update/check';
export const MOBILE_VERCEL_UPDATE_CHECK_URL = 'https://openchamber-update.vercel.app/v1/update/check';
export const MOBILE_GITHUB_LATEST_RELEASE_URL = 'https://github.com/yee94/openchamber/releases/latest';
export const MOBILE_GITHUB_RELEASES_URL = 'https://github.com/yee94/openchamber/releases';
export const MOBILE_IOS_TESTFLIGHT_URL = 'https://testflight.apple.com/join/ZCENBHtm';
export const MOBILE_UPDATE_CHECK_TIMEOUT_MS = 10_000;

export type MobileClientUpdateCheckOptions = {
  currentVersion: string;
  platform: 'android' | 'ios' | 'web';
  deviceClass?: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  arch?: 'arm64' | 'x64' | 'unknown';
  reportUsage?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type UpdateServiceResponse = {
  latestVersion?: unknown;
  updateAvailable?: unknown;
  releaseNotes?: unknown;
  releaseNotesUrl?: unknown;
  downloadUrl?: unknown;
  download?: { url?: unknown };
  nextSuggestedCheckInSec?: unknown;
};

type HttpResponseLike = {
  ok: boolean;
  status: number;
  url?: string;
  json: () => Promise<unknown>;
};

function parseVersionForComparison(value: string): { parts: number[]; prerelease: boolean } {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0] ?? '';
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });

  return {
    parts,
    prerelease: prereleaseIndex >= 0,
  };
}

export function compareMobileClientVersions(left: string, right: string): number {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) {
    return a.prerelease ? -1 : 1;
  }

  return 0;
}

export function getMobileClientUpdateCheckUrls(): string[] {
  return [MOBILE_EDGEONE_UPDATE_CHECK_URL, MOBILE_VERCEL_UPDATE_CHECK_URL];
}

export function getMobileUpdateCheckTimeoutMs(deadline: number, remainingSources: number, now = Date.now): number | null {
  const remainingMs = deadline - now();
  if (remainingMs <= 0 || remainingSources <= 0) return null;
  return Math.max(1, Math.ceil(remainingMs / remainingSources));
}

function buildUpdateServicePayload(options: MobileClientUpdateCheckOptions) {
  return {
    appType: 'mobile-capacitor',
    deviceClass: options.deviceClass || 'mobile',
    platform: options.platform === 'ios' || options.platform === 'android' ? options.platform : 'android',
    arch: options.arch || 'unknown',
    channel: 'stable',
    currentVersion: options.currentVersion,
    instanceMode: 'remote',
    reportUsage: options.reportUsage !== false,
  };
}

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
          url: typeof response.url === 'string' ? response.url : url,
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
      url: response.url,
      json: () => response.json(),
    };
  } catch {
    return null;
  }
}

function getDefaultMobileDownloadUrl(
  platform: MobileClientUpdateCheckOptions['platform'],
  latestVersion: string,
): string {
  if (platform === 'ios') return MOBILE_IOS_TESTFLIGHT_URL;
  return `${MOBILE_GITHUB_RELEASES_URL}/download/v${latestVersion}/app-release.apk`;
}

function mapUpdateServiceResult(
  data: UpdateServiceResponse,
  currentVersion: string,
  platform: MobileClientUpdateCheckOptions['platform'],
): UpdateInfo | null {
  if (typeof data.latestVersion !== 'string' || data.latestVersion.trim().length === 0) {
    return null;
  }

  const latestVersion = data.latestVersion.trim();
  const versionComparison = compareMobileClientVersions(latestVersion, currentVersion);
  if (versionComparison < 0) return null;

  const releaseUrl = typeof data.releaseNotesUrl === 'string' && data.releaseNotesUrl.trim().length > 0
    ? data.releaseNotesUrl.trim()
    : `${MOBILE_GITHUB_RELEASES_URL}/tag/v${latestVersion}`;
  const downloadUrl = typeof data.downloadUrl === 'string' && data.downloadUrl.trim().length > 0
    ? data.downloadUrl.trim()
    : typeof data.download?.url === 'string' && data.download.url.trim().length > 0
      ? data.download.url.trim()
      : getDefaultMobileDownloadUrl(platform, latestVersion);

  return {
    available: Boolean(data.updateAvailable) && versionComparison > 0,
    version: latestVersion,
    currentVersion,
    body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
    releaseUrl,
    downloadUrl,
    nextSuggestedCheckInSec:
      typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
        ? data.nextSuggestedCheckInSec
        : undefined,
  };
}

async function checkFromUpdateService(
  updateCheckUrl: string,
  options: MobileClientUpdateCheckOptions,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<UpdateInfo | null> {
  const response = await requestWithTimeout(
    updateCheckUrl,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildUpdateServicePayload(options)),
    },
    timeoutMs,
    fetchImpl,
  );

  if (!response?.ok) return null;

  let data: UpdateServiceResponse;
  try {
    data = await response.json() as UpdateServiceResponse;
  } catch {
    return null;
  }

  return mapUpdateServiceResult(data, options.currentVersion, options.platform);
}

async function checkFromGitHub(
  currentVersion: string,
  platform: MobileClientUpdateCheckOptions['platform'],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<UpdateInfo | null> {
  const response = await requestWithTimeout(
    MOBILE_GITHUB_LATEST_RELEASE_URL,
    {
      method: 'GET',
      headers: { Accept: 'text/html' },
      redirect: 'follow',
    },
    timeoutMs,
    fetchImpl,
  );
  if (!response?.ok) return null;

  const finalUrl = typeof response.url === 'string' && response.url.length > 0
    ? response.url
    : MOBILE_GITHUB_LATEST_RELEASE_URL;
  let match: RegExpMatchArray | null = null;
  try {
    match = new URL(finalUrl).pathname.match(/\/releases\/tag\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  } catch {
    return null;
  }
  if (!match?.[1]) return null;

  const version = match[1];
  const versionComparison = compareMobileClientVersions(version, currentVersion);
  const releaseUrl = `${MOBILE_GITHUB_RELEASES_URL}/tag/v${version}`;
  return {
    available: versionComparison > 0,
    version,
    currentVersion,
    releaseUrl,
    downloadUrl: getDefaultMobileDownloadUrl(platform, version),
  };
}

export async function checkForMobileClientUpdates(
  options: MobileClientUpdateCheckOptions,
): Promise<UpdateInfo> {
  const currentVersion = options.currentVersion?.trim() || 'unknown';
  if (currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to check for mobile updates',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const updateCheckUrls = getMobileClientUpdateCheckUrls();
  const deadline = now() + MOBILE_UPDATE_CHECK_TIMEOUT_MS;

  for (const [index, updateCheckUrl] of updateCheckUrls.entries()) {
    const timeoutMs = getMobileUpdateCheckTimeoutMs(
      deadline,
      updateCheckUrls.length - index + 1,
      now,
    );
    if (timeoutMs === null) break;

    const update = await checkFromUpdateService(updateCheckUrl, options, timeoutMs, fetchImpl);
    if (update) return update;
  }

  const githubTimeoutMs = getMobileUpdateCheckTimeoutMs(deadline, 1, now);
  if (githubTimeoutMs !== null) {
    const githubUpdate = await checkFromGitHub(currentVersion, options.platform, githubTimeoutMs, fetchImpl);
    if (githubUpdate) return githubUpdate;
  }

  return {
    available: false,
    currentVersion,
    error: 'Unable to check for mobile updates',
  };
}
