/**
 * Credential sync authorization is separate from target reachability.
 * Access to an SSH/managed remote does NOT imply permission to transfer
 * provider tokens (auth.json). Grants are per SyncTarget id and must be
 * established through a trust channel (instance settings / pairing).
 */

export const CREDENTIAL_SYNC_UNAUTHORIZED_CODE = 'credential_sync_unauthorized';
export const CREDENTIAL_SYNC_GRANT_CHANNEL_INSTANCE_SETTINGS = 'instance-settings';

export class CredentialSyncUnauthorizedError extends Error {
  /**
   * @param {string} targetId
   */
  constructor(targetId) {
    super(`Credential sync is not authorized for ${targetId}`);
    this.name = 'CredentialSyncUnauthorizedError';
    this.code = CREDENTIAL_SYNC_UNAUTHORIZED_CODE;
    this.targetId = targetId;
  }
}

/**
 * @param {object | null | undefined} plan
 */
export const planIncludesCredentials = (plan) => Boolean(plan?.authFile);

/**
 * Enforce authorization when a plan carries credentials.
 * Call from preview and apply before probe/prepare/putTar.
 *
 * @param {object | null | undefined} plan
 * @param {{ targetId: string, authorized: boolean }} ctx
 */
export const assertCredentialSyncAuthorized = (plan, ctx) => {
  if (!planIncludesCredentials(plan)) return;
  if (ctx?.authorized === true) return;
  throw new CredentialSyncUnauthorizedError(String(ctx?.targetId || plan?.targetId || 'unknown'));
};
