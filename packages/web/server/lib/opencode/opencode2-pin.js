// Pinned desktop/runtime opencode2. Upgrade and prepare must not fall back to 1.18.x.
export const PINNED_OPENCODE2_VERSION = '0.0.0-next-17444';

export function isOpenCode1xVersion(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^v/i, '');
  if (!normalized) return false;
  return /^1(?:\.|$)/.test(normalized);
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
