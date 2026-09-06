/**
 * Cap DirectoryExplorerDialog spirit against real fs/project APIs.
 * - GET /api/fs/home for home root
 * - GET /api/fs/list for browse (via listLynxDirectory)
 * - Add project via PUT /api/config/settings projects[] (same as entityApi)
 * failure ≠ empty success.
 */
import { listLynxDirectory, type LynxFsEntry, type LynxFsListResult } from '../chat/filesSurface';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadLynxSettings, saveLynxSettings } from '../settings/api';

export type LynxBrowseRow =
  | { type: 'up'; path: string | null; disabled: boolean }
  | { type: 'directory'; name: string; path: string; alreadyAdded: boolean };

const isRootPath = (value: string): boolean => value === '/';

const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSeparators = (value: string): string => {
  if (!value || isRootPath(value)) return value;
  let result = value;
  while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
  return result;
};

export const ensureLynxBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith('/')) return trimmed;
  return `${trimmed}/`;
};

export const getLynxBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || trimmed === '~/' || trimmed === '/') return null;
  const last = trimmed.lastIndexOf('/');
  if (last < 0) return null;
  if (trimmed.startsWith('~/') && last <= 1) return '~/';
  if (last === 0) return '/';
  return `${trimmed.slice(0, last)}/`;
};

export const appendLynxBrowsePathSegment = (currentPath: string, segment: string): string => (
  `${ensureLynxBrowseDirectoryPath(currentPath)}${segment}/`
);

export type LynxFsHomeResult =
  | { status: 'ok'; home: string }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

/** Cap `GET /api/fs/home`. */
export const loadLynxFsHome = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxFsHomeResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`fs/home failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json() as { home?: unknown; path?: unknown };
    const home = typeof payload.home === 'string' && payload.home.trim()
      ? payload.home.trim()
      : typeof payload.path === 'string' && payload.path.trim()
        ? payload.path.trim()
        : '';
    if (!home) {
      return { status: 'failed', error: new Error('fs/home returned no path') };
    }
    return { status: 'ok', home: normalizeSeparators(home) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const browseLynxDirectory = (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxFsListResult> => listLynxDirectory(runtimeFetch, directory, options);

const projectPathOf = (entry: unknown): string | null => {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  return path ? normalizeSeparators(trimTrailingSeparators(path)) : null;
};

export type LynxAddProjectResult =
  | { status: 'ok'; path: string; id: string; created: boolean }
  | { status: 'no-runtime' }
  | { status: 'invalid-path' }
  | { status: 'failed'; error: Error; httpStatus?: number };

/**
 * Add a browsed directory to settings `projects[]` (Cap DirectoryExplorer add spirit).
 * Existing path → ok created:false (idempotent activate).
 */
export const addLynxProjectFromPath = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  absolutePath: string,
  options?: { label?: string; signal?: AbortSignal },
): Promise<LynxAddProjectResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const path = normalizeSeparators(trimTrailingSeparators(absolutePath.trim()));
  if (!path || path === '/' || path === '~') return { status: 'invalid-path' };

  const loaded = await loadLynxSettings(runtimeFetch, { signal: options?.signal });
  if (loaded.status === 'no-runtime') return { status: 'no-runtime' };
  if (loaded.status === 'failed') {
    return { status: 'failed', error: loaded.error, httpStatus: loaded.httpStatus };
  }

  const projects = Array.isArray(loaded.settings.projects) ? [...loaded.settings.projects] : [];
  const existing = projects.find((entry) => projectPathOf(entry) === path);
  if (existing) {
    const id = (typeof existing.id === 'string' && existing.id) || path;
    return { status: 'ok', path, id, created: false };
  }

  const label = options?.label?.trim()
    || path.split('/').filter(Boolean).at(-1)
    || path;
  const id = `proj_${path.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 64)}`;
  const now = Date.now();
  projects.unshift({
    id,
    path,
    name: label,
    label,
    addedAt: now,
    lastOpenedAt: now,
  });

  const saved = await saveLynxSettings(runtimeFetch, { projects }, { signal: options?.signal });
  if (saved.status === 'ok') return { status: 'ok', path, id, created: true };
  if (saved.status === 'no-runtime') return { status: 'no-runtime' };
  return { status: 'failed', error: saved.error, httpStatus: saved.httpStatus };
};

export const buildLynxBrowseRows = (
  entries: LynxFsEntry[],
  currentPath: string,
  addedPaths: ReadonlySet<string>,
): LynxBrowseRow[] => {
  const parent = getLynxBrowseParentPath(currentPath);
  const rows: LynxBrowseRow[] = [
    { type: 'up', path: parent, disabled: parent === null },
  ];
  for (const entry of entries) {
    if (entry.type !== 'directory') continue;
    const normalized = normalizeSeparators(trimTrailingSeparators(entry.path));
    rows.push({
      type: 'directory',
      name: entry.name,
      path: entry.path,
      alreadyAdded: addedPaths.has(normalized),
    });
  }
  return rows;
};

export const collectLynxAddedProjectPaths = (
  settingsProjects: unknown,
): Set<string> => {
  const set = new Set<string>();
  if (!Array.isArray(settingsProjects)) return set;
  for (const entry of settingsProjects) {
    const path = projectPathOf(entry);
    if (path) set.add(path);
  }
  return set;
};
