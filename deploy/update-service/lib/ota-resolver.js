const DEFAULT_NEXT_CHECK_IN_SEC = 3600;

/**
 * FNV-1a 32-bit hash (synchronous, pure JS).
 * Used for deterministic rollout bucketing.
 */
export function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function rolloutBucket(deviceId, rolloutSalt) {
  return fnv1a32(`${deviceId}:${rolloutSalt}`) % 100;
}

function publicBundle(activeBundle) {
  const bundle = {
    bundleId: activeBundle.bundleId,
    releaseVersion: activeBundle.releaseVersion,
    url: activeBundle.url,
    size: activeBundle.size,
    checksum: activeBundle.checksum,
    minShellApiVersion: activeBundle.minShellApiVersion,
    platforms: {
      ios: { ...activeBundle.platforms.ios },
      android: { ...activeBundle.platforms.android },
    },
  };
  if (activeBundle.sessionKey !== undefined) {
    bundle.sessionKey = activeBundle.sessionKey;
  }
  return bundle;
}

function nativeInfo(nativeTarget) {
  if (!nativeTarget) return { state: 'current' };
  const info = {
    state: 'current',
    version: nativeTarget.version,
    build: nativeTarget.build,
  };
  if (nativeTarget.installUrl !== undefined) {
    info.installUrl = nativeTarget.installUrl;
  }
  return info;
}

function nativeAvailableIfNewer(nativeTarget, nativeBuild) {
  if (!nativeTarget || !(nativeTarget.build > nativeBuild)) {
    return { state: 'current' };
  }
  const info = {
    state: 'available',
    version: nativeTarget.version,
    build: nativeTarget.build,
  };
  if (nativeTarget.installUrl !== undefined) {
    info.installUrl = nativeTarget.installUrl;
  }
  return info;
}

/**
 * Authoritative mobile OTA / native update decision.
 * `manifest` may be null when the channel file is missing (channel not using OTA yet).
 */
export function resolveMobileUpdate(manifest, request) {
  const nextCheckInSec = DEFAULT_NEXT_CHECK_IN_SEC;
  const platform = request.platform;
  const nativeTarget = manifest?.nativeTargets?.[platform];

  // 1. No manifest, or OTA enabled but no active bundle published yet.
  if (!manifest || manifest.activeBundle === null) {
    return {
      status: 'ok',
      primaryAction: 'none',
      ota: { state: 'current' },
      native: nativeAvailableIfNewer(nativeTarget, request.nativeBuild),
      nextCheckInSec,
    };
  }

  const activeBundle = manifest.activeBundle;
  const minNativeBuild = activeBundle.platforms[platform].minNativeBuild;

  // 2. Shell / native too old for this bundle.
  if (request.nativeBuild < minNativeBuild
    || request.shellApiVersion < activeBundle.minShellApiVersion) {
    const native = nativeInfo(nativeTarget);
    native.state = 'required';
    return {
      status: 'ok',
      primaryAction: 'install_native_required',
      ota: { state: 'incompatible' },
      native,
      nextCheckInSec,
    };
  }

  // 3. Rollout bucket gate.
  const bucket = rolloutBucket(request.deviceId, activeBundle.rolloutSalt);
  if (bucket >= activeBundle.rolloutPercent) {
    return {
      status: 'ok',
      primaryAction: 'none',
      ota: { state: 'outside_rollout' },
      native: nativeAvailableIfNewer(nativeTarget, request.nativeBuild),
      nextCheckInSec,
    };
  }

  // 4. Different active bundle → apply OTA.
  // The on-device client reports its current bundle either as the manifest
  // bundleId (content hash) or as the bundle version name (the Capgo plugin
  // identifies bundles by the `version` string it was downloaded with), so
  // both identities count as "current".
  const onCurrentBundle = request.currentBundleId === activeBundle.bundleId
    || request.currentBundleId === activeBundle.releaseVersion;
  if (!onCurrentBundle) {
    return {
      status: 'ok',
      primaryAction: 'apply_ota',
      ota: {
        state: 'available',
        bundle: publicBundle(activeBundle),
      },
      native: nativeAvailableIfNewer(nativeTarget, request.nativeBuild),
      nextCheckInSec,
    };
  }

  // 5. Already on active bundle.
  return {
    status: 'ok',
    primaryAction: 'none',
    ota: { state: 'current' },
    native: nativeAvailableIfNewer(nativeTarget, request.nativeBuild),
    nextCheckInSec,
  };
}
