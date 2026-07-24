import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';
import { opencodeClient } from '@/lib/opencode/client';
import { isVisibleGlobalSession, listGlobalSessionPages } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';
import { resetOpenCodeReadiness, waitForOpenCodeReadiness } from '@/lib/runtime-readiness';
import {
  loadSessionIndexSnapshot,
  persistSessionIndexDirectory,
  persistSessionIndexDirectories,
  startSessionIndexBackgroundSync,
  waitForSessionIndexInvalidation,
  type SessionIndexSnapshot,
} from '@/lib/session-index-api';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
  archivedSessions: Session[];
};

type DirectorySessionPagination = {
  cursor: number | null;
  hasMore: boolean;
  loadingMore: boolean;
};

type SessionIndexSyncMetadata = {
  lastSyncedAt: number;
  lastFullSyncedAt: number;
};

type StartupSessionSyncProgress = {
  active: boolean;
  phase: 'idle' | 'restoring' | 'syncing' | 'committing';
  completed: number;
  total: number;
};

type GlobalSessionsState = {
  activeSessions: Session[];
  archivedSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  reviewTransferBySessionId: Map<string, ReviewTransferDirection>;
  /** Directories that have completed at least one successful per-directory refresh. */
  loadedDirectories: Set<string>;
  /** Directories with no usable active snapshot and an in-flight initial load. */
  loadingDirectories: Set<string>;
  /** Directories refreshing active sessions while an existing snapshot stays visible. */
  refreshingDirectories: Set<string>;
  /** Directories that have completed at least one archived-session refresh. */
  archivedLoadedDirectories: Set<string>;
  /** Directories with an in-flight archived-session refresh. */
  archivedLoadingDirectories: Set<string>;
  activePaginationByDirectory: Map<string, DirectorySessionPagination>;
  /** Directories restored from Electron's persistent session-summary index. */
  cachedDirectories: Set<string>;
  /** True after the Electron session-index read has completed or deterministically declined. */
  hasHydratedSessionIndex: boolean;
  /** True when the initial SQLite restore supplied a known directory for this runtime. */
  hasCachedSessionIndex: boolean;
  sessionIndexSyncByDirectory: Map<string, SessionIndexSyncMetadata>;
  /** True only after the unfiltered catalog used by retention has loaded successfully. */
  hasLoadedFullCatalog: boolean;
  /** IDs from the last complete active+archived catalog result. Bounded directory refreshes never replace this set. */
  fullCatalogSessionIds: Set<string>;
  /** Increments only when a complete catalog result replaces `fullCatalogSessionIds`. */
  fullCatalogGeneration: number;
  /** Session IDs hidden locally while a delayed delete can still be undone. */
  pendingDeletionIds: Set<string>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  /** Blocking session-index cold-start refresh progress for persisted directories. */
  startupSyncProgress: StartupSessionSyncProgress;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (
    directories: Iterable<string>,
    fallbackActive?: Session[],
    options?: {
      persist?: boolean;
      incrementalStart?: number;
      onDirectoryResult?: (directory: string, success: boolean) => void;
    },
  ) => Promise<LoadResult>;
  /** Queue a server-owned index refresh when available, with the SDK path as a runtime fallback. */
  syncSessionsForDirectories: (
    directories: Iterable<string>,
    fallbackActive?: Session[],
  ) => Promise<LoadResult>;
  refreshArchivedSessionsForDirectories: (directories: Iterable<string>) => Promise<LoadResult>;
  loadMoreSessionsForDirectory: (directory: string) => Promise<LoadResult>;
  hydrateSessionIndex: () => Promise<void>;
  startSessionIndexStartup: (directories: Iterable<string>) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], archivedSessions: Session[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: Session) => void;
  markSessionsPendingDeletion: (ids: Iterable<string>) => void;
  clearSessionsPendingDeletion: (ids: Iterable<string>) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  /** Drop every session from the previous runtime instance and go back to the
      unloaded state, so a fresh load runs against the new endpoint. */
  resetForRuntimeSwitch: () => void;
};

const PAGE_SIZE = 500;
/** The sidebar only needs the newest sessions for each directory. */
const DIRECTORY_SESSION_LIMIT = 20;
// Three attempts plus 500ms/1s backoff keep the total directory budget near 10s.
const DIRECTORY_SESSION_TIMEOUT_MS = 6_000;
/** The eighth runtime slot stays free for interactive session/message reads. */
const DIRECTORY_FETCH_CONCURRENCY_MAX = 7;
const DIRECTORY_FETCH_CONCURRENCY_MID = 3;
const DIRECTORY_FETCH_CONCURRENCY_MIN = 1;
const DIRECTORY_RECOVERY_SUCCESS_THRESHOLD = 2;
const STARTUP_RETRY_DELAY_MS = 750;

let inflightLoad: Promise<LoadResult> | null = null;
// Bumped on runtime switch: an in-flight load from the previous instance must
// not apply its (stale) snapshot after the reset.
let loadGeneration = 0;
/** Coalesce overlapping refreshes by directory, regardless of which caller supplied the set. */
const inflightActiveDirectoryRefresh = new Map<string, Promise<boolean>>();
const inflightArchivedDirectoryRefresh = new Map<string, Promise<boolean>>();
const inflightActiveDirectoryLoadMore = new Map<string, Promise<boolean>>();
const directoryTaskQueue: Array<() => void> = [];
const directoryAbortControllers = new Set<AbortController>();
let runningDirectoryTasks = 0;
// Directory requests initialize project config and plugins in OpenCode. Start
// conservatively, then use successful completions to recover toward the cap.
let directoryFetchConcurrency = DIRECTORY_FETCH_CONCURRENCY_MID;
let consecutiveDirectorySuccesses = 0;
let sessionIndexPollController: AbortController | null = null;

type SessionIndexRuntimeCapture = {
  loadGeneration: number;
  runtimeGeneration: number;
  transportIdentity: string;
};

const captureSessionIndexRuntime = (): SessionIndexRuntimeCapture => ({
  loadGeneration,
  runtimeGeneration: getRuntimeGeneration(),
  transportIdentity: getRuntimeTransportIdentity(),
});

const isCurrentSessionIndexRuntime = (capture: SessionIndexRuntimeCapture): boolean => (
  capture.loadGeneration === loadGeneration
  && capture.runtimeGeneration === getRuntimeGeneration()
  && capture.transportIdentity === getRuntimeTransportIdentity()
);

const isDirectoryOverloaded = (error: unknown): boolean => {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429 || status === 502 || status === 503) return true;
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes('signal timed out') || message.includes('timeout');
};

const recordDirectoryFailure = (error: unknown): void => {
  consecutiveDirectorySuccesses = 0;
  if (!isDirectoryOverloaded(error)) return;
  directoryFetchConcurrency = directoryFetchConcurrency > DIRECTORY_FETCH_CONCURRENCY_MID
    ? DIRECTORY_FETCH_CONCURRENCY_MID
    : DIRECTORY_FETCH_CONCURRENCY_MIN;
};

const recordDirectorySuccess = (): void => {
  consecutiveDirectorySuccesses += 1;
  if (
    consecutiveDirectorySuccesses < DIRECTORY_RECOVERY_SUCCESS_THRESHOLD
    || directoryFetchConcurrency >= DIRECTORY_FETCH_CONCURRENCY_MAX
  ) return;
  directoryFetchConcurrency += 1;
  consecutiveDirectorySuccesses = 0;
};

const drainDirectoryTaskQueue = (): void => {
  while (runningDirectoryTasks < directoryFetchConcurrency && directoryTaskQueue.length > 0) {
    const start = directoryTaskQueue.shift();
    if (!start) return;
    runningDirectoryTasks += 1;
    start();
  }
};

const scheduleDirectoryTask = <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  directoryTaskQueue.push(() => {
    void task().then(resolve, reject).finally(() => {
      runningDirectoryTasks -= 1;
      drainDirectoryTaskQueue();
    });
  });
  drainDirectoryTaskQueue();
});

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

export const mergeSessionDirectoryMetadata = (incoming: Session, existing?: Session | null): Session => {
  if (!existing) {
    return incoming;
  }

  const incomingRecord = incoming as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };
  const existingRecord = existing as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };

  const incomingDirectory = normalizePath(incomingRecord.directory ?? null);
  const incomingWorktree = normalizePath(incomingRecord.project?.worktree ?? null);
  const existingDirectory = normalizePath(existingRecord.directory ?? null);
  const existingWorktree = normalizePath(existingRecord.project?.worktree ?? null);

  let changed = false;
  const next: typeof incomingRecord = { ...incomingRecord };

  // Some live session updates omit stable raw directory metadata; keep the
  // cached value so project grouping does not temporarily lose the session.
  if (!incomingDirectory && existingDirectory) {
    next.directory = existingRecord.directory;
    changed = true;
  }

  if (!incomingWorktree && existingWorktree) {
    next.project = {
      ...(existingRecord.project ?? {}),
      ...(incomingRecord.project ?? {}),
      worktree: existingRecord.project?.worktree,
    };
    changed = true;
  } else if (!incomingRecord.project && existingRecord.project) {
    next.project = existingRecord.project;
    changed = true;
  }

  const incomingHasChildren = (incomingRecord as { hasChildren?: unknown }).hasChildren;
  const existingHasChildren = (existingRecord as { hasChildren?: unknown }).hasChildren;
  if (typeof incomingHasChildren !== 'boolean' && typeof existingHasChildren === 'boolean') {
    (next as typeof next & { hasChildren?: boolean }).hasChildren = existingHasChildren;
    changed = true;
  }

  const existingActivityUpdatedAt = getSessionActivityUpdatedAt(existing);
  const incomingActivityUpdatedAt = getSessionActivityUpdatedAt(incoming);
  if (existingActivityUpdatedAt > incomingActivityUpdatedAt) {
    const incomingMetadata = incomingRecord.metadata && typeof incomingRecord.metadata === 'object'
      ? incomingRecord.metadata as Record<string, unknown>
      : {};
    const incomingOpenChamber = incomingMetadata.openchamber && typeof incomingMetadata.openchamber === 'object'
      ? incomingMetadata.openchamber as Record<string, unknown>
      : {};
    const incomingTitleRefresh = incomingOpenChamber.titleRefresh && typeof incomingOpenChamber.titleRefresh === 'object'
      ? incomingOpenChamber.titleRefresh as Record<string, unknown>
      : {};
    next.metadata = {
      ...incomingMetadata,
      openchamber: {
        ...incomingOpenChamber,
        titleRefresh: {
          ...incomingTitleRefresh,
          activityUpdatedAt: existingActivityUpdatedAt,
        },
      },
    };
    changed = true;
  }

  return changed ? next : incoming;
};

export const mergeLiveSessionWithGlobalSession = (
  liveSession: Session,
  globalSession: Session,
): Session => {
  const merged = mergeSessionDirectoryMetadata(liveSession, globalSession);
  if (merged.share !== globalSession.share) {
    return { ...merged, share: globalSession.share };
  }
  return merged;
};

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
  const next = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const existing = next.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    next.set(directory, [session]);
  }
  return next;
};

const getSessionSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    String((session as Session & { hasChildren?: boolean }).hasChildren ?? false),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

const sameSessionList = (prev: Session[], next: Session[]): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
      return false;
    }
  }
  return true;
};

const filterPendingDeletionSessions = (sessions: Session[], pendingDeletionIds: ReadonlySet<string>): Session[] => {
  if (pendingDeletionIds.size === 0) return sessions;
  const firstPendingIndex = sessions.findIndex((session) => pendingDeletionIds.has(session.id));
  if (firstPendingIndex === -1) return sessions;
  return sessions.filter((session, index) => index !== firstPendingIndex && !pendingDeletionIds.has(session.id));
};

const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
  return [...sessions].sort((left, right) => {
    const timeDelta = getSessionActivityUpdatedAt(right) - getSessionActivityUpdatedAt(left);
    if (timeDelta !== 0) return timeDelta;
    return right.id.localeCompare(left.id);
  });
};

const normalizeDirectorySet = (directories: Iterable<string>): Set<string> => {
  const next = new Set<string>();
  for (const directory of directories) {
    const normalized = normalizePath(directory);
    if (normalized) next.add(normalized);
  }
  return next;
};

const getNextSessionCursor = (sessions: Session[]): number | null => {
  const updatedAt = sessions[sessions.length - 1]?.time?.updated;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null;
};

const getPaginationAfterPage = (
  sessions: Session[],
  previousCursor?: number | null,
): DirectorySessionPagination => {
  const cursor = getNextSessionCursor(sessions);
  return {
    cursor,
    hasMore: sessions.length === DIRECTORY_SESSION_LIMIT
      && cursor !== null
      && (previousCursor === undefined || previousCursor === null || cursor < previousCursor),
    loadingMore: false,
  };
};

const replaceSessionsForDirectories = (
  existing: Session[],
  incoming: Session[],
  directories: Set<string>,
): Session[] => {
  if (directories.size === 0) {
    return existing;
  }

  const existingById = new Map(existing.map((session) => [session.id, session]));
  const incomingById = new Map<string, Session>();

  for (const session of incoming) {
    if (!session?.id) continue;
    incomingById.set(session.id, mergeSessionDirectoryMetadata(session, existingById.get(session.id)));
  }

  const kept = existing.filter((session) => {
    if (incomingById.has(session.id)) return false;
    const directory = resolveGlobalSessionDirectory(session);
    return !directory || !directories.has(directory);
  });

  return sortSessionsByUpdated([...incomingById.values(), ...kept]);
};

/** True when client pagination already advanced past the snapshot head-window cursor. */
const isDeeperPagination = (
  existing: DirectorySessionPagination,
  incoming: { cursor: number | null; hasMore: boolean },
): boolean => {
  if (existing.cursor === null) {
    // Exhausted list (or terminal page) is deeper than a head window that still pages.
    return !existing.hasMore && (incoming.hasMore || incoming.cursor !== null);
  }
  if (incoming.cursor === null) return true;
  return existing.cursor < incoming.cursor;
};

/**
 * Activity-time edge of the authoritative head window.
 * Prefer the page cursor (list "updated strictly before"); fall back to the
 * oldest session still present in the head page when cursor is null.
 * Sessions with activity time <= this edge and not in the head page are past
 * the window (including items newly bumped out that still share the edge time).
 */
const getAuthoritativeHeadBoundaryUpdatedAt = (
  sessions: Session[],
  cursor: number | null,
): number | null => {
  if (typeof cursor === 'number' && Number.isFinite(cursor)) {
    return cursor;
  }
  if (sessions.length === 0) return null;
  const sorted = sortSessionsByUpdated(sessions);
  const oldest = sorted[sorted.length - 1];
  if (!oldest) return null;
  return getSessionActivityUpdatedAt(oldest);
};

/** True when activity time is at or past the head edge (loadMore / bumped-out territory). */
const isSessionBeyondHeadBoundary = (
  session: Session,
  boundaryUpdatedAt: number,
): boolean => getSessionActivityUpdatedAt(session) <= boundaryUpdatedAt;

/**
 * Authoritative index snapshots only cover the newest head window per directory.
 * When loadMore has already appended deeper pages and the snapshot still has more
 * pages (`hasMore`), keep loaded sessions that clearly fall after the new head
 * boundary (cursor/time), and drop head-window ghosts missing from the snapshot.
 * A complete authoritative page (`hasMore: false`, including empty directories) replaces
 * the directory list and does not preserve a stale loadMore tail.
 */
const replaceSessionsForDirectoriesPreservingLoadedTail = (
  existing: Session[],
  incomingByDirectory: Map<string, Session[]>,
  directories: Set<string>,
  headBoundaryByDirectory: Map<string, number | null>,
  preserveTailDirectories: Set<string>,
): Session[] => {
  if (directories.size === 0) {
    return existing;
  }

  const existingById = new Map(existing.map((session) => [session.id, session]));
  const incomingById = new Map<string, Session>();
  for (const sessions of incomingByDirectory.values()) {
    for (const session of sessions) {
      if (!session?.id) continue;
      incomingById.set(session.id, mergeSessionDirectoryMetadata(session, existingById.get(session.id)));
    }
  }

  const kept = existing.filter((session) => {
    if (incomingById.has(session.id)) return false;
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory || !directories.has(directory)) return true;
    if (!preserveTailDirectories.has(directory)) return false;
    const boundary = headBoundaryByDirectory.get(directory);
    if (boundary === undefined || boundary === null) return false;
    return isSessionBeyondHeadBoundary(session, boundary);
  });

  return sortSessionsByUpdated([...incomingById.values(), ...kept]);
};

const applySessionIndexSnapshotState = (
  state: GlobalSessionsState,
  snapshot: SessionIndexSnapshot,
  authoritative: boolean,
): Partial<GlobalSessionsState> => {
  const snapshotDirectories = new Set(snapshot.directories.map((entry) => entry.directory));
  const cachedByDirectory = new Map<string, Session[]>();
  for (const entry of snapshot.directories) {
    cachedByDirectory.set(
      entry.directory,
      filterPendingDeletionSessions(entry.sessions, state.pendingDeletionIds),
    );
  }
  const cachedSessions = [...cachedByDirectory.values()].flat();
  const existingCountByDirectory = new Map<string, number>();
  if (authoritative) {
    for (const session of state.activeSessions) {
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory || !snapshotDirectories.has(directory)) continue;
      existingCountByDirectory.set(directory, (existingCountByDirectory.get(directory) ?? 0) + 1);
    }
  }
  const headBoundaryByDirectory = new Map<string, number | null>();
  const preserveTailDirectories = new Set<string>();
  if (authoritative) {
    for (const entry of snapshot.directories) {
      const incomingPagination = { cursor: entry.cursor, hasMore: entry.hasMore };
      const existingPagination = state.activePaginationByDirectory.get(entry.directory);
      const hasLoadedBeyondHead = (existingCountByDirectory.get(entry.directory) ?? 0) > DIRECTORY_SESSION_LIMIT;
      const preserveTail = Boolean(
        entry.hasMore
        && hasLoadedBeyondHead
        && existingPagination
        && isDeeperPagination(existingPagination, incomingPagination),
      );
      if (preserveTail) preserveTailDirectories.add(entry.directory);
      headBoundaryByDirectory.set(
        entry.directory,
        getAuthoritativeHeadBoundaryUpdatedAt(cachedByDirectory.get(entry.directory) ?? [], entry.cursor),
      );
    }
  }
  const activeSessions = authoritative
    ? replaceSessionsForDirectoriesPreservingLoadedTail(
      state.activeSessions,
      cachedByDirectory,
      snapshotDirectories,
      headBoundaryByDirectory,
      preserveTailDirectories,
    )
    : sortSessionsByUpdated(mergeSessionLists(state.activeSessions, cachedSessions));
  const nextPagination = new Map(state.activePaginationByDirectory);
  const nextSyncMetadata = new Map(state.sessionIndexSyncByDirectory);
  for (const entry of snapshot.directories) {
    const incomingPagination = {
      cursor: entry.cursor,
      hasMore: entry.hasMore,
      loadingMore: false,
    };
    const existingPagination = state.activePaginationByDirectory.get(entry.directory);
    nextPagination.set(
      entry.directory,
      authoritative
        && preserveTailDirectories.has(entry.directory)
        && existingPagination
        ? { cursor: existingPagination.cursor, hasMore: existingPagination.hasMore, loadingMore: false }
        : incomingPagination,
    );
    nextSyncMetadata.set(entry.directory, {
      lastSyncedAt: entry.lastSyncedAt,
      lastFullSyncedAt: entry.lastFullSyncedAt,
    });
  }

  const nextLoaded = new Set(state.loadedDirectories);
  for (const directory of snapshotDirectories) nextLoaded.add(directory);
  const nextLoading = new Set(state.loadingDirectories);
  const nextRefreshing = new Set(state.refreshingDirectories);
  for (const directory of snapshot.sync.pendingDirectories) {
    if ((activeSessions.some((session) => resolveGlobalSessionDirectory(session) === directory))) {
      nextRefreshing.add(directory);
      nextLoading.delete(directory);
    } else {
      nextLoading.add(directory);
    }
  }
  for (const directory of [
    ...snapshot.sync.completedDirectories,
    ...snapshot.sync.failedDirectories,
  ]) {
    nextLoading.delete(directory);
    nextRefreshing.delete(directory);
  }

  return {
    activeSessions,
    sessionsByDirectory: buildSessionsByDirectory(activeSessions),
    reviewTransferBySessionId: buildReviewTransferMap(activeSessions),
    cachedDirectories: snapshotDirectories,
    sessionIndexSyncByDirectory: nextSyncMetadata,
    activePaginationByDirectory: nextPagination,
    loadedDirectories: nextLoaded,
    loadingDirectories: nextLoading,
    refreshingDirectories: nextRefreshing,
    hasLoaded: true,
    status: state.status === 'idle' || state.status === 'loading' ? 'ready' : state.status,
  };
};

const applyDirectoryRefreshPatch = (
  state: GlobalSessionsState,
  input: {
    activeSessions: Session[];
    archivedSessions?: Session[];
    directories: Set<string>;
    fallbackActive?: Session[];
    markReady: boolean;
    mergeOnly?: boolean;
  },
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  const incomingActiveSessions = filterPendingDeletionSessions(input.activeSessions, state.pendingDeletionIds);
  const fallbackActive = filterPendingDeletionSessions(input.fallbackActive ?? [], state.pendingDeletionIds);
  let nextActiveSessions = input.mergeOnly
    ? sortSessionsByUpdated(mergeSessionLists(state.activeSessions, incomingActiveSessions))
    : replaceSessionsForDirectories(
        state.activeSessions,
        incomingActiveSessions,
        input.directories,
      );
  nextActiveSessions = mergeSessionLists(nextActiveSessions, fallbackActive);
  if (sameSessionList(state.activeSessions, nextActiveSessions)) {
    nextActiveSessions = state.activeSessions;
  }

  const incomingArchivedSessions = input.archivedSessions === undefined
    ? undefined
    : filterPendingDeletionSessions(input.archivedSessions, state.pendingDeletionIds);
  let nextArchivedSessions = incomingArchivedSessions === undefined
    ? state.archivedSessions
    : replaceSessionsForDirectories(
        state.archivedSessions,
        incomingArchivedSessions,
        input.directories,
      );
  if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
    nextArchivedSessions = state.archivedSessions;
  }

  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);

  let nextLoadedDirectories = state.loadedDirectories;
  let loadedChanged = false;
  for (const directory of input.directories) {
    if (!nextLoadedDirectories.has(directory)) {
      if (!loadedChanged) {
        nextLoadedDirectories = new Set(state.loadedDirectories);
        loadedChanged = true;
      }
      nextLoadedDirectories.add(directory);
    }
  }

  let nextLoadingDirectories = state.loadingDirectories;
  let loadingChanged = false;
  for (const directory of input.directories) {
    if (nextLoadingDirectories.has(directory)) {
      if (!loadingChanged) {
        nextLoadingDirectories = new Set(state.loadingDirectories);
        loadingChanged = true;
      }
      nextLoadingDirectories.delete(directory);
    }
  }

  const nextStatus = input.markReady ? 'ready' as const : state.status;
  const nextHasLoaded = input.markReady ? true : state.hasLoaded;

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && nextLoadedDirectories === state.loadedDirectories
    && nextLoadingDirectories === state.loadingDirectories
    && state.status === nextStatus
    && state.hasLoaded === nextHasLoaded
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    reviewTransferBySessionId: nextActiveSessions === state.activeSessions
      ? state.reviewTransferBySessionId
      : buildReviewTransferMap(nextActiveSessions),
    loadedDirectories: nextLoadedDirectories,
    loadingDirectories: nextLoadingDirectories,
    hasLoaded: nextHasLoaded,
    status: nextStatus,
  };
};

const upsertSessionIntoList = (sessions: Session[], session: Session): Session[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  const mergedSession = mergeSessionDirectoryMetadata(session, sessions[index]);
  if (getSessionSignature(sessions[index]) === getSessionSignature(mergedSession)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = mergedSession;
  return next;
};

const mergeSessionLists = (existing: Session[], incoming?: Session[]): Session[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, mergeSessionDirectoryMetadata(session, byId.get(session.id)));
  });

  const ordered: Session[] = [];
  const seen = new Set<string>();

  existing.forEach((session) => {
    const next = byId.get(session.id);
    if (!next) {
      return;
    }
    ordered.push(next);
    seen.add(session.id);
  });

  incoming.forEach((session) => {
    if (seen.has(session.id)) {
      return;
    }
    const next = byId.get(session.id);
    if (next) {
      ordered.push(next);
      seen.add(session.id);
    }
  });

  return ordered;
};

const applySnapshot = (
  state: GlobalSessionsState,
  activeSessions: Session[],
  archivedSessions: Session[],
  status: GlobalSessionsStatus,
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  const filteredActiveSessions = filterPendingDeletionSessions(activeSessions, state.pendingDeletionIds);
  const filteredArchivedSessions = filterPendingDeletionSessions(archivedSessions, state.pendingDeletionIds);
  const nextActiveSessions = sameSessionList(state.activeSessions, filteredActiveSessions)
    ? state.activeSessions
    : filteredActiveSessions;
  const nextArchivedSessions = sameSessionList(state.archivedSessions, filteredArchivedSessions)
    ? state.archivedSessions
    : filteredArchivedSessions;
  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);
  const nextReviewTransferMap = nextActiveSessions === state.activeSessions
    ? state.reviewTransferBySessionId
    : buildReviewTransferMap(nextActiveSessions);

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && nextReviewTransferMap === state.reviewTransferBySessionId
    && state.hasLoaded
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    reviewTransferBySessionId: nextReviewTransferMap,
    hasLoaded: true,
    status,
  };
};

const buildReviewTransferMap = (sessions: Session[]): Map<string, ReviewTransferDirection> => {
  const next = new Map<string, ReviewTransferDirection>()
  const activeIds = new Set(sessions.map((s) => s.id))
  for (const session of sessions) {
    const direction = getReviewTransferDirection(session)
    if (!direction) continue
    const targetSessionId = direction === 'review-to-original'
      ? getOriginalSessionID(session)
      : getReviewSessionID(session)
    if (!targetSessionId || !activeIds.has(targetSessionId)) continue
    next.set(session.id, direction)
  }
  return next
}

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: [],
  archivedSessions: [],
  sessionsByDirectory: new Map(),
  reviewTransferBySessionId: new Map(),
  loadedDirectories: new Set(),
  loadingDirectories: new Set(),
  refreshingDirectories: new Set(),
  archivedLoadedDirectories: new Set(),
  archivedLoadingDirectories: new Set(),
  activePaginationByDirectory: new Map(),
  cachedDirectories: new Set(),
  hasHydratedSessionIndex: false,
  hasCachedSessionIndex: false,
  sessionIndexSyncByDirectory: new Map(),
  hasLoadedFullCatalog: false,
  fullCatalogSessionIds: new Set(),
  fullCatalogGeneration: 0,
  pendingDeletionIds: new Set(),
  hasLoaded: false,
  status: 'idle',
  startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 },

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  resetForRuntimeSwitch: () => {
    loadGeneration += 1;
    resetOpenCodeReadiness();
    inflightLoad = null;
    inflightActiveDirectoryRefresh.clear();
    inflightArchivedDirectoryRefresh.clear();
    inflightActiveDirectoryLoadMore.clear();
    directoryAbortControllers.forEach((controller) => controller.abort());
    directoryAbortControllers.clear();
    directoryFetchConcurrency = DIRECTORY_FETCH_CONCURRENCY_MID;
    consecutiveDirectorySuccesses = 0;
    sessionIndexPollController?.abort();
    sessionIndexPollController = null;
    set({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      loadedDirectories: new Set(),
      loadingDirectories: new Set(),
      refreshingDirectories: new Set(),
      archivedLoadedDirectories: new Set(),
      archivedLoadingDirectories: new Set(),
      activePaginationByDirectory: new Map(),
      cachedDirectories: new Set(),
      hasHydratedSessionIndex: false,
      hasCachedSessionIndex: false,
      sessionIndexSyncByDirectory: new Map(),
      hasLoadedFullCatalog: false,
      fullCatalogSessionIds: new Set(),
      fullCatalogGeneration: 0,
      pendingDeletionIds: new Set(),
      hasLoaded: false,
      status: 'idle',
      startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 },
    });
  },

  hydrateSessionIndex: async () => {
    const runtime = captureSessionIndexRuntime();
    try {
      const snapshot = await loadSessionIndexSnapshot();
      if (!isCurrentSessionIndexRuntime(runtime)) return;
      if (!snapshot) return;
      set((state) => ({
        ...applySessionIndexSnapshotState(state, snapshot, false),
        hasCachedSessionIndex: snapshot.directories.length > 0,
      }));
    } catch (error) {
      // The index is an acceleration cache. A failed read must not block the
      // authoritative OpenCode session flow.
      console.warn('[GlobalSessions] Failed to hydrate runtime session index:', error);
    } finally {
      if (isCurrentSessionIndexRuntime(runtime)) {
        set((state) => state.hasHydratedSessionIndex ? state : { hasHydratedSessionIndex: true });
      }
    }
  },

  startSessionIndexStartup: async (directories) => {
    const runtime = captureSessionIndexRuntime();
    set({ startupSyncProgress: { active: true, phase: 'restoring', completed: 0, total: 0 } });
    await get().hydrateSessionIndex();
    if (!isCurrentSessionIndexRuntime(runtime)) {
      return { activeSessions: [], archivedSessions: [] };
    }
    const directorySet = normalizeDirectorySet([
      ...directories,
      ...get().cachedDirectories,
    ]);
    if (directorySet.size === 0) {
      set({ startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 } });
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    const hasCachedSnapshot = get().hasCachedSessionIndex;
    const snapshot = { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
    let initial: SessionIndexSnapshot | null = null;
    const startRuntime = captureSessionIndexRuntime();
    try {
      initial = await startSessionIndexBackgroundSync([...directorySet]);
      if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(startRuntime)) {
        return { activeSessions: [], archivedSessions: [] };
      }
    } catch (error) {
      if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(startRuntime)) {
        return { activeSessions: [], archivedSessions: [] };
      }
      console.warn('[GlobalSessions] Failed to start server-side session index sync:', error);
    }

    // Web and VS Code explicitly return unsupported and keep their existing
    // SDK-backed path. Electron never falls through this branch.
    if (!initial) {
      const refresh = refreshStartupGlobalSessionsForDirectories(directorySet, snapshot.activeSessions, {
        retryFailed: !hasCachedSnapshot,
      });
      if (!hasCachedSnapshot) {
        await refresh;
        if (!isCurrentSessionIndexRuntime(runtime)) {
          return { activeSessions: [], archivedSessions: [] };
        }
      }
      else void refresh;
      return snapshot;
    }

    sessionIndexPollController?.abort();
    const controller = new AbortController();
    sessionIndexPollController = controller;
    const shouldBlock = !hasCachedSnapshot;
    const initialSnapshot = initial;
    if (!shouldBlock) {
      set({ startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 } });
    }
    let resolveRootSync: () => void = () => undefined;
    const rootSyncFinished = new Promise<void>((resolve) => {
      resolveRootSync = resolve;
    });
    let rootSyncSettled = false;
    const settleRootSync = () => {
      if (rootSyncSettled) return;
      rootSyncSettled = true;
      resolveRootSync();
    };
    const consume = async () => {
      let current = initialSnapshot;
      while (!controller.signal.aborted && isCurrentSessionIndexRuntime(runtime)) {
        set((state) => ({
          ...applySessionIndexSnapshotState(state, current, true),
          startupSyncProgress: shouldBlock
            ? {
                active: current.sync.active,
                phase: current.sync.active ? 'syncing' : 'idle',
                completed: current.sync.completed,
                total: current.sync.total,
              }
            : state.startupSyncProgress,
        }));
        if (!current.sync.active) settleRootSync();
        const waitRuntime = captureSessionIndexRuntime();
        const reason = await waitForSessionIndexInvalidation(current.revision, controller.signal);
        if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(waitRuntime)) break;
        if (reason === 'aborted') break;
        const loadRuntime = captureSessionIndexRuntime();
        const next = await loadSessionIndexSnapshot();
        if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(loadRuntime)) break;
        if (!next) break;
        current = next;
      }
    };
    const polling = consume().catch((error) => {
      if (!controller.signal.aborted) {
        console.warn('[GlobalSessions] Session index tip sync failed:', error);
      }
    }).finally(() => {
      settleRootSync();
      if (sessionIndexPollController === controller) sessionIndexPollController = null;
      if (shouldBlock && isCurrentSessionIndexRuntime(runtime)) {
        set((state) => ({
          startupSyncProgress: {
            active: false,
            phase: 'idle',
            completed: state.startupSyncProgress.completed,
            total: state.startupSyncProgress.total,
          },
        }));
      }
    });
    if (shouldBlock) {
      await rootSyncFinished;
      if (!isCurrentSessionIndexRuntime(runtime)) {
        return { activeSessions: [], archivedSessions: [] };
      }
    }
    else void polling;
    return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    set((state) => (state.status === 'loading' ? state : { status: 'loading' }));

    const generation = loadGeneration;
    const load = Promise.resolve().then(async () => {
      const current = get();

      try {
        await waitForOpenCodeReadiness();
        if (generation !== loadGeneration) {
          return { activeSessions: [], archivedSessions: [] };
        }
        const sdk = opencodeClient.getSdkClient();
        const [activeResult, archivedResult] = await Promise.allSettled([
          listGlobalSessionPages(sdk, { archived: false, pageSize: PAGE_SIZE }),
          listGlobalSessionPages(sdk, { archived: true, pageSize: PAGE_SIZE }),
        ]);

        const fallbackSnapshot = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextActiveSessions = activeResult.status === 'fulfilled'
          ? activeResult.value
          : fallbackSnapshot;
        const nextArchivedSessions = archivedResult.status === 'fulfilled'
          ? archivedResult.value
          : current.archivedSessions;

        if (activeResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load active sessions, preserving existing snapshot with fallback merge:', activeResult.reason);
        }
        if (archivedResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load archived sessions, preserving current snapshot:', archivedResult.reason);
        }

        if (generation !== loadGeneration) {
          // Runtime switched mid-load: this snapshot belongs to the previous
          // instance — drop it.
          return { activeSessions: [], archivedSessions: [] };
        }
        set((state) => {
          const status = activeResult.status === 'fulfilled' && archivedResult.status === 'fulfilled'
            ? 'ready'
            : 'error';
          const snapshot = applySnapshot(state, nextActiveSessions, nextArchivedSessions, status);
          const hasLoadedFullCatalog = activeResult.status === 'fulfilled' && archivedResult.status === 'fulfilled';
          if (!hasLoadedFullCatalog) {
            return snapshot === state ? state : snapshot;
          }
          const fullCatalogSessionIds = new Set([
            ...activeResult.value.map((session) => session.id),
            ...archivedResult.value.map((session) => session.id),
          ]);
          return {
            ...snapshot,
            hasLoadedFullCatalog: true,
            fullCatalogSessionIds,
            fullCatalogGeneration: state.fullCatalogGeneration + 1,
          };
        });
        return { activeSessions: nextActiveSessions, archivedSessions: nextArchivedSessions };
      } catch (error) {
        if (generation !== loadGeneration) {
          return { activeSessions: [], archivedSessions: [] };
        }
        const nextActiveSessions = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextArchivedSessions = current.archivedSessions;
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        set((state) => applySnapshot(state, nextActiveSessions, nextArchivedSessions, 'error'));
        return { activeSessions: nextActiveSessions, archivedSessions: nextArchivedSessions };
      } finally {
        if (inflightLoad === load) {
          inflightLoad = null;
        }
      }
    });
    inflightLoad = load;

    return load;
  },

  refreshSessionsForDirectories: async (directories, fallbackActive, options) => {
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      // Stay idle when the caller has no directories yet (currentDirectory /
      // projects still hydrating). The sidebar priority effect re-fires when
      // those arrive; flipping to ready here would strand an empty catalog.
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    const generation = loadGeneration;

    // Seed known live sessions before the request. Refresh results replace only
    // their own directory, so stale rows remain visible until authoritative data
    // for that directory arrives.
    set((state) => {
      const nextActiveSessions = mergeSessionLists(
        state.activeSessions,
        filterPendingDeletionSessions(fallbackActive ?? [], state.pendingDeletionIds),
      );
      const nextLoading = new Set(state.loadingDirectories);
      const nextRefreshing = new Set(state.refreshingDirectories);
      for (const directory of directorySet) {
        nextRefreshing.add(directory);
        const hasSnapshot = state.loadedDirectories.has(directory)
          || state.sessionsByDirectory.has(directory)
          || Boolean(fallbackActive?.some((session) => resolveGlobalSessionDirectory(session) === directory));
        if (!hasSnapshot) nextLoading.add(directory);
      }
      return {
        ...(nextActiveSessions === state.activeSessions ? {} : {
          activeSessions: nextActiveSessions,
          sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
          reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
        }),
        loadingDirectories: nextLoading,
        refreshingDirectories: nextRefreshing,
        status: state.status === 'idle' ? 'loading' : state.status,
      };
    });

    const tasks = [...directorySet].map((directory) => {
      const existing = inflightActiveDirectoryRefresh.get(directory);
      if (existing) return existing;

      const task = scheduleDirectoryTask(async (): Promise<boolean> => {
        const controller = new AbortController();
        directoryAbortControllers.add(controller);
        try {
          if (generation !== loadGeneration) return false;
          await waitForOpenCodeReadiness();
          if (generation !== loadGeneration) return false;
          const activeSessions = await listGlobalSessionPages(opencodeClient.getSdkClient(), {
            directory,
            archived: false,
            roots: true,
            ...(options?.incrementalStart !== undefined ? { start: options.incrementalStart } : {}),
            pageSize: DIRECTORY_SESSION_LIMIT,
            maxItems: DIRECTORY_SESSION_LIMIT,
            timeoutMs: DIRECTORY_SESSION_TIMEOUT_MS,
            retryAttempts: 2,
            signal: controller.signal,
          });
          if (generation !== loadGeneration) return false;
          set((state) => {
            const patch = applyDirectoryRefreshPatch(state, {
              activeSessions,
              directories: new Set([directory]),
              markReady: true,
              mergeOnly: options?.incrementalStart !== undefined,
            });
            const nextRefreshing = new Set(state.refreshingDirectories);
            const nextPagination = new Map(state.activePaginationByDirectory);
            nextRefreshing.delete(directory);
            if (options?.incrementalStart === undefined) {
              nextPagination.set(directory, getPaginationAfterPage(activeSessions));
            }
            return patch === state
              ? { refreshingDirectories: nextRefreshing, activePaginationByDirectory: nextPagination }
              : { ...patch, refreshingDirectories: nextRefreshing, activePaginationByDirectory: nextPagination };
          });
          if (options?.persist !== false) {
            const persistedSessions = get().sessionsByDirectory.get(directory) ?? [];
            const pagination = get().activePaginationByDirectory.get(directory)
              ?? getPaginationAfterPage(activeSessions);
            try {
              await persistSessionIndexDirectory({
                directory,
                sessions: persistedSessions,
                cursor: pagination.cursor,
                hasMore: pagination.hasMore,
                fullSync: options?.incrementalStart === undefined,
              });
            } catch (error) {
              // The OpenCode result remains authoritative for this run; a cache
              // write failure must not erase it or mark the directory empty.
              console.warn(`[GlobalSessions] Failed to persist session index for ${directory}:`, error);
            }
          }
          recordDirectorySuccess();
          return true;
        } catch (error) {
          recordDirectoryFailure(error);
          if (generation === loadGeneration) {
            console.warn(`[GlobalSessions] Failed to refresh active sessions for ${directory}:`, error);
            set((state) => {
              const nextLoading = new Set(state.loadingDirectories);
              const nextRefreshing = new Set(state.refreshingDirectories);
              nextLoading.delete(directory);
              nextRefreshing.delete(directory);
              return { loadingDirectories: nextLoading, refreshingDirectories: nextRefreshing };
            });
          }
          return false;
        } finally {
          directoryAbortControllers.delete(controller);
        }
      });
      inflightActiveDirectoryRefresh.set(directory, task);
      void task.finally(() => {
        if (inflightActiveDirectoryRefresh.get(directory) === task) {
          inflightActiveDirectoryRefresh.delete(directory);
        }
      });
      return task;
    });

    const results = await Promise.all(tasks);
    if (generation !== loadGeneration) return { activeSessions: [], archivedSessions: [] };
    [...directorySet].forEach((directory, index) => {
      options?.onDirectoryResult?.(directory, results[index] ?? false);
    });
    set((state) => ({
      status: state.status === 'loading'
        ? (results.some(Boolean) ? 'ready' : 'error')
        : state.status,
      hasLoaded: true,
    }));
    return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
  },

  syncSessionsForDirectories: async (directories, fallbackActive) => {
    const runtime = captureSessionIndexRuntime();
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    let snapshot: SessionIndexSnapshot | null = null;
    const startRuntime = captureSessionIndexRuntime();
    try {
      snapshot = await startSessionIndexBackgroundSync([...directorySet]);
      if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(startRuntime)) {
        return { activeSessions: [], archivedSessions: [] };
      }
    } catch (error) {
      if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(startRuntime)) {
        return { activeSessions: [], archivedSessions: [] };
      }
      console.warn('[GlobalSessions] Failed to start server-side session index sync:', error);
    }

    if (!snapshot) {
      return get().refreshSessionsForDirectories(directorySet, fallbackActive);
    }

    const controller = new AbortController();
    directoryAbortControllers.add(controller);
    try {
      let current = snapshot;
      while (!controller.signal.aborted && isCurrentSessionIndexRuntime(runtime)) {
        set((state) => applySessionIndexSnapshotState(state, current, true));
        if (!current.sync.active) break;
        const waitRuntime = captureSessionIndexRuntime();
        const reason = await waitForSessionIndexInvalidation(current.revision, controller.signal);
        if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(waitRuntime)) break;
        if (reason === 'aborted') break;
        const loadRuntime = captureSessionIndexRuntime();
        const next = await loadSessionIndexSnapshot();
        if (!isCurrentSessionIndexRuntime(runtime) || !isCurrentSessionIndexRuntime(loadRuntime)) break;
        if (!next) break;
        current = next;
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrentSessionIndexRuntime(runtime)) {
        console.warn('[GlobalSessions] Session index sync failed:', error);
      }
    } finally {
      directoryAbortControllers.delete(controller);
    }

    if (!isCurrentSessionIndexRuntime(runtime)) {
      return { activeSessions: [], archivedSessions: [] };
    }
    return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
  },

  loadMoreSessionsForDirectory: async (directoryInput) => {
    const directory = normalizePath(directoryInput);
    if (!directory) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    const existing = inflightActiveDirectoryLoadMore.get(directory);
    if (existing) {
      await existing;
      return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
    }
    const pagination = get().activePaginationByDirectory.get(directory);
    if (!pagination?.hasMore || pagination.cursor === null) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    const generation = loadGeneration;
    set((state) => {
      const nextPagination = new Map(state.activePaginationByDirectory);
      nextPagination.set(directory, { ...pagination, loadingMore: true });
      return { activePaginationByDirectory: nextPagination };
    });

    const task = scheduleDirectoryTask(async (): Promise<boolean> => {
      const controller = new AbortController();
      directoryAbortControllers.add(controller);
      try {
        await waitForOpenCodeReadiness();
        if (generation !== loadGeneration) return false;
        const page = await listGlobalSessionPages(opencodeClient.getSdkClient(), {
          directory,
          archived: false,
          roots: true,
          cursor: pagination.cursor ?? undefined,
          pageSize: DIRECTORY_SESSION_LIMIT,
          maxItems: DIRECTORY_SESSION_LIMIT,
          timeoutMs: DIRECTORY_SESSION_TIMEOUT_MS,
          retryAttempts: 2,
          signal: controller.signal,
        });
        if (generation !== loadGeneration) return false;
        set((state) => {
          const existingForDirectory = state.activeSessions.filter(
            (session) => resolveGlobalSessionDirectory(session) === directory,
          );
          const byId = new Map(existingForDirectory.map((session) => [session.id, session]));
          filterPendingDeletionSessions(page, state.pendingDeletionIds).forEach((session) => {
            byId.set(session.id, mergeSessionDirectoryMetadata(session, byId.get(session.id)));
          });
          const mergedDirectorySessions = sortSessionsByUpdated([...byId.values()]);
          const nextActiveSessions = replaceSessionsForDirectories(
            state.activeSessions,
            mergedDirectorySessions,
            new Set([directory]),
          );
          const nextPagination = new Map(state.activePaginationByDirectory);
          nextPagination.set(directory, getPaginationAfterPage(page, pagination.cursor));
          return {
            activeSessions: sameSessionList(state.activeSessions, nextActiveSessions)
              ? state.activeSessions
              : nextActiveSessions,
            sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
            reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
            activePaginationByDirectory: nextPagination,
          };
        });
        recordDirectorySuccess();
        return true;
      } catch (error) {
        recordDirectoryFailure(error);
        if (generation === loadGeneration) {
          console.warn(`[GlobalSessions] Failed to load more sessions for ${directory}:`, error);
          set((state) => {
            const current = state.activePaginationByDirectory.get(directory);
            if (!current) return state;
            const nextPagination = new Map(state.activePaginationByDirectory);
            nextPagination.set(directory, { ...current, loadingMore: false });
            return { activePaginationByDirectory: nextPagination };
          });
        }
        return false;
      } finally {
        directoryAbortControllers.delete(controller);
      }
    });
    inflightActiveDirectoryLoadMore.set(directory, task);
    try {
      await task;
    } finally {
      if (inflightActiveDirectoryLoadMore.get(directory) === task) {
        inflightActiveDirectoryLoadMore.delete(directory);
      }
    }
    return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
  },

  refreshArchivedSessionsForDirectories: async (directories) => {
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    const generation = loadGeneration;
    set((state) => {
      const nextLoading = new Set(state.archivedLoadingDirectories);
      directorySet.forEach((directory) => nextLoading.add(directory));
      return { archivedLoadingDirectories: nextLoading };
    });

    const tasks = [...directorySet].map((directory) => {
      const existing = inflightArchivedDirectoryRefresh.get(directory);
      if (existing) return existing;
      const task = scheduleDirectoryTask(async (): Promise<boolean> => {
        const controller = new AbortController();
        directoryAbortControllers.add(controller);
        try {
          if (generation !== loadGeneration) return false;
          await waitForOpenCodeReadiness();
          if (generation !== loadGeneration) return false;
          const archivedSessions = await listGlobalSessionPages(opencodeClient.getSdkClient(), {
            directory,
            archived: true,
            roots: true,
            pageSize: DIRECTORY_SESSION_LIMIT,
            maxItems: DIRECTORY_SESSION_LIMIT,
            timeoutMs: DIRECTORY_SESSION_TIMEOUT_MS,
            retryAttempts: 2,
            signal: controller.signal,
          });
          if (generation !== loadGeneration) return false;
          set((state) => {
            const nextArchived = replaceSessionsForDirectories(
              state.archivedSessions,
              filterPendingDeletionSessions(archivedSessions, state.pendingDeletionIds),
              new Set([directory]),
            );
            const nextLoaded = new Set(state.archivedLoadedDirectories);
            const nextLoading = new Set(state.archivedLoadingDirectories);
            nextLoaded.add(directory);
            nextLoading.delete(directory);
            return {
              archivedSessions: sameSessionList(state.archivedSessions, nextArchived) ? state.archivedSessions : nextArchived,
              archivedLoadedDirectories: nextLoaded,
              archivedLoadingDirectories: nextLoading,
            };
          });
          return true;
        } catch (error) {
          if (generation === loadGeneration) {
            console.warn(`[GlobalSessions] Failed to refresh archived sessions for ${directory}:`, error);
            set((state) => {
              const nextLoading = new Set(state.archivedLoadingDirectories);
              nextLoading.delete(directory);
              return { archivedLoadingDirectories: nextLoading };
            });
          }
          return false;
        } finally {
          directoryAbortControllers.delete(controller);
        }
      });
      inflightArchivedDirectoryRefresh.set(directory, task);
      void task.finally(() => {
        if (inflightArchivedDirectoryRefresh.get(directory) === task) {
          inflightArchivedDirectoryRefresh.delete(directory);
        }
      });
      return task;
    });
    await Promise.all(tasks);
    if (generation !== loadGeneration) return { activeSessions: [], archivedSessions: [] };
    return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
  },

  upsertSession: (session) => {
    if (!isVisibleGlobalSession(session)) {
      get().removeSessions([session.id]);
      return;
    }
    set((state) => {
      if (state.pendingDeletionIds.has(session.id)) {
        return state;
      }
      const existingSession = state.activeSessions.find((candidate) => candidate.id === session.id)
        ?? state.archivedSessions.find((candidate) => candidate.id === session.id)
        ?? null;
      const sessionWithMetadata = mergeSessionDirectoryMetadata(session, existingSession);
      const isArchived = Boolean(sessionWithMetadata.time?.archived);
      const nextActiveSessions = isArchived
        ? state.activeSessions.filter((candidate) => candidate.id !== session.id)
        : upsertSessionIntoList(state.activeSessions, sessionWithMetadata);
      const nextArchivedSessions = isArchived
        ? upsertSessionIntoList(state.archivedSessions, sessionWithMetadata)
        : state.archivedSessions.filter((candidate) => candidate.id !== session.id);

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: nextActiveSessions === state.activeSessions
          ? state.sessionsByDirectory
          : buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: nextActiveSessions === state.activeSessions
          ? state.reviewTransferBySessionId
          : buildReviewTransferMap(nextActiveSessions),
      };
    });
  },

  markSessionsPendingDeletion: (ids) => {
    set((state) => {
      let next: Set<string> | null = null;
      for (const id of ids) {
        if (!id || state.pendingDeletionIds.has(id)) continue;
        next ??= new Set(state.pendingDeletionIds);
        next.add(id);
      }
      return next ? { pendingDeletionIds: next } : state;
    });
  },

  clearSessionsPendingDeletion: (ids) => {
    set((state) => {
      let next: Set<string> | null = null;
      for (const id of ids) {
        if (!state.pendingDeletionIds.has(id)) continue;
        next ??= new Set(state.pendingDeletionIds);
        next.delete(id);
      }
      return next ? { pendingDeletionIds: next } : state;
    });
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const nextActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));
      const nextArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      if (
        nextActiveSessions.length === state.activeSessions.length
        && nextArchivedSessions.length === state.archivedSessions.length
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
      };
    });
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const movedSessions: Session[] = [];
      const nextActiveSessions = state.activeSessions.filter((session) => {
        if (!idSet.has(session.id)) {
          return true;
        }

        movedSessions.push({
          ...session,
          time: {
            ...session.time,
            archived: archivedAt,
          },
        });
        return false;
      });

      if (movedSessions.length === 0) {
        return state;
      }

      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...movedSessions, ...remainingArchivedSessions],
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
      };
    });
  },
}));

export const ensureFullGlobalSessionsLoaded = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  const state = useGlobalSessionsStore.getState();
  if (state.hasLoadedFullCatalog && state.status !== 'error') {
    return {
      activeSessions: state.activeSessions,
      archivedSessions: state.archivedSessions,
    };
  }
  return state.loadSessions(fallbackActive);
};

export const refreshGlobalSessions = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadSessions(fallbackActive);
};

export const startGlobalSessionIndexStartup = async (
  directories: Iterable<string>,
): Promise<LoadResult> => useGlobalSessionsStore.getState().startSessionIndexStartup(directories);

export const refreshGlobalSessionsForDirectories = async (
  directories: Iterable<string>,
  fallbackActive?: Session[],
): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories, fallbackActive);
};

export const syncGlobalSessionsForDirectories = async (
  directories: Iterable<string>,
  fallbackActive?: Session[],
): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().syncSessionsForDirectories(directories, fallbackActive);
};

/**
 * Refresh every cold-start directory through the existing adaptive scheduler,
 * while exposing deterministic progress for the global blocking overlay.
 */
export const refreshStartupGlobalSessionsForDirectories = async (
  directories: Iterable<string>,
  fallbackActive?: Session[],
  options?: {
    retryFailed?: boolean;
    incrementalStartByDirectory?: ReadonlyMap<string, number>;
  },
): Promise<LoadResult> => {
  const directorySet = normalizeDirectorySet(directories);
  const generation = loadGeneration;
  if (directorySet.size === 0) {
    useGlobalSessionsStore.setState({
      startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 },
    });
    const state = useGlobalSessionsStore.getState();
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  }

  useGlobalSessionsStore.setState({
    startupSyncProgress: { active: true, phase: 'syncing', completed: 0, total: directorySet.size },
  });

  const completedDirectories = new Set<string>();
  let pendingDirectories = new Set(directorySet);

  try {
    do {
      await Promise.all([...pendingDirectories].map(async (directory) => {
        let succeeded = false;
        await useGlobalSessionsStore.getState().refreshSessionsForDirectories(
          [directory],
          fallbackActive,
          {
            persist: false,
            incrementalStart: options?.incrementalStartByDirectory?.get(directory),
            onDirectoryResult: (_directory, success) => { succeeded = success; },
          },
        );
        if (
          generation === loadGeneration
          && succeeded
          && !completedDirectories.has(directory)
        ) {
          completedDirectories.add(directory);
          useGlobalSessionsStore.setState((state) => ({
            startupSyncProgress: {
              ...state.startupSyncProgress,
              completed: completedDirectories.size,
            },
          }));
        }
      }));

      pendingDirectories = new Set(
        [...directorySet].filter((directory) => !completedDirectories.has(directory)),
      );
      if (
        pendingDirectories.size > 0
        && options?.retryFailed === true
        && generation === loadGeneration
      ) {
        // Every request remains individually bounded. The short pause lets the
        // adaptive scheduler apply its lower concurrency before the next wave.
        await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS));
      }
    } while (
      pendingDirectories.size > 0
      && options?.retryFailed === true
      && generation === loadGeneration
    );

    if (generation === loadGeneration) {
      useGlobalSessionsStore.setState((state) => ({
        startupSyncProgress: { ...state.startupSyncProgress, phase: 'committing' },
      }));
      const state = useGlobalSessionsStore.getState();
      const snapshots = [...completedDirectories].flatMap((directory) => {
        // A successful empty list is authoritative and must replace stale
        // SQLite rows. Failed directories never enter completedDirectories,
        // so their last good cache and sync watermark survive the retry.
        const sessions = state.sessionsByDirectory.get(directory) ?? [];
        const pagination = state.activePaginationByDirectory.get(directory);
        return [{
          directory,
          sessions,
          cursor: pagination?.cursor ?? null,
          hasMore: pagination?.hasMore ?? false,
          fullSync: !options?.incrementalStartByDirectory?.has(directory),
        }];
      });
      try {
        await persistSessionIndexDirectories(snapshots);
        const syncedAt = Date.now();
        useGlobalSessionsStore.setState((current) => {
          const next = new Map(current.sessionIndexSyncByDirectory);
          for (const snapshot of snapshots) {
            const previous = next.get(snapshot.directory);
            next.set(snapshot.directory, {
              lastSyncedAt: syncedAt,
              lastFullSyncedAt: snapshot.fullSync
                ? syncedAt
                : (previous?.lastFullSyncedAt ?? 0),
            });
          }
          return { sessionIndexSyncByDirectory: next };
        });
      } catch (error) {
        console.warn('[GlobalSessions] Failed to persist cold-start session index batch:', error);
      }
    }
  } finally {
    if (generation === loadGeneration) {
      useGlobalSessionsStore.setState((state) => ({
        startupSyncProgress: {
          active: false,
          phase: 'idle',
          completed: completedDirectories.size,
          total: state.startupSyncProgress.total,
        },
      }));
    }
  }

  const state = useGlobalSessionsStore.getState();
  return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
};

export const refreshArchivedSessionsForDirectories = async (
  directories: Iterable<string>,
): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().refreshArchivedSessionsForDirectories(directories);
};

export const loadMoreGlobalSessionsForDirectory = async (directory: string): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadMoreSessionsForDirectory(directory);
};
