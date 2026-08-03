import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  MOBILE_EDGEONE_UPDATE_CHECK_URL,
  MOBILE_GITHUB_LATEST_RELEASE_URL,
  MOBILE_UPDATE_CHECK_TIMEOUT_MS,
  MOBILE_VERCEL_UPDATE_CHECK_URL,
  checkForMobileClientUpdates,
  compareMobileClientVersions,
  getMobileClientUpdateCheckUrls,
  getMobileUpdateCheckTimeoutMs,
} from './mobileClientUpdateCheck';

describe('mobile client update check helpers', () => {
  test('orders EdgeOne before Vercel', () => {
    expect(getMobileClientUpdateCheckUrls()).toEqual([
      MOBILE_EDGEONE_UPDATE_CHECK_URL,
      MOBILE_VERCEL_UPDATE_CHECK_URL,
    ]);
  });

  test('splits the remaining budget across remaining sources', () => {
    const now = () => 1_000;
    expect(getMobileUpdateCheckTimeoutMs(1_000 + MOBILE_UPDATE_CHECK_TIMEOUT_MS, 3, now)).toBe(
      Math.ceil(MOBILE_UPDATE_CHECK_TIMEOUT_MS / 3),
    );
    expect(getMobileUpdateCheckTimeoutMs(1_000, 1, now)).toBeNull();
  });

  test('compares stable and prerelease versions', () => {
    expect(compareMobileClientVersions('1.16.105', '1.16.104')).toBeGreaterThan(0);
    expect(compareMobileClientVersions('1.16.105-beta.1', '1.16.105')).toBeLessThan(0);
  });
});

describe('checkForMobileClientUpdates', () => {
  afterEach(() => {
    mock.restore();
  });

  test('uses the EdgeOne update service first', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      expect(url).toBe(MOBILE_EDGEONE_UPDATE_CHECK_URL);
      return new Response(JSON.stringify({
        latestVersion: '1.16.106',
        updateAvailable: true,
        downloadUrl: 'https://github.com/yee94/openchamber/releases/download/v1.16.106/app-release.apk',
        releaseNotesUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.106',
        nextSuggestedCheckInSec: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await checkForMobileClientUpdates({
      currentVersion: '1.16.105',
      platform: 'android',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.16.106');
    expect(result.downloadUrl).toContain('app-release.apk');
    expect(fetchCalls).toEqual([MOBILE_EDGEONE_UPDATE_CHECK_URL]);
  });

  test('falls through to GitHub Releases on iOS with the TestFlight install URL', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === MOBILE_EDGEONE_UPDATE_CHECK_URL || url === MOBILE_VERCEL_UPDATE_CHECK_URL) {
        throw new Error('unreachable');
      }
      if (url === MOBILE_GITHUB_LATEST_RELEASE_URL) {
        return {
          ok: true,
          status: 200,
          url: 'https://github.com/yee94/openchamber/releases/tag/v1.16.106',
          json: async () => ({}),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await checkForMobileClientUpdates({
      currentVersion: '1.16.105',
      platform: 'ios',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.available).toBe(true);
    expect(result.downloadUrl).toBe('https://testflight.apple.com/join/ZCENBHtm');
  });

  test('falls through EdgeOne and Vercel to GitHub Releases', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === MOBILE_EDGEONE_UPDATE_CHECK_URL || url === MOBILE_VERCEL_UPDATE_CHECK_URL) {
        throw new Error('unreachable');
      }
      if (url === MOBILE_GITHUB_LATEST_RELEASE_URL) {
        return {
          ok: true,
          status: 200,
          url: 'https://github.com/yee94/openchamber/releases/tag/v1.16.106',
          json: async () => ({}),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await checkForMobileClientUpdates({
      currentVersion: '1.16.105',
      platform: 'android',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.16.106');
    expect(result.downloadUrl).toBe(
      'https://github.com/yee94/openchamber/releases/download/v1.16.106/app-release.apk',
    );
    expect(fetchCalls).toEqual([
      MOBILE_EDGEONE_UPDATE_CHECK_URL,
      MOBILE_VERCEL_UPDATE_CHECK_URL,
      MOBILE_GITHUB_LATEST_RELEASE_URL,
    ]);
  });

  test('returns a mobile-specific error when every source fails', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('network down');
    });

    const result = await checkForMobileClientUpdates({
      currentVersion: '1.16.105',
      platform: 'android',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to check for mobile updates');
  });

  test('does not request remote sources when the client version is unknown', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error('should not fetch');
    });

    const result = await checkForMobileClientUpdates({
      currentVersion: 'unknown',
      platform: 'android',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to check for mobile updates');
    expect(fetchCalls).toEqual([]);
  });
});
