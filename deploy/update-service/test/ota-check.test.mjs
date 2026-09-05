import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { handleCapgoOtaCheck, handleMobileUpdateCheck } from '../lib/ota-check.js';

let restoreFetch = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

const CHECKSUM = 'b'.repeat(64);

function channelManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: 'beta',
    generation: 1,
    activeBundle: {
      bundleId: '34ab092a8e7f6d21',
      releaseVersion: '1.18.2-beta.23',
      url: '/ota/bundles/34ab092a8e7f6d21.zip',
      size: 100,
      checksum: CHECKSUM,
      rolloutPercent: 100,
      rolloutSalt: 'beta-1',
      minShellApiVersion: 1,
      platforms: {
        ios: { minNativeBuild: 350 },
        android: { minNativeBuild: 350 },
      },
    },
    nativeTargets: {
      ios: {
        version: '1.18.2-beta.22',
        build: 350,
        status: 'published',
        installUrl: 'https://testflight.apple.com/join/xxx',
      },
    },
    rollbackBundleIds: [],
    ...overrides,
  };
}

function stubChannel({
  manifest,
  status = 200,
  channel = 'beta',
  changelog = '',
  changelogStatus = 200,
}) {
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
    requests.push(url.href);

    if (url.pathname === `/ota/channels/${channel}.json`) {
      return new Response(JSON.stringify(manifest), {
        status,
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

function mobileRequest(payload, path = '/v1/mobile/update/check') {
  return new Request(`https://updates.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const validBody = {
  channel: 'beta',
  platform: 'ios',
  deviceId: 'device-1',
  nativeVersion: '1.18.2-beta.22',
  nativeBuild: 350,
  shellApiVersion: 1,
  currentBundleId: 'builtin',
};

test('mobile update check returns apply_ota with absolute bundle URL', async () => {
  stubChannel({ manifest: channelManifest() });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(body.ota.state, 'available');
  assert.equal(body.ota.bundle.url, 'https://updates.example.com/ota/bundles/34ab092a8e7f6d21.zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('iOS stripped nativeVersion still attaches beta changelog using currentBundleId', async () => {
  stubChannel({
    manifest: channelManifest({
      activeBundle: {
        ...channelManifest().activeBundle,
        releaseVersion: '1.18.2-beta.37',
      },
    }),
    changelog: [
      '# Changelog',
      '',
      '## [1.18.2-beta.37] - 2026-08-23',
      '',
      '- Stop same-version OTA loop',
      '',
      '## [1.18.2-beta.36] - 2026-08-23',
      '',
      '- Already installed',
    ].join('\n'),
  });
  const response = await handleMobileUpdateCheck(mobileRequest({
    ...validBody,
    nativeVersion: '1.18.2',
    currentBundleId: '1.18.2-beta.36',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(
    body.releaseNotes,
    '## [1.18.2-beta.37] - 2026-08-23\n\n- Stop same-version OTA loop',
  );
});

test('mobile update check attaches releaseNotes for apply_ota from CHANGELOG.md', async () => {
  const requests = stubChannel({
    manifest: channelManifest(),
    changelog: [
      '# Changelog',
      '',
      '## [1.18.2-beta.23] - 2026-08-20',
      '',
      '- OTA bundle fix',
      '',
      '## [1.18.2-beta.22] - 2026-08-19',
      '',
      '- Native baseline',
      '',
      '## [1.18.1] - 2026-08-01',
      '',
      '- Older change',
    ].join('\n'),
  });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(
    body.releaseNotes,
    '## [1.18.2-beta.23] - 2026-08-20\n\n- OTA bundle fix',
  );
  assert.ok(requests.some((href) => new URL(href).pathname === '/CHANGELOG.md'));
});

test('mobile update check omits releaseNotes when CHANGELOG is unavailable', async () => {
  stubChannel({
    manifest: channelManifest(),
    changelogStatus: 404,
  });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(body.releaseNotes, undefined);
});

test('mobile update check returns 400 on bad body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Should not fetch');
  };
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  const missing = await handleMobileUpdateCheck(mobileRequest({ channel: 'beta' }));
  assert.equal(missing.status, 400);

  const badJson = await handleMobileUpdateCheck(new Request('https://updates.example.com/v1/mobile/update/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }));
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { error: 'Request body must contain JSON' });
});

test('mobile update check returns 503 when channel manifest fetch fails', async () => {
  stubChannel({ manifest: channelManifest(), status: 503 });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'ota_manifest_unavailable' });
});

test('capgo endpoint returns apply_ota shape', async () => {
  stubChannel({ manifest: channelManifest() });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    app_id: 'app.openchamber',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, '1.18.2-beta.23');
  assert.equal(body.url, 'https://updates.example.com/ota/bundles/34ab092a8e7f6d21.zip');
  assert.equal(body.checksum, CHECKSUM);
});

test('capgo endpoint: prefixed checksum normalizes to plain hex, version_name identity counts as current', async () => {
  stubChannel({
    manifest: channelManifest({
      activeBundle: {
        ...channelManifest().activeBundle,
        checksum: `sha256:${'c'.repeat(64)}`,
      },
    }),
  });
  // version_name equals the active releaseVersion → device is already current.
  const current = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: '1.18.2-beta.23',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const currentBody = await current.json();
  assert.equal(current.status, 200);
  assert.deepEqual(currentBody, { message: 'No new version available', version: '', url: '' });

  // builtin → update offered with the checksum normalized to plain hex.
  const update = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const updateBody = await update.json();
  assert.equal(updateBody.checksum, 'c'.repeat(64));
});

test('capgo endpoint: encrypted bundle emits both session_key and sessionKey with opaque checksum', async () => {
  const opaqueChecksum = 'RW5jcnlwdGVkQ2hlY2tzdW1WYWx1ZQ==';
  stubChannel({
    manifest: channelManifest({
      activeBundle: {
        ...channelManifest().activeBundle,
        checksum: opaqueChecksum,
        sessionKey: 'base64-session-key',
      },
    }),
  });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, '1.18.2-beta.23');
  assert.equal(body.checksum, opaqueChecksum);
  // Android parses `sessionKey`, iOS parses `session_key` — both must be present.
  assert.equal(body.session_key, 'base64-session-key');
  assert.equal(body.sessionKey, 'base64-session-key');
});

test('capgo endpoint returns major:true when native update is required', async () => {
  stubChannel({
    manifest: channelManifest({
      activeBundle: {
        ...channelManifest().activeBundle,
        minShellReleaseVersion: '1.18.2-beta.22',
      },
    }),
  });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.0.0',
    version_code: 100,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    major: true,
    breaking: true,
    message: 'native update required',
  });
});

test('capgo endpoint returns no-update shape for none / outside_rollout', async () => {
  stubChannel({
    manifest: channelManifest({
      activeBundle: {
        ...channelManifest().activeBundle,
        rolloutPercent: 0,
      },
    }),
  });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    message: 'No new version available',
    version: '',
    url: '',
  });
});

test('capgo endpoint returns 503 on manifest fetch failure and does not masquerade as no-update', async () => {
  stubChannel({ manifest: channelManifest(), status: 500 });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
  }, '/v1/ota/check'));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'ota_manifest_unavailable' });
});

test('activeBundle null seed yields none/current without 503', async () => {
  stubChannel({
    manifest: {
      schemaVersion: 1,
      channel: 'beta',
      generation: 0,
      activeBundle: null,
      nativeTargets: {},
      rollbackBundleIds: [],
    },
  });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'none');
  assert.equal(body.ota.state, 'current');
});

test('manifestBaseUrl override loads manifests from the Vercel origin while bundle URLs stay request-relative', async () => {
  const requests = stubChannel({ manifest: channelManifest() });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody), {
    manifestBaseUrl: 'https://openchamber-update.vercel.app',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  // Manifest fetched from the override origin...
  assert.ok(requests[0].includes('openchamber-update.vercel.app'));
  // ...but bundle URLs resolve against the client-facing request origin.
  assert.equal(body.ota.bundle.url, 'https://updates.example.com/ota/bundles/34ab092a8e7f6d21.zip');
});

test('manifestBaseUrl override loads CHANGELOG from the same origin as manifests', async () => {
  const requests = stubChannel({
    manifest: channelManifest(),
    changelog: [
      '# Changelog',
      '',
      '## [1.18.2-beta.23] - 2026-08-20',
      '',
      '- OTA bundle fix',
    ].join('\n'),
  });
  const response = await handleMobileUpdateCheck(mobileRequest(validBody), {
    manifestBaseUrl: 'https://openchamber-update.vercel.app',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(
    body.releaseNotes,
    '## [1.18.2-beta.23] - 2026-08-20\n\n- OTA bundle fix',
  );
  assert.ok(requests.includes('https://openchamber-update.vercel.app/CHANGELOG.md'));
  assert.equal(
    requests.some((href) => href.includes('updates.example.com/CHANGELOG.md')),
    false,
  );
});

test('answers CORS preflight for mobile update check', async () => {
  const optionsResponse = await handleMobileUpdateCheck(
    new Request('https://updates.example.com/v1/mobile/update/check', { method: 'OPTIONS' }),
  );
  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('mobile update check: beta→stable channel rollback sets isChannelRollback', async () => {
  stubChannel({
    channel: 'stable',
    manifest: channelManifest({
      channel: 'stable',
      activeBundle: {
        ...channelManifest().activeBundle,
        releaseVersion: '1.18.3',
        rolloutSalt: 'stable-1',
      },
    }),
  });
  const response = await handleMobileUpdateCheck(mobileRequest({
    channel: 'stable',
    platform: 'ios',
    deviceId: 'device-1',
    nativeVersion: '1.18.4-beta.7',
    nativeBuild: 400,
    shellApiVersion: 1,
    currentBundleId: '1.18.4-beta.7',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(body.ota.bundle.releaseVersion, '1.18.3');
  assert.equal(body.isChannelRollback, true);
});

test('mobile update check: stable upgrade omits isChannelRollback', async () => {
  stubChannel({
    channel: 'stable',
    manifest: channelManifest({
      channel: 'stable',
      activeBundle: {
        ...channelManifest().activeBundle,
        releaseVersion: '1.18.4',
        rolloutSalt: 'stable-1',
      },
    }),
  });
  const response = await handleMobileUpdateCheck(mobileRequest({
    channel: 'stable',
    platform: 'ios',
    deviceId: 'device-1',
    nativeVersion: '1.18.3',
    nativeBuild: 350,
    shellApiVersion: 1,
    currentBundleId: '1.18.3',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.primaryAction, 'apply_ota');
  assert.equal(body.isChannelRollback, undefined);
});

test('capgo endpoint maps is_channel_rollback for stable channel rollback', async () => {
  stubChannel({
    channel: 'stable',
    manifest: channelManifest({
      channel: 'stable',
      activeBundle: {
        ...channelManifest().activeBundle,
        releaseVersion: '1.18.3',
        rolloutSalt: 'stable-1',
      },
    }),
  });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.4-beta.7',
    version_code: 400,
    version_name: '1.18.4-beta.7',
    defaultChannel: 'stable',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, '1.18.3');
  assert.equal(body.url, 'https://updates.example.com/ota/bundles/34ab092a8e7f6d21.zip');
  assert.equal(body.checksum, CHECKSUM);
  assert.equal(body.is_channel_rollback, true);
});

test('capgo endpoint omits is_channel_rollback on normal apply_ota', async () => {
  stubChannel({ manifest: channelManifest() });
  const response = await handleCapgoOtaCheck(mobileRequest({
    platform: 'ios',
    device_id: 'device-1',
    version_build: '1.18.2-beta.22',
    version_code: 350,
    version_name: 'builtin',
    defaultChannel: 'beta',
    shellApiVersion: 1,
  }, '/v1/ota/check'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, '1.18.2-beta.23');
  assert.equal(body.is_channel_rollback, undefined);
});
