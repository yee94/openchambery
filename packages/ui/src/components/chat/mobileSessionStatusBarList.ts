import type { Session } from '@opencode-ai/sdk/v2';

export type SessionStatusLike = { type: string } | undefined;

export type SessionBadgeCounts = {
  totalRunning: number;
  totalUnread: number;
};

export type SessionWithStatusFields = Session & {
  _statusType?: 'busy' | 'retry' | 'idle';
  _hasRunningChildren?: boolean;
  _runningChildrenCount?: number;
  _childIndicators?: Array<{ session: Session; isRunning: boolean }>;
};

const EMPTY_SESSIONS: SessionWithStatusFields[] = [];

const getStatusType = (
  sessionStatus: Record<string, SessionStatusLike> | undefined,
  sessionId: string,
): 'busy' | 'retry' | 'idle' => {
  const status = sessionStatus?.[sessionId];
  if (status?.type === 'busy' || status?.type === 'retry') return status.type;
  return 'idle';
};

/**
 * Build the same parent→direct-child map the open-sheet path uses so closed
 * badge totals cannot drift from open enrichment (grandchildren stay nested
 * under their parent only when that parent is itself a direct child of a
 * top-level row — matching the historical open algorithm).
 */
const buildParentChildMap = (
  sessions: readonly Session[],
): { allIds: Set<string>; parentChildMap: Map<string, Session[]> } => {
  const allIds = new Set(sessions.map((session) => session.id));
  const parentChildMap = new Map<string, Session[]>();
  for (const session of sessions) {
    const parentID = (session as { parentID?: string }).parentID;
    if (parentID && allIds.has(parentID)) {
      const children = parentChildMap.get(parentID) ?? [];
      children.push(session);
      parentChildMap.set(parentID, children);
    }
  }
  return { allIds, parentChildMap };
};

const isTopLevelSession = (
  session: Session,
  allIds: Set<string>,
): boolean => {
  const parentID = (session as { parentID?: string }).parentID;
  return !parentID || !allIds.has(parentID);
};

/**
 * Cheap badge totals used while the recent-sessions sheet is closed / exiting.
 * Mirrors open-sheet group semantics: top-level unread only; running = top-level
 * self + direct children (not every descendant, not orphan-child unread).
 * Avoids the full enrichment + sort path the open list needs.
 */
export function countMobileSessionStatusBadges(
  sessions: readonly Session[],
  sessionStatus: Record<string, SessionStatusLike> | undefined,
  unseenCounts: Record<string, number> | undefined,
): SessionBadgeCounts {
  const { allIds, parentChildMap } = buildParentChildMap(sessions);
  let totalRunning = 0;
  let totalUnread = 0;

  for (const session of sessions) {
    if (!isTopLevelSession(session, allIds)) continue;
    const statusType = getStatusType(sessionStatus, session.id);
    const children = parentChildMap.get(session.id) ?? [];
    const runningChildrenCount = children.filter(
      (child) => getStatusType(sessionStatus, child.id) !== 'idle',
    ).length;
    totalRunning += (statusType !== 'idle' ? 1 : 0) + runningChildrenCount;
    if ((unseenCounts?.[session.id] ?? 0) > 0) totalUnread += 1;
  }

  return { totalRunning, totalUnread };
}

/**
 * Full open-sheet session enrichment. Callers pass `listEnabled=false` while the
 * sheet is closed so repeated status/SSE ticks skip this path entirely.
 * Closed returns empty `sessions` + live badge totals; callers that need exit
 * animation content freeze the last open list outside this helper.
 */
export function buildMobileSessionStatusList(
  sessions: readonly Session[],
  sessionStatus: Record<string, SessionStatusLike> | undefined,
  unseenCounts: Record<string, number> | undefined,
  listEnabled: boolean,
  getActivityUpdatedAt: (session: Session) => number,
): {
  sessions: SessionWithStatusFields[];
  totalRunning: number;
  totalUnread: number;
  totalCount: number;
} {
  if (!listEnabled) {
    const badges = countMobileSessionStatusBadges(sessions, sessionStatus, unseenCounts);
    return {
      sessions: EMPTY_SESSIONS,
      totalRunning: badges.totalRunning,
      totalUnread: badges.totalUnread,
      totalCount: 0,
    };
  }

  const { allIds, parentChildMap } = buildParentChildMap(sessions);

  const topLevel = sessions.filter((session) => isTopLevelSession(session, allIds));

  const running: SessionWithStatusFields[] = [];
  const viewed: SessionWithStatusFields[] = [];

  for (const session of topLevel) {
    const statusType = getStatusType(sessionStatus, session.id);
    const children = parentChildMap.get(session.id) ?? [];
    const runningChildren = children.filter(
      (child) => getStatusType(sessionStatus, child.id) !== 'idle',
    );
    const hasRunning = runningChildren.length > 0;
    const attention = (unseenCounts?.[session.id] ?? 0) > 0;
    const enriched: SessionWithStatusFields = {
      ...session,
      _statusType: statusType,
      _hasRunningChildren: hasRunning,
      _runningChildrenCount: runningChildren.length,
      _childIndicators: runningChildren.slice(0, 3).map((child) => ({
        session: child,
        isRunning: true,
      })),
    };

    if (statusType !== 'idle' || hasRunning || attention) {
      running.push(enriched);
    } else {
      viewed.push(enriched);
    }
  }

  const sortByActivityUpdated = (a: Session, b: Session) =>
    getActivityUpdatedAt(b) - getActivityUpdatedAt(a);
  running.sort(sortByActivityUpdated);
  viewed.sort(sortByActivityUpdated);

  const processedSessions = [...running, ...viewed];
  const totalRunning = processedSessions.reduce((sum, session) => {
    const selfRunning = session._statusType !== 'idle' ? 1 : 0;
    return sum + selfRunning + (session._runningChildrenCount ?? 0);
  }, 0);
  const totalUnread = processedSessions.filter(
    (session) => (unseenCounts?.[session.id] ?? 0) > 0,
  ).length;

  return {
    sessions: processedSessions,
    totalRunning,
    totalUnread,
    totalCount: processedSessions.length,
  };
}
