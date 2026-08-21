/** @param {string} instanceId */
export const syncTargetIdForSshInstance = (instanceId) => {
  const id = String(instanceId || '').trim();
  if (!id) throw new Error('SSH instance id is required');
  return `ssh:${id}`;
};

/** @param {string} hostId */
export const syncTargetIdForDirectHost = (hostId) => {
  const id = String(hostId || '').trim();
  if (!id) throw new Error('Desktop host id is required');
  return `host:${id}`;
};

/** @param {string} serverId relay host signing-key fingerprint */
export const syncTargetIdForRelayServer = (serverId) => {
  const id = String(serverId || '').trim();
  if (!id) throw new Error('Relay serverId is required');
  return `relay:${id}`;
};
