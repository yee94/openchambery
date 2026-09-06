/**
 * Cap MobileFilesSurface data path — `GET /api/fs/list` (OpenCode client fs/list).
 * failure ≠ empty directory success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxFsEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
};

export type LynxFsListResult =
  | { status: 'ok'; directory: string; entries: LynxFsEntry[] }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const parseEntry = (entry: unknown): LynxFsEntry | null => {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : typeof record.path === 'string'
      ? record.path.split('/').filter(Boolean).at(-1) ?? record.path
      : '';
  if (!name) return null;
  const path = typeof record.path === 'string' && record.path.trim()
    ? record.path.trim()
    : name;
  const rawType = typeof record.type === 'string'
    ? record.type
    : record.isDirectory === true
      ? 'directory'
      : record.isFile === true
        ? 'file'
        : 'other';
  const type = rawType === 'directory' || rawType === 'dir'
    ? 'directory'
    : rawType === 'file'
      ? 'file'
      : 'other';
  return { name, path, type };
};

/** Cap `GET /api/fs/list?path=` — same route MobileFilesSurface directory query uses via OpenCode client. */
export const listLynxDirectory = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxFsListResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = directory?.trim();
  if (!trimmed) return { status: 'no-directory' };
  try {
    const params = new URLSearchParams({ path: trimmed });
    const response = await runtimeFetch(`/api/fs/list?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`fs/list failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const record = asRecord(payload);
    const rawEntries = Array.isArray(payload)
      ? payload
      : Array.isArray(record.entries)
        ? record.entries
        : null;
    if (!rawEntries) {
      return {
        status: 'failed',
        error: new Error('fs/list returned no entries array'),
      };
    }
    const entries = rawEntries
      .map(parseEntry)
      .filter((entry): entry is LynxFsEntry => Boolean(entry));
    return { status: 'ok', directory: trimmed, entries };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
