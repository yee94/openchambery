import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { onRequest } from '../edge-functions/v1/update/check.js';

let restoreFetch = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function stubStaticAssets({ manifest, changelog = '', manifestStatus = 200, changelogStatus = 200 }) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    requests.push(url.pathname);

    if (url.pathname === '/update-manifest.json') {
      return new Response(JSON.stringify(manifest), {
        status: manifestStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/CHANGELOG.md') {
      return new Response(changelog, { status: changelogStatus });
    }
    throw new Error(`Unexpected static asset request: ${url.pathname}`);
  };
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  return requests;
}

function requestWithJson(payload) {
  return new Request('https://updates.example.com/v1/update/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const manifest = {
  latestVersion: '1.16.50',
  releaseNotesUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.50',
  nextSuggestedCheckInSec: 3600,
};

test('returns the existing update API contract with changelog notes for a newer release', async () => {
  const requests = stubStaticAssets({
    manifest,
    changelog: [
      '# Changelog',
      '',
      '## [1.16.50] - 2026-07-21',
      '',
      '- Latest change',
      '',
      '## [1.16.49] - 2026-07-21',
      '',
      '- Earlier change',
    ].join('\n'),
  });

  const response = await onRequest({
    request: requestWithJson({
      currentVersion: '1.16.48',
      installId: 'client-install-id',
      reportUsage: true,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    latestVersion: '1.16.50',
    currentVersion: '1.16.48',
    updateAvailable: true,
    releaseNotesUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.50',
    nextSuggestedCheckInSec: 3600,
    releaseNotes: '## [1.16.50] - 2026-07-21\n\n- Latest change\n\n## [1.16.49] - 2026-07-21\n\n- Earlier change',
  });
  assert.deepEqual(requests, ['/update-manifest.json', '/CHANGELOG.md']);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('returns an up-to-date result without fetching changelog content', async () => {
  const requests = stubStaticAssets({ manifest });
  const response = await onRequest({ request: requestWithJson({ currentVersion: '1.16.50' }) });
  const body = await response.json();

  assert.deepEqual(body, {
    latestVersion: '1.16.50',
    currentVersion: '1.16.50',
    updateAvailable: false,
    releaseNotesUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.16.50',
    nextSuggestedCheckInSec: 3600,
  });
  assert.deepEqual(requests, ['/update-manifest.json']);
});

test('treats a prerelease client as older than the corresponding stable release', async () => {
  stubStaticAssets({
    manifest,
    changelog: '## [1.16.50] - 2026-07-21\n\n- Stable release',
  });
  const response = await onRequest({ request: requestWithJson({ currentVersion: '1.16.50-beta.1' }) });
  const body = await response.json();

  assert.equal(body.updateAvailable, true);
  assert.equal(body.currentVersion, '1.16.50-beta.1');
});

test('returns platform download targets for Capacitor clients', async () => {
  stubStaticAssets({ manifest, changelog: '## [1.16.50] - 2026-07-21\n\n- Mobile release' });
  const androidResponse = await onRequest({ request: requestWithJson({
    currentVersion: '1.16.49', appType: 'mobile-capacitor', platform: 'android',
  }) });
  const android = await androidResponse.json();
  assert.equal(android.downloadUrl, 'https://github.com/yee94/openchamber/releases/download/v1.16.50/app-release.apk');

  restoreFetch?.();
  restoreFetch = null;
  stubStaticAssets({ manifest, changelog: '## [1.16.50] - 2026-07-21\n\n- Mobile release' });
  const iosResponse = await onRequest({ request: requestWithJson({
    currentVersion: '1.16.49', appType: 'mobile-capacitor', platform: 'ios',
  }) });
  const ios = await iosResponse.json();
  assert.equal(ios.downloadUrl, manifest.releaseNotesUrl);
});

test('returns a controlled error for malformed request JSON', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Static assets should remain untouched');
  };
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  const response = await onRequest({
    request: new Request('https://updates.example.com/v1/update/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body must contain JSON' });
});

test('returns a controlled error when the generated manifest is unavailable', async () => {
  stubStaticAssets({ manifest, manifestStatus: 503 });
  const response = await onRequest({ request: requestWithJson({ currentVersion: '1.16.49' }) });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Update manifest is unavailable' });
});

test('answers CORS preflight and method validation', async () => {
  const optionsResponse = await onRequest({
    request: new Request('https://updates.example.com/v1/update/check', { method: 'OPTIONS' }),
  });
  const getResponse = await onRequest({
    request: new Request('https://updates.example.com/v1/update/check', { method: 'GET' }),
  });

  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get('allow'), 'POST, OPTIONS');
});
