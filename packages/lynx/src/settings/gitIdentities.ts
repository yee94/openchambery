/**
 * Cap GitIdentity* APIs — `/api/git/identities` (+ global-identity).
 * Source: packages/ui/src/lib/gitApiHttp.ts, GitIdentityEditorDialog.
 * failure ≠ empty / fake-success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxGitIdentityAuthType = 'ssh' | 'token';

export type LynxGitIdentityProfile = {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: LynxGitIdentityAuthType;
  sshKey?: string | null;
  signCommits?: boolean;
  signingKey?: string | null;
  host?: string | null;
};

export type LynxGitIdentitiesLoadResult =
  | { status: 'ok'; profiles: LynxGitIdentityProfile[]; global: LynxGitIdentityProfile | null }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxGitIdentityMutationResult =
  | { status: 'ok'; profile?: LynxGitIdentityProfile }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const str = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const parseProfile = (raw: unknown): LynxGitIdentityProfile | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = str(record.id);
  const name = str(record.name) || str(record.userName) || id;
  const userName = str(record.userName) || '';
  const userEmail = str(record.userEmail) || '';
  if (!id || !name) return null;
  const authRaw = str(record.authType);
  const authType = authRaw === 'token' || authRaw === 'ssh' ? authRaw : undefined;
  return {
    id,
    name,
    userName,
    userEmail,
    authType,
    sshKey: str(record.sshKey) ?? null,
    signCommits: typeof record.signCommits === 'boolean' ? record.signCommits : undefined,
    signingKey: str(record.signingKey) ?? null,
    host: str(record.host) ?? null,
  };
};

/** Cap `GET /api/git/identities` + best-effort `GET /api/git/global-identity`. */
export const loadLynxGitIdentities = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxGitIdentitiesLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/git/identities', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/identities failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(asRecord(payload).profiles)
        ? (asRecord(payload).profiles as unknown[])
        : Array.isArray(asRecord(payload).identities)
          ? (asRecord(payload).identities as unknown[])
          : null;
    if (!list) {
      return { status: 'failed', error: new Error('git/identities returned no array') };
    }
    const profiles = list
      .map(parseProfile)
      .filter((item): item is LynxGitIdentityProfile => Boolean(item));

    let global: LynxGitIdentityProfile | null = null;
    try {
      const globalRes = await runtimeFetch('/api/git/global-identity', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      });
      if (globalRes.ok) {
        const data = asRecord(await globalRes.json());
        const userName = str(data.userName) || '';
        const userEmail = str(data.userEmail) || '';
        if (userName || userEmail) {
          global = {
            id: 'global',
            name: 'Global Identity',
            userName,
            userEmail,
            authType: str(data.sshCommand) ? 'ssh' : undefined,
            sshKey: str(data.sshCommand) ?? null,
          };
        }
      }
    } catch {
      // global is best-effort
    }

    return { status: 'ok', profiles, global };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `POST /api/git/identities`. */
export const createLynxGitIdentity = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  profile: Omit<LynxGitIdentityProfile, 'id'> & { id?: string },
  options?: { signal?: AbortSignal },
): Promise<LynxGitIdentityMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  if (!profile.name.trim() || !profile.userName.trim() || !profile.userEmail.trim()) {
    return { status: 'failed', error: new Error('name, userName, and userEmail are required') };
  }
  try {
    const response = await runtimeFetch('/api/git/identities', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(profile),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/identities create failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const parsed = parseProfile(await response.json());
    return parsed ? { status: 'ok', profile: parsed } : { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `PUT /api/git/identities/:id`. */
export const updateLynxGitIdentity = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  id: string,
  updates: Partial<LynxGitIdentityProfile>,
  options?: { signal?: AbortSignal },
): Promise<LynxGitIdentityMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = id.trim();
  if (!trimmed || trimmed === 'global') {
    return { status: 'failed', error: new Error('cannot update global identity via profiles API') };
  }
  try {
    const response = await runtimeFetch(`/api/git/identities/${encodeURIComponent(trimmed)}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...updates, id: trimmed }),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/identities update failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const parsed = parseProfile(await response.json());
    return parsed ? { status: 'ok', profile: parsed } : { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `DELETE /api/git/identities/:id`. */
export const deleteLynxGitIdentity = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  id: string,
  options?: { signal?: AbortSignal },
): Promise<LynxGitIdentityMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = id.trim();
  if (!trimmed || trimmed === 'global') {
    return { status: 'failed', error: new Error('cannot delete global identity') };
  }
  try {
    const response = await runtimeFetch(`/api/git/identities/${encodeURIComponent(trimmed)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/identities delete failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
