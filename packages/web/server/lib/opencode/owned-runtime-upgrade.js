/**
 * Ownership + upgrade status for OpenCode runtimes (ticket 12).
 *
 * Binary ownership and process ownership are modeled separately:
 * - external serve (attached process) is never upgraded/restarted in-app
 * - managed process using a global CLI is "global-cli" (manual guidance)
 * - managed process using OpenChamber cache under opencode-cli/ is "owned-cache"
 * - bundled desktop binary cannot be upgraded separately
 *
 * In-app upgrade only mutates the owned cache, then launches that target and
 * verifies the running serve identity/version/contract before success.
 */

import path from 'node:path';
import {
  PINNED_OPENCODE2_VERSION,
  compareOpenCode2Versions,
  isOpenCode1xVersion,
  resolveOpenCode2UpgradeTarget,
} from './opencode2-pin.js';
import {
  installedOpenCode2BinaryPath,
  resolveOpenChamberDataDir,
} from './ensure-cli.js';
import { evaluateRuntimeContract, normalizeRuntimeVersion } from './runtime-contract.js';

/** @typedef {'external-serve' | 'owned-cache' | 'global-cli' | 'bundled' | 'settings' | 'env' | 'unknown'} RuntimeOwnership */

/**
 * @param {string | null | undefined} binaryPath
 * @param {string | null | undefined} dataDir
 */
export function isOwnedOpenCodeCachePath(binaryPath, dataDir) {
  if (typeof binaryPath !== 'string' || !binaryPath.trim()) return false;
  const root = typeof dataDir === 'string' && dataDir.trim()
    ? path.resolve(dataDir.trim())
    : resolveOpenChamberDataDir();
  const cacheRoot = path.resolve(root, 'opencode-cli');
  const resolved = path.resolve(binaryPath.trim());
  const rel = path.relative(cacheRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{
 *   isExternal?: boolean,
 *   binarySource?: string | null,
 *   binaryPath?: string | null,
 *   dataDir?: string | null,
 * }} input
 */
export function classifyRuntimeOwnership(input = {}) {
  if (input.isExternal === true) {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('external-serve'),
      processOwnership: 'external',
      binaryOwnership: isOwnedOpenCodeCachePath(input.binaryPath, input.dataDir) ? 'owned-cache' : 'external-or-global',
      canUpgradeInApp: false,
      supplySource: 'external-serve',
      management: 'manual-external',
      reason: 'external-serve',
      guidance: 'This is an external OpenCode serve. Restart or upgrade it yourself; OpenChamber will not replace that process.',
    };
  }

  const source = typeof input.binarySource === 'string' ? input.binarySource.trim() : '';
  const ownedPath = isOwnedOpenCodeCachePath(input.binaryPath, input.dataDir);

  if (source === 'bundled') {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('bundled'),
      processOwnership: 'managed',
      binaryOwnership: 'bundled',
      canUpgradeInApp: false,
      supplySource: 'bundled',
      management: 'bundled',
      reason: 'bundled',
      guidance: 'OpenCode is bundled with OpenChamber Desktop and cannot be upgraded separately from the app.',
    };
  }

  if (source === 'installed' || ownedPath) {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('owned-cache'),
      processOwnership: 'managed',
      binaryOwnership: 'owned-cache',
      canUpgradeInApp: true,
      supplySource: 'owned-cache',
      management: 'in-app',
      reason: null,
      guidance: null,
    };
  }

  if (source === 'settings') {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('settings'),
      processOwnership: 'managed',
      binaryOwnership: 'user-configured',
      canUpgradeInApp: false,
      supplySource: 'settings',
      management: 'manual-global',
      reason: 'settings-binary',
      guidance: 'OpenCode is launched from a user-configured binary path. Change or upgrade that binary yourself, or clear the setting to use OpenChamber-managed cache.',
    };
  }

  if (source === 'env') {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('env'),
      processOwnership: 'managed',
      binaryOwnership: 'env',
      canUpgradeInApp: false,
      supplySource: 'env',
      management: 'manual-global',
      reason: 'env-binary',
      guidance: 'OpenCode is launched from OPENCODE_BINARY / related env. Upgrade that install yourself, or unset the env to allow OpenChamber-owned cache management.',
    };
  }

  // path / fallback / where / discovered → treat as global CLI (read-only for upgrade).
  if (source === 'path' || source === 'fallback' || source === 'where' || source === 'discovered') {
    return {
      ownership: /** @type {RuntimeOwnership} */ ('global-cli'),
      processOwnership: 'managed',
      binaryOwnership: 'global-cli',
      canUpgradeInApp: false,
      supplySource: 'global-cli',
      management: 'manual-global',
      reason: 'global-cli',
      guidance: 'OpenChamber is using your global OpenCode CLI. Upgrade it with your package manager (for example npm/bun), or install an OpenChamber-owned cache and select that target explicitly.',
    };
  }

  return {
    ownership: /** @type {RuntimeOwnership} */ ('unknown'),
    processOwnership: input.isExternal ? 'external' : 'managed',
    binaryOwnership: ownedPath ? 'owned-cache' : 'unknown',
    canUpgradeInApp: ownedPath,
    supplySource: ownedPath ? 'owned-cache' : 'unknown',
    management: ownedPath ? 'in-app' : 'none',
    reason: ownedPath ? null : 'unknown-ownership',
    guidance: ownedPath
      ? null
      : 'OpenCode supply source could not be classified. In-app upgrade is disabled until ownership is clear.',
  };
}

/**
 * @param {{
 *   ownership: ReturnType<typeof classifyRuntimeOwnership>,
 *   serveVersion?: string | null,
 *   cliVersion?: string | null,
 *   targetVersion?: string | null,
 *   contract?: ReturnType<typeof evaluateRuntimeContract> | null,
 *   operation?: Record<string, unknown> | null,
 *   hasActiveTasks?: boolean,
 * }} input
 */
export function buildUpgradeStatusSnapshot(input) {
  const ownership = input.ownership;
  const serveVersion = normalizeRuntimeVersion(input.serveVersion);
  const cliVersion = normalizeRuntimeVersion(input.cliVersion);
  const currentVersion = serveVersion || cliVersion;
  let targetVersion = null;
  try {
    targetVersion = resolveOpenCode2UpgradeTarget(input.targetVersion ?? PINNED_OPENCODE2_VERSION);
  } catch {
    targetVersion = PINNED_OPENCODE2_VERSION;
  }
  if (isOpenCode1xVersion(targetVersion)) {
    targetVersion = PINNED_OPENCODE2_VERSION;
  }

  const contract = input.contract || evaluateRuntimeContract({
    serveVersion,
    cliVersion,
    reachable: serveVersion != null || cliVersion != null,
    authenticated: true,
    healthOk: serveVersion != null,
  });

  const canManage = ownership.canUpgradeInApp === true;
  const newerTarget = Boolean(
    currentVersion
    && targetVersion
    && !isOpenCode1xVersion(currentVersion)
    && compareOpenCode2Versions(targetVersion, currentVersion) > 0,
  );
  const available = canManage && newerTarget ? true : (canManage ? false : null);

  /** @type {string | null} */
  let reason = ownership.reason;
  if (canManage && available === false && currentVersion && targetVersion) {
    reason = 'up-to-date';
  }
  if (!canManage && ownership.reason) {
    reason = ownership.reason;
  }
  if (input.hasActiveTasks === true && canManage && available) {
    reason = reason || 'active-tasks';
  }

  return {
    schemaVersion: 1,
    available,
    currentVersion,
    serveVersion,
    cliVersion,
    latestVersion: targetVersion,
    targetVersion,
    supplySource: ownership.supplySource,
    ownership: ownership.ownership,
    processOwnership: ownership.processOwnership,
    binaryOwnership: ownership.binaryOwnership,
    canManage,
    management: ownership.management,
    reason,
    guidance: ownership.guidance,
    hasActiveTasks: input.hasActiveTasks === true,
    contract,
    operation: input.operation && typeof input.operation === 'object'
      ? input.operation
      : { status: 'idle' },
  };
}

/**
 * In-memory upgrade operation state (single-flight).
 * @returns {{
 *   getState: () => object,
 *   begin: (target: string) => { ok: true } | { ok: false, status: number, body: object },
 *   succeed: (result: object) => void,
 *   fail: (error: object) => void,
 *   resetIdle: () => void,
 * }}
 */
export function createUpgradeOperationState() {
  /** @type {{
   *   status: 'idle' | 'running' | 'succeeded' | 'failed',
   *   targetVersion: string | null,
   *   startedAt: number | null,
   *   finishedAt: number | null,
   *   phase: string | null,
   *   error: string | null,
   *   errorCode: string | null,
   *   serveVersion: string | null,
   *   binaryPath: string | null,
   * }} */
  let state = {
    status: 'idle',
    targetVersion: null,
    startedAt: null,
    finishedAt: null,
    phase: null,
    error: null,
    errorCode: null,
    serveVersion: null,
    binaryPath: null,
  };

  return {
    getState: () => ({ ...state }),
    begin: (target) => {
      if (state.status === 'running') {
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'An OpenCode upgrade is already in progress',
            errorCode: 'UPGRADE_IN_PROGRESS',
            operation: { ...state },
          },
        };
      }
      state = {
        status: 'running',
        targetVersion: target,
        startedAt: Date.now(),
        finishedAt: null,
        phase: 'starting',
        error: null,
        errorCode: null,
        serveVersion: null,
        binaryPath: null,
      };
      return { ok: true };
    },
    setPhase: (phase, extra = {}) => {
      if (state.status !== 'running') return;
      state = { ...state, phase, ...extra };
    },
    succeed: (result = {}) => {
      state = {
        ...state,
        status: 'succeeded',
        finishedAt: Date.now(),
        phase: 'verified',
        error: null,
        errorCode: null,
        serveVersion: result.serveVersion ?? state.serveVersion,
        binaryPath: result.binaryPath ?? state.binaryPath,
      };
    },
    fail: (error = {}) => {
      state = {
        ...state,
        status: 'failed',
        finishedAt: Date.now(),
        phase: error.phase || state.phase || 'failed',
        error: typeof error.error === 'string' ? error.error : (error.message || 'Upgrade failed'),
        errorCode: error.errorCode || error.code || 'UPGRADE_FAILED',
        serveVersion: error.serveVersion ?? state.serveVersion,
        binaryPath: error.binaryPath ?? state.binaryPath,
      };
    },
    resetIdle: () => {
      state = {
        status: 'idle',
        targetVersion: null,
        startedAt: null,
        finishedAt: null,
        phase: null,
        error: null,
        errorCode: null,
        serveVersion: null,
        binaryPath: null,
      };
    },
  };
}

/**
 * Resolve the on-disk path OpenChamber will use for an owned-cache target.
 * @param {string} targetVersion
 * @param {object} [options]
 */
export function resolveOwnedCacheBinaryPath(targetVersion, options = {}) {
  const version = resolveOpenCode2UpgradeTarget(targetVersion);
  return installedOpenCode2BinaryPath(version, options);
}

/**
 * Pure post-upgrade verification: running serve must match target and pass contract.
 * @param {{
 *   targetVersion: string,
 *   serveVersion?: string | null,
 *   cliVersion?: string | null,
 *   binaryPath?: string | null,
 *   expectedBinaryPath?: string | null,
 *   contract?: ReturnType<typeof evaluateRuntimeContract> | null,
 * }} input
 */
export function evaluateOwnedUpgradeResult(input) {
  const target = resolveOpenCode2UpgradeTarget(input.targetVersion);
  const serveVersion = normalizeRuntimeVersion(input.serveVersion);
  const cliVersion = normalizeRuntimeVersion(input.cliVersion);
  const contract = input.contract || evaluateRuntimeContract({
    serveVersion,
    cliVersion,
    reachable: true,
    authenticated: true,
    healthOk: Boolean(serveVersion),
  });

  if (!serveVersion) {
    return {
      ok: false,
      errorCode: 'UPGRADE_SERVE_VERSION_MISSING',
      error: 'Upgrade started but the running OpenCode serve did not report a version',
      serveVersion,
      targetVersion: target,
      contract,
    };
  }
  if (serveVersion !== target) {
    return {
      ok: false,
      errorCode: 'UPGRADE_SERVE_VERSION_MISMATCH',
      error: `Running serve version ${serveVersion} does not match upgrade target ${target}`,
      serveVersion,
      targetVersion: target,
      contract,
    };
  }
  if (input.expectedBinaryPath && input.binaryPath
    && path.resolve(input.binaryPath) !== path.resolve(input.expectedBinaryPath)) {
    return {
      ok: false,
      errorCode: 'UPGRADE_BINARY_IDENTITY_MISMATCH',
      error: 'Managed process is not using the owned-cache binary selected for upgrade',
      serveVersion,
      targetVersion: target,
      contract,
    };
  }
  // Success requires the running serve to match target AND sit in the verified
  // contract band (executionAllowed). ready-unverified must not report success.
  if (
    !contract.executionAllowed
    || !contract.protocolCompatible
    || contract.versionBand !== 'verified'
  ) {
    return {
      ok: false,
      errorCode: 'UPGRADE_CONTRACT_FAILED',
      error: 'Running serve version matches target but failed runtime contract admission',
      serveVersion,
      targetVersion: target,
      contract,
    };
  }
  return {
    ok: true,
    serveVersion,
    targetVersion: target,
    contract,
  };
}
