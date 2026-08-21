import { syncTargetIdForSshInstance } from './sync-run-store.mjs';

export const CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY = 'desktopCredentialSyncGrants';
export const CREDENTIAL_SYNC_GRANT_CHANNEL_INSTANCE_SETTINGS = 'instance-settings';

/**
 * Per-target credential-sync grants persisted in settings.json.
 * Shape: { [targetId: string]: { grantedAt: string, channel: string } }
 *
 * @param {{ settingsStore: { readRoot: () => object, mutate: (fn: Function) => Promise<unknown> } }} options
 */
export const createCredentialSyncAuthStore = (options) => {
  const settingsStore = options?.settingsStore;
  if (!settingsStore || typeof settingsStore.readRoot !== 'function' || typeof settingsStore.mutate !== 'function') {
    throw new Error('settingsStore is required');
  }

  const readGrantsMap = () => {
    const root = settingsStore.readRoot();
    const raw = root?.[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  };

  const normalizeGrant = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const grantedAt = typeof entry.grantedAt === 'string' ? entry.grantedAt.trim() : '';
    const channel = typeof entry.channel === 'string' ? entry.channel.trim() : '';
    if (!grantedAt || !channel) return null;
    return { grantedAt, channel };
  };

  /**
   * @param {string} targetId
   * @returns {{ targetId: string, authorized: boolean, grantedAt?: string, channel?: string }}
   */
  const getGrant = (targetId) => {
    const id = String(targetId || '').trim();
    if (!id) throw new Error('sync targetId is required');
    const grant = normalizeGrant(readGrantsMap()[id]);
    if (!grant) {
      return { targetId: id, authorized: false };
    }
    return { targetId: id, authorized: true, grantedAt: grant.grantedAt, channel: grant.channel };
  };

  /**
   * @param {string} instanceId
   */
  const getGrantForSshInstance = (instanceId) => getGrant(syncTargetIdForSshInstance(instanceId));

  /**
   * @param {string} targetId
   * @param {{ channel?: string, grantedAt?: string }} [options]
   */
  const grant = async (targetId, grantOptions = {}) => {
    const id = String(targetId || '').trim();
    if (!id) throw new Error('sync targetId is required');
    const channel = typeof grantOptions.channel === 'string' && grantOptions.channel.trim()
      ? grantOptions.channel.trim()
      : CREDENTIAL_SYNC_GRANT_CHANNEL_INSTANCE_SETTINGS;
    const grantedAt = typeof grantOptions.grantedAt === 'string' && grantOptions.grantedAt.trim()
      ? grantOptions.grantedAt.trim()
      : new Date().toISOString();

    await settingsStore.mutate((root) => {
      const current = root[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY];
      const nextMap = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
      nextMap[id] = { grantedAt, channel };
      root[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY] = nextMap;
      return root;
    });

    return getGrant(id);
  };

  /**
   * @param {string} instanceId
   */
  const grantForSshInstance = async (instanceId, grantOptions) => (
    grant(syncTargetIdForSshInstance(instanceId), grantOptions)
  );

  /**
   * @param {string} targetId
   */
  const revoke = async (targetId) => {
    const id = String(targetId || '').trim();
    if (!id) throw new Error('sync targetId is required');

    await settingsStore.mutate((root) => {
      const current = root[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return root;
      }
      if (!Object.prototype.hasOwnProperty.call(current, id)) {
        return root;
      }
      const nextMap = { ...current };
      delete nextMap[id];
      if (Object.keys(nextMap).length === 0) {
        delete root[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY];
      } else {
        root[CREDENTIAL_SYNC_GRANTS_SETTINGS_KEY] = nextMap;
      }
      return root;
    });

    return getGrant(id);
  };

  /**
   * @param {string} instanceId
   */
  const revokeForSshInstance = async (instanceId) => revoke(syncTargetIdForSshInstance(instanceId));

  const isAuthorized = (targetId) => getGrant(targetId).authorized === true;

  return {
    getGrant,
    getGrantForSshInstance,
    grant,
    grantForSshInstance,
    revoke,
    revokeForSshInstance,
    isAuthorized,
  };
};
