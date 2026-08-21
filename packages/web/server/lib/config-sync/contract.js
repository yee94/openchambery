import {
  syncTargetIdForDirectHost,
  syncTargetIdForRelayServer,
  syncTargetIdForSshInstance,
} from './target-id.js';

/**
 * @typedef {{
 *   posixShell: boolean,
 *   tarExtract: boolean,
 *   authFileWrite: boolean,
 *   ocHttp?: boolean,
 * }} SyncTargetCapabilities
 *
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   capabilities: SyncTargetCapabilities,
 * }} SyncTarget
 *
 * @typedef {{
 *   remoteExisting: string[],
 *   remoteAgentsRootExists: boolean,
 *   remoteAuthFileExists: boolean,
 * }} SyncProbeResult
 *
 * Payload for putTar. Callers always hand a fully buffered archive
 * (SSH stdin and direct/relay HTTP bodies alike).
 * @typedef {Buffer | Uint8Array} SyncTarPayload
 *
 * @typedef {{
 *   probe: (plan: object) => Promise<SyncProbeResult>,
 *   prepare: (plan: object, ctx: { syncRunId: string }) => Promise<void>,
 *   putTar: (args: { kind: 'config' | 'agents' | 'auth', payload: SyncTarPayload }) => Promise<void>,
 *   finalize: (plan: object, ctx: { syncRunId: string }) => Promise<{ ok: true }>,
 * }} TargetExecutor
 */

export const EMPTY_SYNC_CAPABILITIES = Object.freeze({
  posixShell: false,
  tarExtract: false,
  authFileWrite: false,
  ocHttp: false,
});

export const MANAGED_SSH_SYNC_CAPABILITIES = Object.freeze({
  posixShell: true,
  tarExtract: true,
  authFileWrite: true,
  ocHttp: false,
});

export const DIRECT_HOST_SYNC_CAPABILITIES = Object.freeze({
  posixShell: false,
  tarExtract: false,
  authFileWrite: true,
  ocHttp: true,
});

export const RELAY_HOST_SYNC_CAPABILITIES = Object.freeze({
  posixShell: false,
  tarExtract: false,
  authFileWrite: true,
  ocHttp: true,
});

/**
 * Build a namespaced SyncTarget for an SSH instance.
 * Managed remotes expose posixShell/tarExtract/authFileWrite; others expose none
 * (semantic equivalent of the former mode==='managed' hard gate).
 *
 * @param {string} instanceId
 * @param {{ remoteOpenchamber?: { mode?: string } } | null | undefined} [instance]
 * @returns {SyncTarget}
 */
export const createSshSyncTarget = (instanceId, instance) => {
  const managed = instance?.remoteOpenchamber?.mode === 'managed';
  return {
    id: syncTargetIdForSshInstance(instanceId),
    kind: 'ssh',
    capabilities: managed ? { ...MANAGED_SSH_SYNC_CAPABILITIES } : { ...EMPTY_SYNC_CAPABILITIES },
  };
};

/**
 * Direct OpenChamber host reached over HTTP (apiUrl + clientToken).
 * @param {string} hostId
 * @returns {SyncTarget}
 */
export const createDirectHostSyncTarget = (hostId) => ({
  id: syncTargetIdForDirectHost(hostId),
  kind: 'direct',
  capabilities: { ...DIRECT_HOST_SYNC_CAPABILITIES },
});

/**
 * Relay OpenChamber host pinned by serverId (signing-key fingerprint).
 * @param {string} serverId
 * @returns {SyncTarget}
 */
export const createRelayHostSyncTarget = (serverId) => ({
  id: syncTargetIdForRelayServer(serverId),
  kind: 'relay',
  capabilities: { ...RELAY_HOST_SYNC_CAPABILITIES },
});

/**
 * @param {SyncTarget | null | undefined} target
 * @param {keyof SyncTargetCapabilities} capability
 */
export const assertTargetCapability = (target, capability) => {
  if (!target || typeof target !== 'object') {
    throw new Error('Sync target is required');
  }
  if (!target.capabilities?.[capability]) {
    throw new Error(`OpenCode config sync requires target capability: ${capability}`);
  }
};

/**
 * Validate that a plan is direction-aware and uses a known direction value.
 * @param {object} plan
 */
export const assertPlanDirection = (plan) => {
  const direction = plan?.direction;
  if (direction !== 'push' && direction !== 'pull') {
    throw new Error(`Sync plan requires direction 'push' or 'pull', got ${String(direction)}`);
  }
  return direction;
};
