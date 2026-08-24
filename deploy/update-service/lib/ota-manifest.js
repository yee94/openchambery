import { parseReleaseVersion } from './semver.js';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUNDLE_ID_PATTERN = /^[0-9a-f]{16}$/;
// Unencrypted checksums are plain 64-char hex — the @capgo/capacitor-updater
// native plugin compares this value verbatim against its own hex digest.
const PLAIN_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const CHECKSUM_PREFIX = 'sha256:';
const BUNDLE_URL_PREFIX = '/ota/bundles/';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePlatformMinNative(value, platform, errors) {
  if (!isRecord(value)) {
    errors.push(`activeBundle.platforms.${platform} must be an object`);
    return null;
  }
  // deprecated：存量 manifest 兼容读取；OTA 判定已改用 activeBundle.minShellReleaseVersion，不再使用 minNativeBuild。
  if (!Number.isInteger(value.minNativeBuild) || value.minNativeBuild < 1) {
    errors.push(`activeBundle.platforms.${platform}.minNativeBuild must be a positive integer`);
    return null;
  }
  return { minNativeBuild: value.minNativeBuild };
}

function parseActiveBundle(value, errors) {
  if (value === null) return null;
  if (!isRecord(value)) {
    errors.push('activeBundle must be an object or null');
    return undefined;
  }

  const bundle = {};

  if (typeof value.bundleId !== 'string' || !BUNDLE_ID_PATTERN.test(value.bundleId)) {
    errors.push('activeBundle.bundleId must be a 16-char hex string');
  } else {
    bundle.bundleId = value.bundleId;
  }

  if (typeof value.releaseVersion !== 'string' || !VERSION_PATTERN.test(value.releaseVersion)) {
    errors.push('activeBundle.releaseVersion must be a semver string');
  } else {
    bundle.releaseVersion = value.releaseVersion;
  }

  if (typeof value.url !== 'string'
    || !value.url.startsWith(BUNDLE_URL_PREFIX)
    || value.url.includes('..')) {
    errors.push('activeBundle.url must be a relative path under /ota/bundles/');
  } else {
    bundle.url = value.url;
  }

  if (!Number.isInteger(value.size) || value.size < 1) {
    errors.push('activeBundle.size must be a positive integer');
  } else {
    bundle.size = value.size;
  }

  if (typeof value.checksum !== 'string' || value.checksum.trim().length === 0) {
    errors.push('activeBundle.checksum must be a non-empty string');
  } else if (value.sessionKey !== undefined) {
    // Encrypted bundles carry the opaque encrypted checksum produced by the
    // Capgo CLI; the native plugin RSA-decrypts it before comparing.
    bundle.checksum = value.checksum.trim();
  } else {
    const raw = value.checksum.trim().toLowerCase();
    const stripped = raw.startsWith(CHECKSUM_PREFIX) ? raw.slice(CHECKSUM_PREFIX.length) : raw;
    if (PLAIN_CHECKSUM_PATTERN.test(stripped)) {
      bundle.checksum = stripped;
    } else {
      errors.push('activeBundle.checksum must be 64-char hex (optionally sha256:-prefixed) when the bundle is not encrypted');
    }
  }

  if (value.sessionKey !== undefined) {
    if (!isNonEmptyString(value.sessionKey)) {
      errors.push('activeBundle.sessionKey must be a non-empty string when present');
    } else {
      bundle.sessionKey = value.sessionKey;
    }
  }

  if (!Number.isInteger(value.rolloutPercent) || value.rolloutPercent < 0 || value.rolloutPercent > 100) {
    errors.push('activeBundle.rolloutPercent must be an integer from 0 to 100');
  } else {
    bundle.rolloutPercent = value.rolloutPercent;
  }

  if (!isNonEmptyString(value.rolloutSalt)) {
    errors.push('activeBundle.rolloutSalt must be a non-empty string');
  } else {
    bundle.rolloutSalt = value.rolloutSalt;
  }

  if (!Number.isInteger(value.minShellApiVersion) || value.minShellApiVersion < 1) {
    errors.push('activeBundle.minShellApiVersion must be a positive integer');
  } else {
    bundle.minShellApiVersion = value.minShellApiVersion;
  }

  // optional：原生壳能力下限（版本号）。mode: native 发布时写入本轮版本；判定见 ota-resolver。
  if (value.minShellReleaseVersion !== undefined) {
    if (typeof value.minShellReleaseVersion !== 'string'
      || !parseReleaseVersion(value.minShellReleaseVersion)) {
      errors.push('activeBundle.minShellReleaseVersion must be a release version (X.Y.Z or X.Y.Z-beta.N)');
    } else {
      bundle.minShellReleaseVersion = value.minShellReleaseVersion;
    }
  }

  if (!isRecord(value.platforms)) {
    errors.push('activeBundle.platforms must be an object');
  } else {
    const ios = parsePlatformMinNative(value.platforms.ios, 'ios', errors);
    const android = parsePlatformMinNative(value.platforms.android, 'android', errors);
    if (ios && android) {
      bundle.platforms = { ios, android };
    }
  }

  return errors.length === 0 ? bundle : undefined;
}

function parseNativeTarget(value, platform, errors) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`nativeTargets.${platform} must be an object when present`);
    return undefined;
  }

  const target = {};
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    errors.push(`nativeTargets.${platform}.version must be a semver string`);
  } else {
    target.version = value.version;
  }

  if (!Number.isInteger(value.build) || value.build < 1) {
    errors.push(`nativeTargets.${platform}.build must be a positive integer`);
  } else {
    target.build = value.build;
  }

  if (value.status !== undefined) {
    if (!isNonEmptyString(value.status)) {
      errors.push(`nativeTargets.${platform}.status must be a non-empty string when present`);
    } else {
      target.status = value.status;
    }
  }

  if (value.installUrl !== undefined) {
    if (typeof value.installUrl !== 'string' || value.installUrl.trim().length === 0) {
      errors.push(`nativeTargets.${platform}.installUrl must be a non-empty string when present`);
    } else {
      target.installUrl = value.installUrl;
    }
  }

  return (target.version && target.build) ? target : undefined;
}

/**
 * Validate and normalize a channel OTA manifest.
 * `activeBundle: null` means OTA is enabled for the channel but no bundle is published yet.
 */
export function parseOtaManifest(value) {
  const errors = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  if (value.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }

  if (!isNonEmptyString(value.channel)) {
    errors.push('channel must be a non-empty string');
  }

  if (!Number.isInteger(value.generation) || value.generation < 0) {
    errors.push('generation must be a non-negative integer');
  }

  const activeBundle = parseActiveBundle(value.activeBundle, errors);

  if (!isRecord(value.nativeTargets)) {
    errors.push('nativeTargets must be an object');
  }

  if (!Array.isArray(value.rollbackBundleIds)) {
    errors.push('rollbackBundleIds must be an array');
  } else if (value.rollbackBundleIds.length > 2) {
    errors.push('rollbackBundleIds may contain at most 2 entries');
  } else {
    for (const id of value.rollbackBundleIds) {
      if (typeof id !== 'string' || !BUNDLE_ID_PATTERN.test(id)) {
        errors.push('rollbackBundleIds entries must be 16-char hex strings');
        break;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const nativeTargets = {};
  const ios = parseNativeTarget(value.nativeTargets.ios, 'ios', errors);
  const android = parseNativeTarget(value.nativeTargets.android, 'android', errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (ios) nativeTargets.ios = ios;
  if (android) nativeTargets.android = android;

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      channel: value.channel,
      generation: value.generation,
      activeBundle: activeBundle === null ? null : activeBundle,
      nativeTargets,
      rollbackBundleIds: [...value.rollbackBundleIds],
    },
  };
}

/**
 * Load and validate `/ota/channels/<channel>.json` relative to `baseUrl`.
 * Fetch/parse failure returns null — never fabricate an empty-success manifest.
 */
export async function loadOtaChannelManifest(baseUrl, channel, fetchImpl = fetch) {
  if (typeof channel !== 'string' || !/^[a-z0-9_-]+$/i.test(channel)) {
    return null;
  }

  try {
    const response = await fetchImpl(new URL(`/ota/channels/${channel}.json`, baseUrl), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;

    const parsed = parseOtaManifest(await response.json());
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}
