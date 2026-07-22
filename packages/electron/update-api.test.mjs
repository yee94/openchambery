import assert from 'node:assert/strict';
import test from 'node:test';

import { checkMacOSReleaseUpdate, DEFAULT_UPDATE_CHECK_URL } from './update-api.mjs';

test('posts macOS desktop metadata to the EdgeOne update API', async () => {
  let request;
  const result = await checkMacOSReleaseUpdate({
    currentVersion: '1.16.49',
    arch: 'arm64',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        latestVersion: '1.16.50',
        updateAvailable: true,
        releaseNotes: 'Release notes',
        releaseNotesUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.50',
        publishedAt: '2026-07-22T00:00:00Z',
      }), { status: 200 });
    },
  });

  assert.equal(request.url, DEFAULT_UPDATE_CHECK_URL);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    appType: 'desktop-electron', deviceClass: 'desktop', platform: 'macos', arch: 'arm64',
    channel: 'stable', currentVersion: '1.16.49', instanceMode: 'desktop', reportUsage: true,
  });
  assert.deepEqual(result, {
    available: true, currentVersion: '1.16.49', version: '1.16.50', body: 'Release notes',
    date: '2026-07-22T00:00:00Z', releaseUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.50', manualUpdate: true,
  });
});

test('uses the update API override and preserves manual macOS updates', async () => {
  const result = await checkMacOSReleaseUpdate({
    currentVersion: '1.16.50',
    environment: { OPENCHAMBER_UPDATE_API_URL: 'https://updates.example.com/check' },
    fetchImpl: async (url) => {
      assert.equal(url, 'https://updates.example.com/check');
      return new Response(JSON.stringify({ latestVersion: '1.16.50', updateAvailable: false, releaseUrl: 'https://example.com/release', date: '2026-07-22' }));
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.releaseUrl, 'https://example.com/release');
  assert.equal(result.date, '2026-07-22');
  assert.equal(result.manualUpdate, true);
});
