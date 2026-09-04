import type { Session } from '@opencode-ai/sdk/v2';

import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';

const getSessionCreatedAt = (session: Session): number => {
  const created = session.time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
};

export const derivePinnedSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
): Session[] => {
  return sessions
    .filter((session) => pinnedSessionIds.has(session.id))
    .sort((a, b) => getSessionCreatedAt(b) - getSessionCreatedAt(a));
};

const getSessionParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const isSessionArchived = (session: Session): boolean => {
  const archived = session.time?.archived;
  return typeof archived === 'number' && archived > 0;
};

/**
 * Non-pinned home-attention rows: live busy/retry sessions, plus top-level
 * unread sessions (the blue completed-unread marker). Pinned ids stay in the
 * pinned group; archived sessions stay out of this ephemeral set.
 */
export const listInProgressHomeSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
  runningSessionIds: ReadonlySet<string>,
  unseenBySession: Readonly<Record<string, number>>,
): Session[] => {
  const active: Session[] = [];
  for (const session of sessions) {
    if (pinnedSessionIds.has(session.id) || isSessionArchived(session)) continue;
    const running = runningSessionIds.has(session.id);
    const unread = (unseenBySession[session.id] ?? 0) > 0 && !getSessionParentId(session);
    if (!running && !unread) continue;
    active.push(session);
  }
  active.sort((a, b) => getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a));
  return active;
};
