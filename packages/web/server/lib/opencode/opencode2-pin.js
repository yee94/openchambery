// Pinned desktop/runtime opencode2. Upgrade and prepare must not fall back to 1.18.x.
export const PINNED_OPENCODE2_VERSION = '0.0.0-next-17444';

// Global npm/bun package that installs the opencode2 binary (not 1.x opencode-ai).
export const OPENCODE2_NPM_PACKAGE = '@opencode-ai/cli';

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
 * Pure health body gate used by lifecycle and VS Code sidecar.
 * @param {{ healthy?: unknown, version?: unknown } | null | undefined} body
 * @returns {{ ok: boolean, version: string | null, reason?: string }}
 */
export function evaluateOpenCodeHealthBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, version: null, reason: 'invalid-body' };
  }
  if (body.healthy !== true) {
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
