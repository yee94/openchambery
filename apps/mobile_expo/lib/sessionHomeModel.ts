import type { SessionIndexSession, SessionIndexSnapshot } from '@/lib/sessionIndex';

export type HomeSessionRow = {
  id: string;
  title: string;
  subtitle: string;
  directory: string;
  activityMs: number;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  parentID: string | null;
  branch?: string | null;
};

export type HomeDirectoryGroup = {
  directory: string;
  label: string;
  sessions: HomeSessionRow[];
};

export type SessionHomeModel = {
  pinned: HomeSessionRow[];
  inProgress: HomeSessionRow[];
  directories: HomeDirectoryGroup[];
  /** Flat catalog for search (all non-archived top-level rows). */
  catalog: HomeSessionRow[];
};

export const DRAFT_ROUTE_ID = 'draft';

/** Cap `formatHomeSessionSubtitle` — `项目 · 分支` when branch is present. */
export const formatHomeSessionSubtitle = (
  projectLabel: string,
  branch?: string | null,
): string => {
  const trimmedBranch = branch?.trim();
  return trimmedBranch ? `${projectLabel} · ${trimmedBranch}` : projectLabel;
};

export const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

export const projectLabelFromDirectory = (directory: string): string => {
  const normalized = normalizePath(directory);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

const toMs = (raw: number | string | null | undefined): number => {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export const getSessionActivityMs = (session: SessionIndexSession): number => {
  const updated = toMs(session.time?.updated);
  if (updated > 0) return updated;
  return toMs(session.time?.created);
};

export const isSessionArchived = (session: SessionIndexSession): boolean => {
  const archived = toMs(session.time?.archived);
  return archived > 0;
};

export const getSessionDirectory = (session: SessionIndexSession, fallback = ''): string =>
  normalizePath(session.directory ?? session.project?.worktree ?? fallback);

export const derivePinnedSessionIds = (snapshot: SessionIndexSnapshot): Set<string> => {
  if (snapshot.pinnedSessionIds && snapshot.pinnedSessionIds.length > 0) {
    return new Set(snapshot.pinnedSessionIds);
  }
  const fromRows = new Set<string>();
  for (const dir of snapshot.directories) {
    for (const session of dir.sessions) {
      const pinned = session.time?.pinned;
      if (pinned != null && pinned !== '' && pinned !== 0) {
        fromRows.add(session.id);
      }
    }
  }
  return fromRows;
};

export const derivePinnedSessions = <T extends { id: string }>(
  sessions: T[],
  pinnedSessionIds: ReadonlySet<string>,
): T[] => sessions.filter((session) => pinnedSessionIds.has(session.id));

/**
 * Non-pinned home-attention rows: live busy/retry + top-level unread.
 * Matches Cap `listInProgressHomeSessions` (no plan/notes/Todo rebuild).
 */
export const listInProgressHomeSessions = <T extends { id: string; parentID?: string | null }>(
  sessions: T[],
  pinnedSessionIds: ReadonlySet<string>,
  runningSessionIds: ReadonlySet<string>,
  unseenBySession: Readonly<Record<string, number>>,
  isArchived: (session: T) => boolean,
): T[] => {
  const active: T[] = [];
  for (const session of sessions) {
    if (pinnedSessionIds.has(session.id) || isArchived(session)) continue;
    const running = runningSessionIds.has(session.id);
    const unread = (unseenBySession[session.id] ?? 0) > 0 && !session.parentID;
    if (!running && !unread) continue;
    active.push(session);
  }
  return active;
};

const matchesQuery = (query: string, ...values: (string | undefined)[]): boolean =>
  values.some((value) => value?.toLowerCase().includes(query));

/** Flat session/directory search over the loaded catalog (1.19.3-beta.1). */
export const filterHomeCatalogForSearch = (
  model: SessionHomeModel,
  rawQuery: string,
): {
  sessions: HomeSessionRow[];
  directories: HomeDirectoryGroup[];
} => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return { sessions: [], directories: model.directories };
  }

  const sessions = model.catalog.filter((session) =>
    matchesQuery(query, session.title, session.subtitle, session.id, session.directory),
  );

  const directories = model.directories.flatMap((group) => {
    if (matchesQuery(query, group.label, group.directory)) {
      return [{ ...group, sessions: group.sessions }];
    }
    const filtered = group.sessions.filter((session) =>
      matchesQuery(query, session.title, session.subtitle, session.id),
    );
    return filtered.length > 0 ? [{ ...group, sessions: filtered }] : [];
  });

  return { sessions, directories };
};

export type BuildSessionHomeOptions = {
  untitledLabel?: string;
  unseenBySession?: Readonly<Record<string, number>>;
  runningSessionIds?: ReadonlySet<string>;
  /** Optional branch override keyed by normalized directory. */
  branchByDirectory?: Readonly<Record<string, string | null | undefined>>;
};

export const buildSessionHomeModel = (
  snapshot: SessionIndexSnapshot,
  options: BuildSessionHomeOptions = {},
): SessionHomeModel => {
  const untitled = options.untitledLabel ?? 'Untitled';
  const unseenBySession = options.unseenBySession ?? {};
  const runningSessionIds = options.runningSessionIds ?? new Set<string>();
  const branchByDirectory = options.branchByDirectory ?? {};
  const pinnedIds = derivePinnedSessionIds(snapshot);

  const flat: (SessionIndexSession & { directory: string })[] = [];
  for (const dir of snapshot.directories) {
    const directory = normalizePath(dir.directory);
    for (const session of dir.sessions) {
      flat.push({
        ...session,
        directory: getSessionDirectory(session, directory),
      });
    }
  }

  const toRow = (session: SessionIndexSession & { directory: string }, pinned: boolean): HomeSessionRow => {
    const directory = session.directory;
    const projectLabel = projectLabelFromDirectory(directory) || directory || untitled;
    const branch =
      branchByDirectory[directory] ??
      session.project?.branch ??
      null;
    const parentID = session.parentID ?? null;
    const unread = (unseenBySession[session.id] ?? 0) > 0 && !parentID;
    return {
      id: session.id,
      title: session.title?.trim() || untitled,
      subtitle: formatHomeSessionSubtitle(projectLabel, branch),
      directory,
      activityMs: getSessionActivityMs(session),
      pinned,
      unread,
      archived: isSessionArchived(session),
      parentID,
      branch,
    };
  };

  const topLevel = flat.filter((session) => !session.parentID && !isSessionArchived(session));

  const pinned = derivePinnedSessions(topLevel, pinnedIds)
    .map((session) => toRow(session, true))
    .sort((a, b) => b.activityMs - a.activityMs);

  const inProgress = listInProgressHomeSessions(
    topLevel,
    pinnedIds,
    runningSessionIds,
    unseenBySession,
    isSessionArchived,
  )
    .map((session) => toRow(session, false))
    .sort((a, b) => b.activityMs - a.activityMs);

  const directoryGroups: HomeDirectoryGroup[] = snapshot.directories.map((dir) => {
    const directory = normalizePath(dir.directory);
    const label = projectLabelFromDirectory(directory) || directory;
    const sessions = dir.sessions
      .filter((session) => !session.parentID && !isSessionArchived(session) && !pinnedIds.has(session.id))
      .map((session) => toRow({ ...session, directory: getSessionDirectory(session, directory) }, false))
      .sort((a, b) => b.activityMs - a.activityMs);
    return { directory, label, sessions };
  });

  const catalog = topLevel.map((session) => toRow(session, pinnedIds.has(session.id)));

  return {
    pinned,
    inProgress,
    directories: directoryGroups,
    catalog,
  };
};

/** Route id for draft new session — Cap keeps sessionId == '' until first send. */
export const isDraftSessionRouteId = (sessionId: string | undefined | null): boolean => {
  if (sessionId == null) return true;
  const trimmed = sessionId.trim();
  return trimmed === '' || trimmed === DRAFT_ROUTE_ID;
};

export const resolveChatSessionId = (routeId: string | undefined | null): string =>
  isDraftSessionRouteId(routeId) ? '' : (routeId ?? '').trim();
