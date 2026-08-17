import type { Session } from '@/lib/opencode/v2-types';

const getSessionCreatedAt = (session: Session): number => {
  const created = session.time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
};

export const derivePinnedSessions = (
  sessions: Session[],
  pinnedSessionIds: Set<string>,
): Session[] => {
  return sessions
    .filter((session) => pinnedSessionIds.has(session.id))
    .sort((a, b) => getSessionCreatedAt(b) - getSessionCreatedAt(a));
};
