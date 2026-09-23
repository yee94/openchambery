/**
 * Runtime contract admission for the actual OpenCode serve in use.
 *
 * Discovery may still prefer a global CLI / existing serve. Feature open is
 * based on the running serve version against a documented matrix — not on
 * "any 2.x health body" alone. Health success is reachability, not full
 * execution semantics.
 *
 * Evidence bounds (ticket 11):
 * - MIN_VERIFIED: pin / installed verification (`2.0.12`)
 * - MAX_VERIFIED: read-only official source review (`2.0.14`)
 * Unverified newer 2.x stays connected for diagnostics (phase ready-unverified)
 * but executionAllowed is false until the band is verified; older 2.x and 1.x
 * are limited or refused explicitly.
 */

import {
  PINNED_OPENCODE2_VERSION,
  compareOpenCode2Versions,
  isAcceptableOpenCode2HealthVersion,
  isOpenCode1xVersion,
} from './opencode2-pin.js';

/** Lowest version with documented OpenChamber + OpenCode 2 contract tests. */
export const RUNTIME_CONTRACT_MIN_VERIFIED = PINNED_OPENCODE2_VERSION;

/** Highest version reviewed against official source without claiming infinite future range. */
export const RUNTIME_CONTRACT_MAX_VERIFIED = '2.0.14';

/**
 * Optional / core capabilities and the minimum serve version that admits them.
 * Tickets 01 / 02 / 05 / 06 share the verified floor until narrower evidence exists.
 */
export const RUNTIME_CONTRACT_CAPABILITIES = Object.freeze({
  'core.protocol': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: true,
    description: 'Core HTTP/SSE session protocol used by OpenChamber',
  },
  'session.prompt': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: true,
    description: 'Prompt admission and idle send (ticket 02)',
  },
  'session.queuedInput': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: false,
    description: 'Queued input selection / inheritance (ticket 01)',
  },
  'session.background': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: false,
    description: 'Background / non-blocking work (ticket 05)',
  },
  'session.generationFallback': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: false,
    description: 'Session generation fallback helpers (ticket 06)',
  },
  'migration.v1Read': {
    minVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    requiredForExecution: false,
    description: 'Read-only V1 migration status probe',
  },
});

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeRuntimeVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/i, '');
  return trimmed || null;
}

/**
 * @param {string | null | undefined} version
 * @returns {'1x' | 'invalid' | 'below-min' | 'verified' | 'unverified-newer' | 'unknown'}
 */
export function classifyRuntimeVersionBand(version) {
  const normalized = normalizeRuntimeVersion(version);
  if (!normalized) return 'unknown';
  if (isOpenCode1xVersion(normalized)) return '1x';
  if (!isAcceptableOpenCode2HealthVersion(normalized)) return 'invalid';
  if (compareOpenCode2Versions(normalized, RUNTIME_CONTRACT_MIN_VERIFIED) < 0) {
    return 'below-min';
  }
  if (compareOpenCode2Versions(normalized, RUNTIME_CONTRACT_MAX_VERIFIED) > 0) {
    return 'unverified-newer';
  }
  return 'verified';
}

/**
 * @param {string | null | undefined} version
 * @param {string} minimum
 */
export function versionMeetsMinimum(version, minimum) {
  const normalized = normalizeRuntimeVersion(version);
  if (!normalized || !isAcceptableOpenCode2HealthVersion(normalized)) return false;
  return compareOpenCode2Versions(normalized, minimum) >= 0;
}

/**
 * @param {{
 *   serveVersion?: string | null,
 *   cliVersion?: string | null,
 *   reachable?: boolean,
 *   authenticated?: boolean | null,
 *   healthOk?: boolean | null,
 *   migrationAdmitTranscript?: boolean | null,
 *   migrationPhase?: string | null,
 *   migrationError?: string | null,
 * }} input
 */
export function evaluateRuntimeContract(input = {}) {
  const serveVersion = normalizeRuntimeVersion(input.serveVersion);
  const cliVersion = normalizeRuntimeVersion(input.cliVersion);
  const reachable = input.reachable === true;
  const authenticated = typeof input.authenticated === 'boolean' ? input.authenticated : null;
  const healthOk = typeof input.healthOk === 'boolean' ? input.healthOk : null;
  const migrationAdmit = typeof input.migrationAdmitTranscript === 'boolean'
    ? input.migrationAdmitTranscript
    : null;
  const migrationPhase = typeof input.migrationPhase === 'string' ? input.migrationPhase : null;
  const migrationError = typeof input.migrationError === 'string' ? input.migrationError : null;

  /** @type {string[]} */
  const reasons = [];
  const versionBand = classifyRuntimeVersionBand(serveVersion);
  const versionMismatch = Boolean(
    serveVersion
    && cliVersion
    && serveVersion !== cliVersion,
  );

  if (!reachable) {
    reasons.push('unreachable');
  }
  if (authenticated === false) {
    reasons.push('auth-failed');
  }
  if (healthOk === false) {
    reasons.push('health-failed');
  }
  if (!serveVersion) {
    reasons.push('serve-version-unknown');
  } else if (versionBand === '1x') {
    reasons.push('1x-version');
  } else if (versionBand === 'invalid') {
    reasons.push('invalid-version');
  } else if (versionBand === 'below-min') {
    reasons.push('below-min-verified');
  } else if (versionBand === 'unverified-newer') {
    reasons.push('unverified-newer');
  }
  if (versionMismatch) {
    reasons.push('cli-serve-version-mismatch');
  }

  /** @type {Record<string, { available: boolean, reason: string | null, minVersion: string, requiredForExecution: boolean }>} */
  const capabilities = {};
  for (const [id, meta] of Object.entries(RUNTIME_CONTRACT_CAPABILITIES)) {
    let available = false;
    /** @type {string | null} */
    let reason = null;
    if (!reachable) {
      reason = 'unreachable';
    } else if (authenticated === false) {
      reason = 'auth-failed';
    } else if (healthOk === false) {
      reason = 'health-failed';
    } else if (!serveVersion) {
      reason = 'serve-version-unknown';
    } else if (versionBand === '1x') {
      reason = '1x-version';
    } else if (versionBand === 'invalid') {
      reason = 'invalid-version';
    } else if (!versionMeetsMinimum(serveVersion, meta.minVersion)) {
      reason = 'below-capability-min';
    } else if (versionBand === 'unverified-newer') {
      // The read-only migration probe remains diagnostic; execution capabilities share the write gate.
      available = id === 'migration.v1Read';
      reason = 'unverified-newer';
    } else {
      available = true;
    }
    capabilities[id] = {
      available,
      reason,
      minVersion: meta.minVersion,
      requiredForExecution: meta.requiredForExecution === true,
    };
  }

  // Protocol dimension: verified band is fully compatible; unverified-newer is
  // not hard-incompatible for diagnostics, but required execution caps stay closed.
  const protocolCompatible = reachable
    && authenticated !== false
    && healthOk !== false
    && (versionBand === 'verified' || versionBand === 'unverified-newer');

  const requiredCapsOk = Object.values(capabilities)
    .filter((cap) => cap.requiredForExecution)
    .every((cap) => cap.available);

  const migrationExecutable = migrationAdmit === null
    ? null
    : migrationAdmit === true;

  if (migrationAdmit === false) {
    reasons.push(migrationPhase === 'error' ? 'migration-error' : 'migration-blocked');
  }

  // Execution requires a **verified** serve band only. Unverified-newer stays
  // connected (phase ready-unverified + diagnostics) but must not open writes;
  // below-min / unknown / 1.x never execute.
  const executionAllowed = reachable
    && authenticated !== false
    && healthOk !== false
    && protocolCompatible
    && requiredCapsOk
    && migrationAdmit !== false
    && versionBand === 'verified';

  /** @type {string} */
  let phase = 'ready';
  if (!reachable) {
    phase = 'unreachable';
  } else if (authenticated === false) {
    phase = 'unauthenticated';
  } else if (!serveVersion || versionBand === 'invalid' || versionBand === 'unknown') {
    phase = 'unknown';
  } else if (versionBand === '1x' || versionBand === 'below-min' || !protocolCompatible) {
    phase = 'incompatible';
  } else if (migrationAdmit === false) {
    phase = 'migration-blocked';
  } else if (healthOk === false) {
    phase = 'unhealthy';
  } else if (versionBand === 'unverified-newer') {
    phase = 'ready-unverified';
  }

  return {
    schemaVersion: 1,
    phase,
    reachable,
    authenticated,
    healthOk,
    protocolCompatible,
    executionAllowed,
    migrationExecutable,
    migrationPhase,
    migrationError,
    serveVersion,
    cliVersion,
    versionBand,
    versionMismatch,
    minVerifiedVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
    maxVerifiedVersion: RUNTIME_CONTRACT_MAX_VERIFIED,
    pinnedVersion: PINNED_OPENCODE2_VERSION,
    capabilities,
    reasons,
  };
}

/**
 * Whether a proxied OpenCode API path is diagnostic-only (must stay available
 * when execution is limited).
 * @param {string} method
 * @param {string} pathWithQuery
 */
export function isRuntimeContractDiagnosticPath(method, pathWithQuery) {
  const upper = String(method || 'GET').toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return false;
  const pathOnly = String(pathWithQuery || '').split('?')[0] || '';
  const normalized = pathOnly.replace(/\/+$/, '') || '/';
  return (
    normalized === '/api/info'
    || normalized === '/api/health'
    || normalized === '/global/health'
    || normalized === '/api/experimental/migration/v1'
    || normalized.endsWith('/info')
    || normalized.endsWith('/health')
  );
}

/**
 * Stop / cancel paths that must remain available when execution is limited
 * (user can still halt in-flight work and read diagnostics).
 * @param {string} method
 * @param {string} pathWithQuery
 */
export function isRuntimeContractStopPath(method, pathWithQuery) {
  const upper = String(method || 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return false;
  const pathOnly = String(pathWithQuery || '').split('?')[0] || '';
  return /\/session(?:\/[^/]+)?\/(?:interrupt|abort)\b/.test(pathOnly);
}

/**
 * Mutating session / turn paths that require executionAllowed.
 * Interrupt/abort are excluded so stop-task remains available under limited execution.
 * @param {string} method
 * @param {string} pathWithQuery
 */
export function isRuntimeContractExecutionPath(method, pathWithQuery) {
  const upper = String(method || 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return false;
  if (isRuntimeContractStopPath(method, pathWithQuery)) return false;
  const pathOnly = String(pathWithQuery || '').split('?')[0] || '';
  // Official v2 turn + control surfaces (and classic aliases). Reads stay open.
  return /\/session(?:\/[^/]+)?\/(?:prompt|prompt_async|command|shell|revert|unrevert|summarize|fork|generate|background|model|agent|synthetic|compact|skill|move|environment|instructions)(?:\/|$)/.test(pathOnly)
    || ((upper === 'POST' || upper === 'PATCH') && /\/session\/[^/]+\/inbox\/[^/]+(?:\/(?:steer|queue))?\/?$/.test(pathOnly))
    || (upper === 'POST' && /\/session\/[^/]+\/form(?:\/|$)/.test(pathOnly))
    || /\/session(?:\/[^/]+)?\/message(?:\/|$)/.test(pathOnly)
    || /\/permission\//.test(pathOnly)
    || /\/question\//.test(pathOnly)
    // Session create / patch title metadata used by host background (queue/goal/scheduled).
    || (upper === 'POST' && /\/session\/?$/.test(pathOnly))
    || (upper === 'PATCH' && /\/session\/[^/]+\/?$/.test(pathOnly));
}

/**
 * Pending / revoked snapshot published while a new serve instance is starting
 * or after start/restart/target change invalidates the previous permit.
 * @param {string} [reason]
 * @param {{ instanceGeneration?: number | null }} [extra]
 */
export function createRevokedRuntimeContract(reason = 'instance-revoked', extra = {}) {
  const base = evaluateRuntimeContract({
    reachable: false,
    authenticated: null,
    healthOk: null,
    serveVersion: null,
  });
  return {
    ...base,
    phase: 'pending',
    executionAllowed: false,
    reasons: reason ? [reason, ...base.reasons.filter((entry) => entry !== 'unreachable')] : base.reasons,
    instanceGeneration: typeof extra.instanceGeneration === 'number' ? extra.instanceGeneration : null,
  };
}

/**
 * Whether a host-side OpenCode request should be blocked by contract admission.
 * Diagnostics, reads, and stop-task stay available when execution is limited.
 *
 * Production default: execution paths require the **current** contract to set
 * `executionAllowed === true` explicitly. A null/missing contract blocks writes
 * (no silent bypass during startup or after revoke). Unit/DI factories may pass
 * `{ allowMissingContract: true }` when no contract is wired.
 *
 * @param {string} method
 * @param {string} pathWithQuery
 * @param {{ executionAllowed?: boolean } | null | undefined} contract
 * @param {{ allowMissingContract?: boolean }} [options]
 */
export function shouldBlockRuntimeContractExecution(method, pathWithQuery, contract, options = {}) {
  if (isRuntimeContractDiagnosticPath(method, pathWithQuery)) return false;
  if (isRuntimeContractStopPath(method, pathWithQuery)) return false;
  if (!isRuntimeContractExecutionPath(method, pathWithQuery)) return false;

  if (contract == null || typeof contract !== 'object') {
    // Test DI only: production never opts into missing-contract bypass.
    return options.allowMissingContract !== true;
  }
  // Explicit true only — undefined / false / pending all block execution paths.
  return contract.executionAllowed !== true;
}

/**
 * Structured 409 body shared by proxy + serverOpenCodeFetch.
 * @param {object} contract
 */
export function runtimeContractExecutionBlockedBody(contract) {
  return {
    error: 'OpenCode runtime contract does not allow execution for this version',
    errorCode: 'RUNTIME_CONTRACT_EXECUTION_BLOCKED',
    phase: contract?.phase ?? null,
    reasons: Array.isArray(contract?.reasons) ? contract.reasons : [],
    serveVersion: contract?.serveVersion ?? null,
    minVerifiedVersion: contract?.minVerifiedVersion ?? null,
    maxVerifiedVersion: contract?.maxVerifiedVersion ?? null,
    contract: contract ?? null,
  };
}
