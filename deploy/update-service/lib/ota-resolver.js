import { compareReleaseVersions, isStrippedMarketingIdentity, parseReleaseVersion } from './semver.js';

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

/**
 * 门身份：第一个可被 parseReleaseVersion 解析的 [request.currentBundleId, request.nativeVersion]。
 * currentBundleId 通常是运行中 web 包版本（含 -beta.N）；旧壳/builtin 场景回退 nativeVersion
 * （iOS 剥离版 "1.18.2" 也可解析，参与门比较是安全且正确的方向——stable 门不拦同 core beta 剥离身份）。
 */
function resolveShellGateIdentity(request) {
  if (parseReleaseVersion(request.currentBundleId)) {
    return request.currentBundleId;
  }
  if (parseReleaseVersion(request.nativeVersion)) {
    return request.nativeVersion;
  }
  return null;
}

/**
 * Highest release version the device is already known to be on.
 * Used so a fresh native install (`currentBundleId: builtin`) cannot be
 * rolled back to an older activeBundle.
 */
export function resolveCurrentFloorVersion(request, nativeTarget) {
  const candidates = [];
  if (
    parseReleaseVersion(request.currentBundleId)
    && !isStrippedMarketingIdentity(request.currentBundleId, request.nativeVersion)
  ) {
    candidates.push(request.currentBundleId);
  }
  const native = parseReleaseVersion(request.nativeVersion);
  // iOS marketing versions may strip `-beta.N`. Only trust nativeVersion when
  // it still carries a prerelease (Android versionName, or an unstripped iOS).
  if (native && native.beta !== null) {
    candidates.push(request.nativeVersion);
  }
  const gateIdentity = resolveShellGateIdentity(request);
  if (
    nativeTarget
    && gateIdentity
    && parseReleaseVersion(nativeTarget.version)
    && compareReleaseVersions(gateIdentity, nativeTarget.version) >= 0
  ) {
    candidates.push(nativeTarget.version);
  }

  let floor = null;
  for (const candidate of candidates) {
    if (floor === null) {
      floor = candidate;
      continue;
    }
    const comparison = compareReleaseVersions(candidate, floor);
    if (comparison !== null && comparison > 0) floor = candidate;
  }
  return floor;
}

function isOtaDowngrade(activeVersion, floorVersion) {
  const comparison = compareReleaseVersions(activeVersion, floorVersion);
  return comparison !== null && comparison < 0;
}

/**
 * Cross-channel rollback: device on a prerelease web bundle switches to the
 * stable channel, where activeBundle is a lower stable release. The normal
 * "OTA never downgrades" floor would return none forever; allow apply_ota and
 * mark the decision so clients can treat it as an intentional channel switch.
 */
function isStableChannelRollback(request, activeReleaseVersion) {
  if (request.channel !== 'stable') return false;
  const current = parseReleaseVersion(request.currentBundleId);
  if (!current || current.beta === null) return false;
  const comparison = compareReleaseVersions(request.currentBundleId, activeReleaseVersion);
  return comparison !== null && comparison > 0;
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
  const gateIdentity = resolveShellGateIdentity(request);

  // 2. Shell / native too old for this bundle.
  // 门禁：shellApiVersion，以及 optional minShellReleaseVersion（版本号门，替代已废弃的 minNativeBuild）。
  if (request.shellApiVersion < activeBundle.minShellApiVersion) {
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
  if (
    activeBundle.minShellReleaseVersion
    && gateIdentity
    && compareReleaseVersions(gateIdentity, activeBundle.minShellReleaseVersion) < 0
  ) {
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

  // 壳已内嵌或不低于 active web：仅 builtin 启用（门身份常回退到 nativeVersion）。
  // 门身份 >= activeBundle.releaseVersion → none（剥离 "1.18.2" > "1.18.2-beta.N"）。
  // 已安装 OTA（hex bundleId / 真实 web 版本名）与误报的剥离 currentBundleId 不走此分支，
  // 以免挡住同版本内容更正，并保留「剥离身份不得永久挡住同 core beta OTA」的 floor 语义。
  const shellEmbeddedActiveWeb = Boolean(
    request.currentBundleId === 'builtin'
    && gateIdentity
    && compareReleaseVersions(gateIdentity, activeBundle.releaseVersion) >= 0
  );

  // 4. Different active bundle → apply OTA.
  // The on-device client reports its current bundle either as the manifest
  // bundleId (content hash) or as the bundle version name (the Capgo plugin
  // identifies bundles by the `version` string it was downloaded with), so
  // both identities count as "current".
  const onCurrentBundle = request.currentBundleId === activeBundle.bundleId
    || request.currentBundleId === activeBundle.releaseVersion;
  const floorVersion = resolveCurrentFloorVersion(request, nativeTarget);
  const channelRollback = isStableChannelRollback(request, activeBundle.releaseVersion);
  if (
    !onCurrentBundle
    && !shellEmbeddedActiveWeb
    && (!isOtaDowngrade(activeBundle.releaseVersion, floorVersion) || channelRollback)
  ) {
    const decision = {
      status: 'ok',
      primaryAction: 'apply_ota',
      ota: {
        state: 'available',
        bundle: publicBundle(activeBundle),
      },
      native: nativeAvailableIfNewer(nativeTarget, request.nativeBuild),
      nextCheckInSec,
    };
    if (channelRollback) {
      decision.isChannelRollback = true;
    }
    return decision;
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
