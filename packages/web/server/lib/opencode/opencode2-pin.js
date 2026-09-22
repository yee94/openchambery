// Pinned desktop/runtime opencode2. Upgrade and prepare must not fall back to 1.18.x.
export const PINNED_OPENCODE2_VERSION = '2.0.12';

// Global npm/bun package that installs the opencode2 binary (not 1.x opencode-ai).
export const OPENCODE2_NPM_PACKAGE = '@opencode/cli';

export function isOpenCode1xVersion(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^v/i, '');
  if (!normalized) return false;
  return /^1(?:\.|$)/.test(normalized);
}

/**
 * Health admission for managed/external opencode2.
 * healthy alone is not enough: reject 1.x and missing/unknown version strings.
 */
export function isAcceptableOpenCode2HealthVersion(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^v/i, '');
  if (!normalized) return false;
  if (isOpenCode1xVersion(normalized)) return false;
  // Require a version-like token (semver or next pin), not free-form noise.
  return /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized);
}

/**
 * Pure health/info body gate used by lifecycle and VS Code sidecar.
 * Accepts classic `{ healthy: true, version }` and official 2.x `ServerInfo`
 * (`GET /api/info` → `{ version, pid, urls, paths }` without `healthy`).
 * @param {{ healthy?: unknown, version?: unknown } | null | undefined} body
 * @returns {{ ok: boolean, version: string | null, reason?: string }}
 */
export function evaluateOpenCodeHealthBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, version: null, reason: 'invalid-body' };
  }
  // Classic /api/health required healthy:true; /api/info omits healthy entirely.
  if (Object.prototype.hasOwnProperty.call(body, 'healthy') && body.healthy !== true) {
    return { ok: false, version: null, reason: 'unhealthy' };
  }
  const raw = typeof body.version === 'string' ? body.version.trim() : '';
  const version = raw ? raw.replace(/^v/i, '') : null;
  if (!isAcceptableOpenCode2HealthVersion(version)) {
    if (isOpenCode1xVersion(version)) {
      return { ok: false, version, reason: '1x-version' };
    }
    return { ok: false, version, reason: 'unknown-version' };
  }
  return { ok: true, version };
}

export function rejectOpenCode1xUpgradeTarget(target) {
  if (isOpenCode1xVersion(target)) {
    const error = new Error(`OpenCode upgrade refuses 1.x target: ${target}`);
    error.code = 'OPENCODE_UPGRADE_1X_REFUSED';
    throw error;
  }
  return target;
}

export function resolveOpenCode2UpgradeTarget(target) {
  const trimmed = typeof target === 'string' ? target.trim() : '';
  if (trimmed) {
    rejectOpenCode1xUpgradeTarget(trimmed);
    return trimmed;
  }
  return PINNED_OPENCODE2_VERSION;
}

/**
 * Parse `opencode2 --version` / `opencode --version` stdout.
 * v2: `opencode2 v2.0.12` (name then version). 1.x: `1.18.18`.
 */
export function parseOpenCode2VersionOutput(stdout) {
  const tokens = String(stdout || '').trim().split(/\s+/);
  const versionToken = tokens.find((token) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(token));
  if (!versionToken) return '';
  return versionToken.replace(/^v/, '');
}

export function openCodeBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'opencode.exe' : 'opencode';
}

/** @deprecated Packaging leftover. Runtime install uses `openCodeBinaryName`. */
export function openCode2BinaryName(platform = process.platform) {
  return platform === 'win32' ? 'opencode2.exe' : 'opencode2';
}

export function resolveOpenCode2NpmArchitecture(arch = process.arch) {
  const normalized = String(arch || '').trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64' || normalized === 'x86_64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  throw new Error(`Unsupported OpenCode architecture ${JSON.stringify(arch)}`);
}

/**
 * Official 2.x ships as `@opencode/cli-<os>-<arch>[-baseline]`.
 * `targetArchitecture` may be `{ opencode }` (Electron prepare) or an arch string.
 */
export function npmPackageForOpenCode2(platform = process.platform, targetArchitecture = process.arch) {
  const rawArch = targetArchitecture && typeof targetArchitecture === 'object'
    ? (targetArchitecture.opencode ?? targetArchitecture.node)
    : targetArchitecture;
  const arch = resolveOpenCode2NpmArchitecture(rawArch);
  const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform];
  if (!os) throw new Error(`No opencode2 npm package mapping for platform ${platform}`);
  const suffix = arch === 'x64' ? '-baseline' : '';
  return `@opencode/cli-${os}-${arch}${suffix}`;
}

function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/i, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { parts, prerelease: prereleaseIndex >= 0 };
}

export function compareOpenCode2Versions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
}

export function isOpenCode2VersionAtLeast(version, minimum = PINNED_OPENCODE2_VERSION) {
  if (!isAcceptableOpenCode2HealthVersion(version)) return false;
  return compareOpenCode2Versions(version, minimum) >= 0;
}
