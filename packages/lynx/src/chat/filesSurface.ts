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

export type LynxFsReadResult =
  | { status: 'ok'; path: string; content: string; truncated: boolean }
  | { status: 'no-runtime' }
  | { status: 'no-path' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const DEFAULT_PREVIEW_MAX_CHARS = 200_000;

/**
 * Cap MobileFilesSurface text preview — `GET /api/fs/read?path=` (text/plain).
 * Truncates large files for list/preview UI; failure ≠ empty success.
 */
export const readLynxFile = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  path: string | null | undefined,
  options?: { signal?: AbortSignal; maxChars?: number },
): Promise<LynxFsReadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = path?.trim();
  if (!trimmed) return { status: 'no-path' };
  const maxChars = options?.maxChars ?? DEFAULT_PREVIEW_MAX_CHARS;
  try {
    const params = new URLSearchParams({ path: trimmed });
    const response = await runtimeFetch(`/api/fs/read?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'text/plain, application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`fs/read failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    let content: string;
    if (typeof response.text === 'function') {
      content = await response.text();
    } else {
      const payload = await response.json();
      if (typeof payload === 'string') {
        content = payload;
      } else if (payload && typeof payload === 'object' && typeof (payload as { content?: unknown }).content === 'string') {
        content = (payload as { content: string }).content;
      } else {
        return {
          status: 'failed',
          error: new Error('fs/read returned non-text body (host must provide response.text)'),
        };
      }
    }
    const truncated = content.length > maxChars;
    return {
      status: 'ok',
      path: trimmed,
      content: truncated ? content.slice(0, maxChars) : content,
      truncated,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export type LynxFsSearchHit = {
  /** Absolute path under the search directory. */
  path: string;
  /** Cap relative path from `/api/find/file` (also used as preview[0]). */
  relativePath: string;
  name: string;
};

export type LynxFsSearchResult =
  | { status: 'ok'; directory: string; query: string; hits: LynxFsSearchHit[] }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'no-query' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const DEFAULT_SEARCH_LIMIT = 40;

const normalizeFsPath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/g, '');

const joinDirectoryRelative = (directory: string, relativePath: string): string => {
  const root = normalizeFsPath(directory);
  const rel = normalizeFsPath(relativePath).replace(/^\.\//, '');
  if (!rel) return root;
  if (rel.startsWith('/')) return rel;
  return `${root}/${rel}`;
};

const nameFromPath = (path: string): string => {
  const parts = normalizeFsPath(path).split('/').filter(Boolean);
  return parts.at(-1) || path;
};

/**
 * Cap MobileFilesSurface file search — `GET /api/find/file`
 * (web `createWebFilesAPI.search` / OpenCode `find.files`).
 * Cap phone: `dirs=false` + `type=file` + `maxResults` default 40.
 * failure ≠ empty hits success; empty query → `no-query` (caller should not search).
 */
export const searchLynxFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    directory: string | null | undefined;
    query: string | null | undefined;
    maxResults?: number;
    signal?: AbortSignal;
  },
): Promise<LynxFsSearchResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const directory = input.directory?.trim();
  if (!directory) return { status: 'no-directory' };
  const query = input.query?.trim() ?? '';
  if (!query) return { status: 'no-query' };
  const limit = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
    ? Math.max(1, Math.floor(input.maxResults))
    : DEFAULT_SEARCH_LIMIT;
  try {
    const params = new URLSearchParams({
      directory,
      query,
      dirs: 'false',
      type: 'file',
      limit: String(limit),
    });
    const response = await runtimeFetch(`/api/find/file?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-opencode-directory': directory,
      },
      signal: input.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`find/file failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const rawItems = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown })?.data)
        ? (payload as { data: unknown[] }).data
        : null;
    if (!rawItems) {
      return {
        status: 'failed',
        error: new Error('find/file returned no array'),
      };
    }
    const hits: LynxFsSearchHit[] = [];
    for (const item of rawItems) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const relativePath = normalizeFsPath(item.trim());
      const path = joinDirectoryRelative(directory, relativePath);
      hits.push({
        path,
        relativePath,
        name: nameFromPath(path),
      });
    }
    return { status: 'ok', directory, query, hits };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
