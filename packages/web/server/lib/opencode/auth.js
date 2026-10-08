import { makeOpenCodeV2Client } from './v2-client.js';

/** @typedef {{ type: 'api', key: string } | { type: 'oauth', access: string, refresh: string, expires: number, accountId?: string, enterpriseUrl?: string }} ProviderCredential */
/** @type {null | (() => import('@opencode/client').OpenCodeClient)} */
let getClient = null;

/** Configure only in the trusted host. Resolve endpoint and authentication on every call. */
export function configureOpenCodeCredentials(resolveClient) {
  getClient = resolveClient;
}

export function openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) {
  return () => makeOpenCodeV2Client({
    baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
    authHeaders: getOpenCodeAuthHeaders(),
  });
}

const credentialError = () => new Error('Unable to read OpenCode credentials');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate before projection: malformed/unsupported responses are never empty success. */
function validateCredentialEntries(entries) {
  if (!Array.isArray(entries)) throw credentialError();
  const active = new Set();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.integrationID !== 'string'
      || !entry.integrationID || typeof entry.active !== 'boolean' || !record(entry.value)) throw credentialError();
    const value = entry.value;
    if (value.type === 'key') {
      if (typeof value.key !== 'string') throw credentialError();
    } else if (value.type === 'oauth') {
      if (typeof value.access !== 'string' || typeof value.refresh !== 'string' || !Number.isFinite(value.expires)) throw credentialError();
    } else throw credentialError();
    if (entry.active) {
      if (active.has(entry.integrationID)) throw credentialError();
      active.add(entry.integrationID);
    }
  }
  return entries;
}

async function listCredentials(client) {
  try {
    return validateCredentialEntries(await client.credential.list({ signal: AbortSignal.timeout(8000) }));
  } catch {
    // Upstream errors can contain response bodies or request headers with secrets.
    throw credentialError();
  }
}

function currentClient() {
  if (!getClient) throw credentialError();
  try { return getClient(); } catch { throw credentialError(); }
}

/** Host-only selected provider credentials. Never serialize this result to a client. */
export async function readOpenCodeCredentials() {
  const entries = await listCredentials(currentClient());
  /** @type {Record<string, ProviderCredential>} */
  const result = Object.create(null);
  for (const entry of entries) {
    if (!entry.active) continue;
    const value = entry.value;
    result[entry.integrationID] = value.type === 'key' ? { type: 'api', key: value.key } : {
      type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires,
      ...(typeof value.metadata?.accountID === 'string' ? { accountId: value.metadata.accountID } : {}),
      ...(typeof value.metadata?.enterpriseUrl === 'string' ? { enterpriseUrl: value.metadata.enterpriseUrl } : {}),
    };
  }
  return result;
}

export async function getProviderAuth(providerId) {
  return (await readOpenCodeCredentials())[providerId] || null;
}

/** Disconnect every saved account for the provider, so deleting active cannot select another. */
export async function removeProviderAuth(providerId) {
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('Provider ID is required');
  const client = currentClient();
  const entries = (await listCredentials(client)).filter((entry) => entry.integrationID === providerId);
  for (const entry of entries) {
    try {
      await client.credential.remove({ credentialID: entry.id }, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new Error('Unable to remove OpenCode credentials; some accounts may already have been removed. Retry to finish disconnecting.');
    }
  }
  return entries.length > 0;
}
