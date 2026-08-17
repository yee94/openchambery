import type { Session } from '@/lib/opencode/v2-types';

export const prunePinnedSessionIds = (
  sessions: Array<Pick<Session, 'id'>>,
  pinnedSessionIds: Set<string>,
): Set<string> => {
  const existingSessionIds = new Set(sessions.map((session) => session.id));
  let changed = false;
  const next = new Set<string>();

  pinnedSessionIds.forEach((id) => {
    if (existingSessionIds.has(id)) {
      next.add(id);
      return;
    }
    changed = true;
  });

  return changed ? next : pinnedSessionIds;
};

export const prunePinnedSessionIdsByKnownIds = (
  knownSessionIds: ReadonlySet<string>,
  pinnedSessionIds: Set<string>,
): Set<string> => {
  let changed = false;
  const next = new Set<string>();
  pinnedSessionIds.forEach((id) => {
    if (knownSessionIds.has(id)) {
      next.add(id);
      return;
    }
    changed = true;
  });
  return changed ? next : pinnedSessionIds;
};
