import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseOtaManifest } from '../lib/ota-manifest.js';
import { fnv1a32, resolveMobileUpdate, rolloutBucket } from '../lib/ota-resolver.js';

const CHECKSUM = `sha256:${'a'.repeat(64)}`;

function activeBundle(overrides = {}) {
  return {
    bundleId: '34ab092a8e7f6d21',
    releaseVersion: '1.18.2-beta.23',
    url: '/ota/bundles/34ab092a8e7f6d21.zip',
    size: 8808038,
    checksum: CHECKSUM,
    rolloutPercent: 100,
    rolloutSalt: 'beta-42',
    minShellApiVersion: 1,
    platforms: {
      ios: { minNativeBuild: 350 },
      android: { minNativeBuild: 350 },
    },
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    channel: 'beta',
    generation: 42,
    activeBundle: activeBundle(),
    nativeTargets: {
      ios: {
        version: '1.18.2-beta.22',
        build: 350,
        status: 'published',
        installUrl: 'https://testflight.apple.com/join/xxx',
      },
      android: {
        version: '1.18.2-beta.22',
        build: 350,
        status: 'published',
        installUrl: 'https://github.com/yee94/openchamber/releases/tag/v1.18.2-beta.22',
      },
    },
    rollbackBundleIds: ['81e304792d416341', '201ae56fa03d7082'],
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  return {
    channel: 'beta',
    platform: 'ios',
    deviceId: 'device-abc',
    nativeVersion: '1.18.2-beta.22',
    nativeBuild: 350,
    shellApiVersion: 1,
    currentBundleId: 'builtin',
    ...overrides,
  };
}

test('parseOtaManifest accepts a full valid manifest and null activeBundle seed', () => {
  const full = parseOtaManifest(validManifest());
  assert.equal(full.ok, true);
  assert.equal(full.manifest.activeBundle.bundleId, '34ab092a8e7f6d21');
  assert.equal(full.manifest.rollbackBundleIds.length, 2);

  const seed = parseOtaManifest({
    schemaVersion: 1,
    channel: 'beta',
    generation: 0,
    activeBundle: null,
    nativeTargets: {},
    rollbackBundleIds: [],
  });
  assert.equal(seed.ok, true);
  assert.equal(seed.manifest.activeBundle, null);
});

test('parseOtaManifest collects validation errors for invalid fields', () => {
  const result = parseOtaManifest({
    schemaVersion: 2,
    channel: '',
    generation: -1,
    activeBundle: {
      bundleId: 'not-hex',
      releaseVersion: 'bad',
      url: '/wrong/path.zip',
      size: 0,
      checksum: 'md5:abc',
      rolloutPercent: 101,
      rolloutSalt: '',
      minShellApiVersion: 0,
      platforms: { ios: { minNativeBuild: 0 } },
    },
    nativeTargets: 'nope',
    rollbackBundleIds: ['x', 'y', 'z'],
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5);
  assert.ok(result.errors.some((error) => error.includes('schemaVersion')));
  assert.ok(result.errors.some((error) => error.includes('bundleId')));
  assert.ok(result.errors.some((error) => error.includes('rolloutPercent')));
});

test('null manifest or null activeBundle yields none/current (decision order 1)', () => {
  assert.deepEqual(resolveMobileUpdate(null, baseRequest()).primaryAction, 'none');
  assert.equal(resolveMobileUpdate(null, baseRequest()).ota.state, 'current');

  const seed = parseOtaManifest({
    schemaVersion: 1,
    channel: 'beta',
    generation: 0,
    activeBundle: null,
    nativeTargets: {},
    rollbackBundleIds: [],
  }).manifest;
  const decision = resolveMobileUpdate(seed, baseRequest());
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('shell too old via minNativeBuild requires native install (decision order 2)', () => {
  const manifest = parseOtaManifest(validManifest()).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({ nativeBuild: 349 }));
  assert.equal(decision.primaryAction, 'install_native_required');
  assert.equal(decision.ota.state, 'incompatible');
  assert.equal(decision.native.state, 'required');
  assert.equal(decision.native.build, 350);
  assert.equal(decision.native.installUrl, 'https://testflight.apple.com/join/xxx');
});

test('shell too old via shellApiVersion requires native install (decision order 2)', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ minShellApiVersion: 2 }),
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({ shellApiVersion: 1 }));
  assert.equal(decision.primaryAction, 'install_native_required');
  assert.equal(decision.ota.state, 'incompatible');
  assert.equal(decision.native.state, 'required');
});

test('rollout bucket is deterministic and gates at 0 and 100 percent (decision order 3)', () => {
  const salt = 'beta-42';
  const deviceId = 'device-abc';
  const bucket = rolloutBucket(deviceId, salt);
  assert.equal(rolloutBucket(deviceId, salt), bucket);
  assert.equal(fnv1a32(`${deviceId}:${salt}`) % 100, bucket);
  assert.ok(bucket >= 0 && bucket < 100);

  const outside = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ rolloutPercent: 0 }),
  })).manifest;
  const outsideDecision = resolveMobileUpdate(outside, baseRequest({ deviceId }));
  assert.equal(outsideDecision.primaryAction, 'none');
  assert.equal(outsideDecision.ota.state, 'outside_rollout');

  const full = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ rolloutPercent: 100 }),
  })).manifest;
  const fullDecision = resolveMobileUpdate(full, baseRequest({ deviceId, currentBundleId: 'builtin' }));
  assert.equal(fullDecision.primaryAction, 'apply_ota');
  assert.equal(fullDecision.ota.state, 'available');

  // Boundary: bucket >= percent → outside. Use percent === bucket to force outside.
  const boundary = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ rolloutPercent: bucket }),
  })).manifest;
  const boundaryDecision = resolveMobileUpdate(boundary, baseRequest({ deviceId }));
  assert.equal(boundaryDecision.ota.state, 'outside_rollout');

  // percent === bucket + 1 includes this device.
  const included = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ rolloutPercent: bucket + 1 }),
  })).manifest;
  const includedDecision = resolveMobileUpdate(included, baseRequest({ deviceId }));
  assert.equal(includedDecision.primaryAction, 'apply_ota');
});

test('different bundleId yields apply_ota with public bundle fields (decision order 4)', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ sessionKey: 'base64session' }),
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({ currentBundleId: 'builtin' }));
  assert.equal(decision.primaryAction, 'apply_ota');
  assert.equal(decision.ota.state, 'available');
  assert.equal(decision.ota.bundle.bundleId, '34ab092a8e7f6d21');
  assert.equal(decision.ota.bundle.url, '/ota/bundles/34ab092a8e7f6d21.zip');
  assert.equal(decision.ota.bundle.sessionKey, 'base64session');
  assert.equal(decision.ota.bundle.rolloutPercent, undefined);
  assert.equal(decision.ota.bundle.rolloutSalt, undefined);
});

test('matching bundleId is current; newer nativeTargets marks native available (decision order 5)', () => {
  const manifest = parseOtaManifest(validManifest({
    nativeTargets: {
      ios: {
        version: '1.18.3',
        build: 400,
        installUrl: 'https://testflight.apple.com/join/xxx',
      },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: '34ab092a8e7f6d21',
    nativeBuild: 350,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
  assert.equal(decision.native.state, 'available');
  assert.equal(decision.native.build, 400);
  assert.equal(decision.native.version, '1.18.3');
});

test('builtin on a newer native version must not apply an older OTA bundle', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.29' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.30', build: 360, installUrl: 'https://example.com/ios' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'builtin',
    nativeVersion: '1.18.2-beta.30',
    nativeBuild: 360,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('stripped iOS nativeVersion still blocks downgrade via nativeTargets.build', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.29' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.30', build: 360, installUrl: 'https://example.com/ios' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'builtin',
    nativeVersion: '1.18.2',
    nativeBuild: 360,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('applied newer bundle version name must not roll back to an older activeBundle', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.29' }),
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: '1.18.2-beta.30',
    nativeVersion: '1.18.2-beta.29',
    nativeBuild: 359,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('fresh iOS shell on the native target does not re-apply the same web bundle', () => {
  // iOS strips `-beta` from the marketing version, so a freshly installed shell
  // reports nativeVersion 1.18.2 (stripped) and currentBundleId 'builtin'. Its
  // nativeBuild already reached nativeTarget.build and the shell embeds the
  // active web bundle — the resolver must not re-offer apply_ota every check.
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.33' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.33', build: 370, installUrl: 'https://testflight.apple.com/join/xxx' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'builtin',
    nativeVersion: '1.18.2', // stripped iOS marketing version
    nativeBuild: 370,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('older activeBundle still applies OTA when the shell is older than the native target', () => {
  // Pure web OTA bumps activeBundle.releaseVersion without changing the shell.
  // The device nativeBuild stays below nativeTarget.build, so the shell does
  // not already embed the active web bundle → apply_ota.
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.33' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.30', build: 350, installUrl: 'https://testflight.apple.com/join/xxx' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'builtin',
    nativeVersion: '1.18.2', // stripped iOS marketing version
    nativeBuild: 350,
  }));
  assert.equal(decision.primaryAction, 'apply_ota');
  assert.equal(decision.ota.state, 'available');
  assert.equal(decision.ota.bundle.releaseVersion, '1.18.2-beta.33');
});

test('stale iOS nativeTarget still apply_ota when the running web is older (builtin)', () => {
  // Live beta.json after skipping TestFlight: nativeTargets.ios stays on an
  // older shell (1.18.2-beta.32) while activeBundle is 1.18.2-beta.36.
  // A builtin shell that has not reported its baked web version still needs OTA.
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.36' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.32', build: 362, installUrl: 'https://testflight.apple.com/join/xxx' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'builtin',
    nativeVersion: '1.18.2',
    nativeBuild: 362,
  }));
  assert.equal(decision.primaryAction, 'apply_ota');
  assert.equal(decision.ota.bundle.releaseVersion, '1.18.2-beta.36');
});

test('iOS Capgo builtin marketing version must not hide a newer beta OTA', () => {
  // Capgo builtin.version is CFBundleShortVersionString ("1.18.2"). The client
  // on a beta shell may send that as currentBundleId. Semver ranks 1.18.2 above
  // 1.18.2-beta.68, so treating it as a floor would return none forever.
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.68' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.61', build: 391, installUrl: 'https://testflight.apple.com/join/xxx' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: '1.18.2',
    nativeVersion: '1.18.2',
    nativeBuild: 392,
  }));
  assert.equal(decision.primaryAction, 'apply_ota');
  assert.equal(decision.ota.bundle.releaseVersion, '1.18.2-beta.68');
});

test('baked web releaseVersion as currentBundleId is current even with a stale iOS nativeTarget', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.36' }),
    nativeTargets: {
      ios: { version: '1.18.2-beta.32', build: 362, installUrl: 'https://testflight.apple.com/join/xxx' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: '1.18.2-beta.36',
    nativeVersion: '1.18.2',
    nativeBuild: 362,
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('same-version different bundleId is still apply_ota (content correction)', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ releaseVersion: '1.18.2-beta.23' }),
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: 'aaaaaaaaaaaaaaaa',
    nativeVersion: '1.18.2-beta.23',
    nativeBuild: 350,
  }));
  assert.equal(decision.primaryAction, 'apply_ota');
  assert.equal(decision.ota.state, 'available');
});

test('releaseVersion identity also counts as current (on-device bundle version name)', () => {
  const manifest = parseOtaManifest(validManifest()).manifest;
  // The Capgo plugin identifies applied bundles by their version string, so
  // clients report versionName rather than the manifest bundleId.
  const decision = resolveMobileUpdate(manifest, baseRequest({
    currentBundleId: '1.18.2-beta.23',
  }));
  assert.equal(decision.primaryAction, 'none');
  assert.equal(decision.ota.state, 'current');
});

test('checksum normalization: prefixed input stored as plain hex; encrypted keeps opaque value', () => {
  const plain = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ checksum: `sha256:${'d'.repeat(64)}` }),
  }));
  assert.equal(plain.ok, true);
  assert.equal(plain.manifest.activeBundle.checksum, 'd'.repeat(64));

  const encrypted = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ checksum: 'RW5jcnlwdGVkQ2hlY2tzdW0=', sessionKey: 'key' }),
  }));
  assert.equal(encrypted.ok, true);
  assert.equal(encrypted.manifest.activeBundle.checksum, 'RW5jcnlwdGVkQ2hlY2tzdW0=');

  const invalid = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ checksum: 'zzz' }),
  }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes('checksum')));
});

test('outside_rollout still reports native available when nativeTargets is newer', () => {
  const manifest = parseOtaManifest(validManifest({
    activeBundle: activeBundle({ rolloutPercent: 0 }),
    nativeTargets: {
      ios: { version: '1.19.0', build: 500, installUrl: 'https://example.com/ios' },
    },
  })).manifest;
  const decision = resolveMobileUpdate(manifest, baseRequest({ nativeBuild: 350 }));
  assert.equal(decision.ota.state, 'outside_rollout');
  assert.equal(decision.native.state, 'available');
  assert.equal(decision.native.build, 500);
});
