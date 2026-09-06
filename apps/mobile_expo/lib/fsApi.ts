import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type FilesystemEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
};

export class FsApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'FsApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const parseEntries = (value: unknown): FilesystemEntry[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.name !== 'string' || typeof row.path !== 'string') return [];
    const isDirectory = row.isDirectory === true;
    return [
      {
        name: row.name,
        path: row.path,
        isDirectory,
        isFile: row.isFile === true || !isDirectory,
        isSymbolicLink: row.isSymbolicLink === true,
      },
    ];
  });
};

/** GET /api/fs/home — host home directory (not desktop Finder). */
export const getFilesystemHome = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<string | null> => {
  const response = await openchamberFetch(active, '/api/fs/home', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new FsApiError('Failed to resolve home directory', response.status);
  }
  const payload = asRecord(await response.json());
  return typeof payload?.home === 'string' && payload.home.length > 0 ? payload.home : null;
};

/** GET /api/fs/list — directory listing for new-project path picker. */
export const listFilesystem = async (
  active: ActiveRuntime,
  path?: string | null,
  options?: { respectGitignore?: boolean; signal?: AbortSignal },
): Promise<FilesystemEntry[]> => {
  const params = new URLSearchParams();
  if (path && path.trim()) params.set('path', path);
  if (options?.respectGitignore) params.set('respectGitignore', 'true');
  const query = params.toString();
  const response = await openchamberFetch(active, `/api/fs/list${query ? `?${query}` : ''}`, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    const payload = asRecord(await response.json());
    throw new FsApiError(
      typeof payload?.error === 'string' ? payload.error : 'Failed to list directory',
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return parseEntries(payload?.entries);
};

/** POST /api/fs/mkdir */
export const createDirectory = async (
  active: ActiveRuntime,
  dirPath: string,
  options?: { allowOutsideWorkspace?: boolean; signal?: AbortSignal },
): Promise<{ success: boolean; path: string }> => {
  const response = await openchamberFetch(active, '/api/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    }),
    signal: options?.signal,
  });
  if (!response.ok) {
    const payload = asRecord(await response.json());
    throw new FsApiError(
      typeof payload?.error === 'string' ? payload.error : 'Failed to create directory',
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return {
    success: payload?.success !== false,
    path: typeof payload?.path === 'string' ? payload.path : dirPath,
  };
};

/** POST /api/fs/clone */
export const cloneRepository = async (
  active: ActiveRuntime,
  input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null },
  options?: { signal?: AbortSignal },
): Promise<{ success: boolean; path: string; output?: string }> => {
  const response = await openchamberFetch(active, '/api/fs/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    signal: options?.signal,
  });
  if (!response.ok) {
    const payload = asRecord(await response.json());
    throw new FsApiError(
      typeof payload?.error === 'string' ? payload.error : 'Failed to clone repository',
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return {
    success: payload?.success !== false,
    path: typeof payload?.path === 'string' ? payload.path : input.destinationPath,
    output: typeof payload?.output === 'string' ? payload.output : undefined,
  };
};

const MAX_FILE_CHARS = 250_000;

/** GET /api/fs/read — text file content (Cap MobileFilesSurface). */
export const readFilesystemFile = async (
  active: ActiveRuntime,
  path: string,
  options?: { signal?: AbortSignal; allowOutsideWorkspace?: boolean },
): Promise<{ content: string; path: string }> => {
  const params = new URLSearchParams({ path });
  if (options?.allowOutsideWorkspace) params.set('allowOutsideWorkspace', 'true');
  const response = await openchamberFetch(active, `/api/fs/read?${params.toString()}`, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new FsApiError('Failed to read file', response.status);
  }
  let content = await response.text();
  if (content.length > MAX_FILE_CHARS) {
    content = `${content.slice(0, MAX_FILE_CHARS)}\n…`;
  }
  return { content, path };
};

/** GET /api/find/file — Cap file search for Files sheet. */
export const searchFilesystemFiles = async (
  active: ActiveRuntime,
  input: { directory: string; query: string; maxResults?: number },
  options?: { signal?: AbortSignal },
): Promise<Array<{ path: string; name: string }>> => {
  const params = new URLSearchParams();
  if (input.directory.trim()) params.set('directory', input.directory.trim());
  params.set('query', input.query);
  params.set('dirs', 'false');
  params.set('type', 'file');
  if (typeof input.maxResults === 'number') params.set('limit', String(input.maxResults));
  const response = await openchamberFetch(active, `/api/find/file?${params.toString()}`, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new FsApiError('Failed to search files', response.status);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : Array.isArray(asRecord(payload)?.results) ? (asRecord(payload)!.results as unknown[]) : [];
  return rows.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.path !== 'string') return [];
    const name =
      typeof row.name === 'string'
        ? row.name
        : row.path.split('/').filter(Boolean).at(-1) ?? row.path;
    return [{ path: row.path, name }];
  });
};

export const isHtmlFilePath = (path: string): boolean => /\.html?$/i.test(path);
export const isMarkdownFilePath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path);
export const fileNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized === '/') return normalized || '/';
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
};
export const parentDirectoryPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized.startsWith('/') ? '/' : null;
  return normalized.slice(0, index);
};
