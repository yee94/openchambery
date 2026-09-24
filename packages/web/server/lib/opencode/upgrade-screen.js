/**
 * Startup upgrade screen for OpenCode below 2.0.15.
 *
 * This module does not own process lifecycle. It classifies the version the
 * existing startup path already detected, and installs through the owned-cache
 * installer (`installPinnedOpenCode2Cli`) plus the caller's restart hook.
 * Success is a verified running version, never a download that has not started.
 */

import {
  PINNED_OPENCODE2_VERSION,
  isAcceptableOpenCode2HealthVersion,
  isOpenCode1xVersion,
  isOpenCode2VersionAtLeast,
  npmPackageForOpenCode2,
} from './opencode2-pin.js';

/** Oldest OpenCode this OpenChamber build will enter a session against. */
export const REQUIRED_OPENCODE_VERSION = '2.0.15';

const normalizeVersion = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/i, '');
  return trimmed || null;
};

/**
 * Install target is the pin when the pin already satisfies the screen, otherwise
 * the screen minimum. A pin still at 2.0.12 must not be what this screen installs.
 * @param {string} [pin]
 */
export function resolveUpgradeScreenTarget(pin = PINNED_OPENCODE2_VERSION) {
  if (isOpenCode2VersionAtLeast(pin, REQUIRED_OPENCODE_VERSION)) return pin;
  return REQUIRED_OPENCODE_VERSION;
}

/** 2.x at or above the screen minimum. A future major is not this contract. */
function isUpgradeScreenSatisfied(version) {
  const normalized = normalizeVersion(version);
  if (!normalized || !isAcceptableOpenCode2HealthVersion(normalized)) return false;
  return isOpenCode2VersionAtLeast(normalized, REQUIRED_OPENCODE_VERSION);
}

function isOlderThanUpgradeScreenMinimum(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return false;
  if (isOpenCode1xVersion(normalized)) return true;
  if (!isAcceptableOpenCode2HealthVersion(normalized)) return false;
  return !isOpenCode2VersionAtLeast(normalized, REQUIRED_OPENCODE_VERSION);
}

/**
 * @param {string | null | undefined} ownership
 * @returns {'managed' | 'external' | 'bundled'}
 */
function classifyUpgradeScreenInstallation(ownership) {
  if (ownership === 'external-serve') return 'external';
  if (ownership === 'bundled') return 'bundled';
  return 'managed';
}

export function platformSupportsUpgradeScreenInstall(platform = process.platform, arch = process.arch) {
  try {
    npmPackageForOpenCode2(platform, arch);
    return true;
  } catch {
    return false;
  }
}

const pickDetectedVersion = (serveVersion, cliVersion) => {
  const serve = normalizeVersion(serveVersion);
  const cli = normalizeVersion(cliVersion);
  if (serve && !isUpgradeScreenSatisfied(serve)) return serve;
  if (serve) return serve;
  return cli;
};

/**
 * @param {{
 *   version?: string | null,
 *   installation?: 'managed' | 'external' | 'bundled',
 *   platformCanInstall?: boolean,
 *   guidance?: string | null,
 *   pin?: string,
 * }} input
 */
export function describeUpgradeScreen(input = {}) {
  const version = normalizeVersion(input.version);
  const installation = input.installation === 'external' || input.installation === 'bundled'
    ? input.installation
    : 'managed';
  const state = version == null
    ? 'unavailable'
    : isUpgradeScreenSatisfied(version)
      ? 'compatible'
      : 'incompatible';
  const older = version != null && isOlderThanUpgradeScreenMinimum(version);
  // External processes are not replaced. Bundled and managed locals can receive
  // an owned-cache install; that does not overwrite the user's other binaries.
  const canInstall = state === 'incompatible'
    && older
    && installation !== 'external'
    && input.platformCanInstall === true;
  const guidance = canInstall
    ? null
    : (typeof input.guidance === 'string' && input.guidance.trim() ? input.guidance.trim() : null);
  return {
    state,
    version,
    installation,
    minimumVersion: REQUIRED_OPENCODE_VERSION,
    targetVersion: resolveUpgradeScreenTarget(input.pin),
    canInstall,
    guidance,
  };
}

/**
 * A running serve below the minimum, or a missing version, is not an upgrade.
 * @param {{ targetVersion?: string | null, serveVersion?: string | null }} input
 */
export function evaluateUpgradeScreenInstallResult(input = {}) {
  const targetVersion = resolveUpgradeScreenTarget(input.targetVersion || REQUIRED_OPENCODE_VERSION);
  const version = normalizeVersion(input.serveVersion);
  if (!version || !isUpgradeScreenSatisfied(version) || !isOpenCode2VersionAtLeast(version, targetVersion)) {
    const found = version || 'unknown';
    return {
      ok: false,
      upgraded: false,
      version,
      targetVersion,
      errorCode: 'UPGRADE_SCREEN_NOT_VERIFIED',
      error: `OpenCode is still ${found}. OpenChamber requires ${REQUIRED_OPENCODE_VERSION} or newer.`,
    };
  }
  return {
    ok: true,
    upgraded: true,
    version,
    targetVersion,
    error: null,
    errorCode: null,
  };
}

async function readUpgradeScreenStatus(deps) {
  const ownership = typeof deps.resolveOwnership === 'function'
    ? await deps.resolveOwnership()
    : { ownership: 'unknown', guidance: null };
  const installation = classifyUpgradeScreenInstallation(ownership?.ownership);
  const serveVersion = typeof deps.readServeVersion === 'function'
    ? await Promise.resolve(deps.readServeVersion()).catch(() => null)
    : null;
  const cliVersion = typeof deps.readCliVersion === 'function'
    ? await Promise.resolve(deps.readCliVersion()).catch(() => null)
    : null;
  return describeUpgradeScreen({
    version: pickDetectedVersion(serveVersion, cliVersion),
    installation,
    platformCanInstall: typeof deps.platformCanInstall === 'boolean'
      ? deps.platformCanInstall
      : platformSupportsUpgradeScreenInstall(deps.platform, deps.arch),
    guidance: ownership?.guidance ?? null,
    pin: deps.pin,
  });
}

const failure = (message, code, status = 500) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

/**
 * Install the screen target into the owned cache and restart through the
 * caller's existing lifecycle hooks. Restores the previous binary selection
 * when verification fails. Never returns upgraded:true for a failed install.
 * @param {object} deps
 */
export async function installRequiredOpenCode(deps) {
  const status = await readUpgradeScreenStatus(deps);
  if (status.state !== 'incompatible' || status.canInstall !== true) {
    throw failure(
      status.guidance || 'Automatic OpenCode installation is unavailable for this runtime.',
      'UPGRADE_SCREEN_UNAVAILABLE',
      409,
    );
  }
  const target = status.targetVersion;
  const previousBinary = typeof deps.getResolvedBinary === 'function' ? deps.getResolvedBinary() : null;
  const previousSource = typeof deps.getResolvedBinarySource === 'function' ? deps.getResolvedBinarySource() : null;
  const previousSetting = typeof deps.readConfiguredBinary === 'function'
    ? await deps.readConfiguredBinary()
    : undefined;
  let persisted = false;
  try {
    if (typeof deps.install !== 'function') {
      throw failure('OpenCode install is not configured.', 'UPGRADE_SCREEN_INSTALL_UNAVAILABLE', 500);
    }
    const installedPath = await deps.install({ version: target });
    const diskVersion = typeof deps.readBinaryVersion === 'function'
      ? await Promise.resolve(deps.readBinaryVersion(installedPath))
      : null;
    if (diskVersion !== target) {
      throw failure(
        `Installed OpenCode version mismatch: expected ${target}, got ${diskVersion || 'unknown'}`,
        'UPGRADE_SCREEN_BINARY_MISMATCH',
        500,
      );
    }
    if (typeof deps.persistBinary === 'function') {
      await deps.persistBinary(installedPath);
      persisted = true;
    }
    if (typeof deps.forceBinary === 'function') {
      deps.forceBinary(installedPath, 'installed');
    }
    if (typeof deps.restart === 'function') {
      const shared = typeof deps.isSharedService === 'function' && deps.isSharedService() === true;
      await deps.restart(shared ? { binaryPath: installedPath } : undefined);
    }
    if (typeof deps.waitReady === 'function') {
      await deps.waitReady();
    }
    const serveVersion = typeof deps.readServeVersion === 'function'
      ? await deps.readServeVersion()
      : null;
    const verification = evaluateUpgradeScreenInstallResult({ targetVersion: target, serveVersion });
    if (!verification.ok) {
      throw failure(verification.error, verification.errorCode, 500);
    }
    return verification;
  } catch (error) {
    if (persisted && typeof deps.persistBinary === 'function') {
      try {
        await deps.persistBinary(typeof previousSetting === 'string' ? previousSetting : '');
      } catch {
        // Keep the install error. A failed restore must not become success.
      }
    }
    if (previousBinary && typeof deps.forceBinary === 'function') {
      try {
        deps.forceBinary(previousBinary, previousSource || 'discovered');
      } catch {
        // Same: report the install failure, not a restored-success.
      }
    }
    throw error;
  }
}

export function registerUpgradeScreenRoutes(app, deps) {
  app.get('/api/opencode/compatibility', async (_req, res) => {
    try {
      res.json(await readUpgradeScreenStatus(deps));
    } catch (error) {
      res.status(503).json({
        error: error instanceof Error ? error.message : 'Could not check OpenCode compatibility',
      });
    }
  });

  let inFlight = null;
  app.post('/api/opencode/install-required', async (_req, res) => {
    try {
      if (!inFlight) {
        inFlight = installRequiredOpenCode(deps).finally(() => {
          inFlight = null;
        });
      }
      const result = await inFlight;
      if (!result || result.ok !== true || result.upgraded !== true || !result.version) {
        return res.status(500).json({
          success: false,
          upgraded: false,
          error: result?.error || 'OpenCode installation did not verify a new version',
          errorCode: result?.errorCode || 'UPGRADE_SCREEN_NOT_VERIFIED',
          version: result?.version ?? null,
        });
      }
      return res.json({
        success: true,
        upgraded: true,
        version: result.version,
        targetVersion: result.targetVersion,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return res.status(status).json({
        success: false,
        upgraded: false,
        error: error instanceof Error ? error.message : 'OpenCode installation failed',
        errorCode: error?.code || 'UPGRADE_SCREEN_FAILED',
      });
    }
  });
}
