import type { Session } from '@opencode-ai/sdk/v2';

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
