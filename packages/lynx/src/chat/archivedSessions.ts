/**
 * Cap ArchivedSessionsDialog spirit for Lynx — list/restore archived sessions.
 *
 * Cap loads archived via experimental.session.list({ archived: true }) (OpenChamber
 * proxy: GET /api/experimental/session). Session-index drops archived roots, so the
 * list route is authoritative; session-index only supplies project labels. Restore
 * uses unarchiveLynxSession (PATCH time.archived=0). Never fake-success.
 */
import { normalizePath } from '../path';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { getProjectLabel } from '../session-index/homeModel';
import type { SessionIndexSnapshot } from '../session-index/types';

export const LYNX_ARCHIVED_OTHER_PROJECT_ID = '__other__';
export const LYNX_ARCHIVED_SESSIONS_PAGE_SIZE = 200;

export type LynxArchivedSessionRow = {
  id: string;
  title: string;
  directory: string | null;
  activityAt: number;
  archivedAt: number;
};

export type LynxArchivedProjectBucket = {
  projectId: string;
  label: string;
  path: string | null;
  sessions: LynxArchivedSessionRow[];
};

export type LynxArchivedSessionsModel = {
  buckets: LynxArchivedProjectBucket[];
  total: number;
  empty: boolean;
};

export type LynxArchivedSessionListResult =
  | { status: 'ok'; sessions: LynxArchivedSessionRow[] }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

type RawArchivedSession = {
  id?: unknown;
  title?: unknown;
  directory?: unknown;
  parentID?: unknown;
  time?: {
    created?: unknown;
    updated?: unknown;
    archived?: unknown;
  } | null;
  project?: { worktree?: unknown; name?: unknown; id?: unknown } | null;
};

const toFinite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const isLynxArchivedByTime = (session: {
  time?: { archived?: unknown } | null;
}): boolean => toFinite(session.time?.archived) > 0;

export const getLynxArchivedSessionActivityMs = (session: {
  time?: { created?: unknown; updated?: unknown; archived?: unknown } | null;
}): number => {
  const updated = toFinite(session.time?.updated);
  const archived = toFinite(session.time?.archived);
  const created = toFinite(session.time?.created);
  return Math.max(updated, archived, created);
};

const resolveDirectory = (session: RawArchivedSession): string | null => {
  if (typeof session.directory === 'string' && session.directory.trim()) {
    return normalizePath(session.directory);
  }
  const worktree = session.project?.worktree;
  if (typeof worktree === 'string' && worktree.trim()) {
    return normalizePath(worktree);
  }
  return null;
};

export const parseLynxArchivedSessionRow = (
  raw: RawArchivedSession,
  options?: { untitledLabel?: string },
): LynxArchivedSessionRow | null => {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  if (typeof raw.parentID === 'string' && raw.parentID.trim()) return null;
  if (!isLynxArchivedByTime(raw)) return null;
  const titleRaw = typeof raw.title === 'string' ? raw.title.trim() : '';
  return {
    id,
    title: titleRaw || options?.untitledLabel || 'Untitled',
    directory: resolveDirectory(raw),
    activityAt: getLynxArchivedSessionActivityMs(raw),
    archivedAt: toFinite(raw.time?.archived),
  };
};

export const buildLynxArchivedSessionsModel = (options: {
  sessions: readonly LynxArchivedSessionRow[];
  snapshot?: SessionIndexSnapshot | null;
  projectLabels?: Record<string, string>;
  otherLabel: string;
}): LynxArchivedSessionsModel => {
  const labelByPath = new Map<string, string>();
  for (const [path, label] of Object.entries(options.projectLabels ?? {})) {
    const normalized = normalizePath(path);
    if (normalized && label.trim()) labelByPath.set(normalized, label.trim());
  }
  if (options.snapshot) {
    for (const directory of options.snapshot.directories) {
      const path = normalizePath(directory.directory);
      if (!path || labelByPath.has(path)) continue;
      labelByPath.set(path, getProjectLabel(path));
    }
  }

  const byProject = new Map<string, LynxArchivedSessionRow[]>();
  for (const session of options.sessions) {
    const key = session.directory ?? LYNX_ARCHIVED_OTHER_PROJECT_ID;
    const list = byProject.get(key) ?? [];
    list.push(session);
    byProject.set(key, list);
  }

  const buckets: LynxArchivedProjectBucket[] = [];
  for (const [projectId, sessions] of byProject) {
    const sorted = [...sessions].sort((a, b) => b.activityAt - a.activityAt);
    if (projectId === LYNX_ARCHIVED_OTHER_PROJECT_ID) {
      buckets.push({
        projectId,
        label: options.otherLabel,
        path: null,
        sessions: sorted,
      });
      continue;
    }
    buckets.push({
      projectId,
      label: labelByPath.get(projectId) ?? getProjectLabel(projectId),
      path: projectId,
      sessions: sorted,
    });
  }

  buckets.sort((a, b) => {
    if (a.projectId === LYNX_ARCHIVED_OTHER_PROJECT_ID) return 1;
    if (b.projectId === LYNX_ARCHIVED_OTHER_PROJECT_ID) return -1;
    const byCount = b.sessions.length - a.sessions.length;
    if (byCount !== 0) return byCount;
    return a.label.localeCompare(b.label);
  });

  const total = options.sessions.length;
  return { buckets, total, empty: total === 0 };
};

const readNextCursor = (response: unknown, page: RawArchivedSession[]): number | undefined => {
  const headers = response && typeof response === 'object' && 'headers' in response
    ? (response as { headers?: unknown }).headers
    : undefined;
  if (headers && typeof headers === 'object') {
    const maybeGet = headers as { get?: (name: string) => string | null };
    if (typeof maybeGet.get === 'function') {
      const raw = maybeGet.get('x-next-cursor') ?? maybeGet.get('X-Next-Cursor');
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) return parsed;
    }
    const record = headers as Record<string, unknown>;
    const direct = record['x-next-cursor'] ?? record['X-Next-Cursor'];
    if (typeof direct === 'string' || typeof direct === 'number') {
      const parsed = Number(direct);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const lastUpdated = page[page.length - 1]?.time?.updated;
  return typeof lastUpdated === 'number' && Number.isFinite(lastUpdated) ? lastUpdated : undefined;
};

/**
 * Cap `listGlobalSessionPages({ archived: true, roots: true })` via OpenChamber
 * `GET /api/experimental/session`. Failure ≠ empty success.
 */
export async function listLynxArchivedSessions(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: {
    directory?: string | null;
    untitledLabel?: string;
    pageSize?: number;
    maxItems?: number;
    signal?: AbortSignal;
  },
): Promise<LynxArchivedSessionListResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const pageSize = options?.pageSize ?? LYNX_ARCHIVED_SESSIONS_PAGE_SIZE;
  const maxItems = options?.maxItems ?? 2_000;
  const sessions: LynxArchivedSessionRow[] = [];
  const seen = new Set<string>();
  let cursor: number | undefined;

  try {
    while (sessions.length < maxItems) {
      const limit = Math.min(pageSize, maxItems - sessions.length);
      const params = new URLSearchParams();
      params.set('archived', 'true');
      params.set('roots', 'true');
      params.set('limit', String(limit));
      if (options?.directory?.trim()) {
        params.set('directory', options.directory.trim());
      }
      if (cursor !== undefined) params.set('cursor', String(cursor));

      const response = await runtimeFetch(`/api/experimental/session?${params.toString()}`, {
        method: 'GET',
        signal: options?.signal,
      });
      if (response.status === 0) return { status: 'no-runtime' };
      if (!response.ok) {
        return {
          status: 'failed',
          error: `session.list archived failed (${response.status})`,
          httpStatus: response.status,
        };
      }

      const payload = await response.json().catch(() => null);
      const page = Array.isArray(payload)
        ? payload as RawArchivedSession[]
        : (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: RawArchivedSession[] }).data
          : null);
      if (!page) {
        return {
          status: 'failed',
          error: 'session.list archived returned non-array',
          httpStatus: response.status,
        };
      }
      if (page.length === 0) break;

      for (const raw of page) {
        const row = parseLynxArchivedSessionRow(raw, { untitledLabel: options?.untitledLabel });
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        sessions.push(row);
      }

      if (page.length < limit) break;
      const nextCursor = readNextCursor(response, page);
      if (nextCursor === undefined) break;
      if (cursor !== undefined && nextCursor >= cursor) break;
      cursor = nextCursor;
    }

    sessions.sort((a, b) => b.activityAt - a.activityAt);
    return { status: 'ok', sessions };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export const formatLynxArchivedSessionCount = (
  count: number,
  singular: string,
  plural: string,
): string => `${count} ${count === 1 ? singular : plural}`;

export const LYNX_ARCHIVED_SESSIONS_NOTES = [
  'Cap ArchivedSessionsDialog: project buckets → session list → restore/preview.',
  'List: GET /api/experimental/session?archived=true&roots=true (Cap experimental.session.list).',
  'Session-index omits archived roots — used only for project labels when present.',
  'Restore: unarchiveLynxSession → PATCH { time: { archived: 0 } }; never fake-success.',
  'Deferred: bulk multi-select, Cap toast lib, @dnd-kit, MobileWindowMotion, iPad.',
] as const;
