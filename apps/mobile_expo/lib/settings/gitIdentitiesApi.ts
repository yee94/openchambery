import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class GitIdentitiesApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitIdentitiesApiError';
    this.status = status;
  }
}

export type GitIdentity = {
  id: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseGitIdentities = (payload: unknown): GitIdentity[] => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.identities)
      ? (asRecord(payload)!.identities as unknown[])
      : null;
  if (!list) throw new GitIdentitiesApiError('invalid_git_identities_response', 200);
  return list.flatMap((item) => {
    const row = asRecord(item);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!id) return [];
    return [{
      ...(row as GitIdentity),
      id,
      name: typeof row?.name === 'string' ? row.name : undefined,
      email: typeof row?.email === 'string' ? row.email : undefined,
    }];
  });
};

/** GET /api/git/identities */
export const loadGitIdentities = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<GitIdentity[]> => {
  const response = await openchamberFetch(active, '/api/git/identities', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) throw new GitIdentitiesApiError('Failed to load git identities', response.status);
  return parseGitIdentities(await response.json());
};
