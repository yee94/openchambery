import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from './types';
import { compareSessionsByPinnedAndTime, dedupeSessionsById } from './utils';

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

const getParentID = (session: Session): string | null => {
  const parentID = (session as Session & { parentID?: string | null }).parentID;
  return typeof parentID === 'string' && parentID.trim() ? parentID : null;
};

export type BuildSessionTreeOptions = {
  pinnedSessionIds?: ReadonlySet<string>;
  /**
   * When true, omit pinned sessions from the returned forest (project area).
   * Tree structure is still built with pinned parents present so children attach.
   */
  omitPinnedSessions?: boolean;
  getWorktree?: (session: Session) => WorktreeMetadata | null;
};

/**
 * Build a parent/child session forest.
 *
 * Pinned filtering happens after attachment. Project callers omit pinned roots
 * from the visible forest; children of those roots stay hidden only while the
 * parent is pinned (flat pin rows). Unpinning rebuilds the normal parent/child tree.
 *
 * Sessions with a parentID are never promoted to roots. If the parent is missing
 * from this list, archived differently, or pinned-and-omitted, the child stays
 * out of the forest entirely (subagents load only on expand).
 */
export const buildSessionTree = (
  sessions: Session[],
  options: BuildSessionTreeOptions = {},
): SessionNode[] => {
  const pinnedSessionIds = options.pinnedSessionIds ?? new Set<string>();
  const omitPinnedSessions = options.omitPinnedSessions === true;
  const getWorktree = options.getWorktree ?? (() => null);

  const sortedSessions = dedupeSessionsById(sessions)
    .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));

  const sessionMap = new Map(sortedSessions.map((session) => [session.id, session]));
  const childrenMap = new Map<string, Session[]>();

  sortedSessions.forEach((session) => {
    const parentID = getParentID(session);
    if (!parentID) return;
    const parentSession = sessionMap.get(parentID);
    if (!parentSession || isArchivedSession(parentSession) !== isArchivedSession(session)) {
      return;
    }
    // Pinned parents render as flat rows; never nest children under them.
    if (omitPinnedSessions && pinnedSessionIds.has(parentID)) {
      return;
    }
    const collection = childrenMap.get(parentID) ?? [];
    collection.push(session);
    childrenMap.set(parentID, collection);
  });
  childrenMap.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds)));

  const buildNode = (session: Session): SessionNode => {
    const children = (childrenMap.get(session.id) ?? [])
      .filter((child) => !(omitPinnedSessions && pinnedSessionIds.has(child.id)))
      .map((child) => buildNode(child));
    return {
      session,
      children,
      worktree: getWorktree(session),
    };
  };

  const roots = sortedSessions.filter((session) => {
    if (omitPinnedSessions && pinnedSessionIds.has(session.id)) {
      return false;
    }
    const parentID = getParentID(session);
    // True roots only. Never promote an orphan subagent to the project list —
    // missing/hidden/archived parents used to leak scheduled-task children here.
    if (parentID) return false;
    return true;
  });

  return roots.map((session) => buildNode(session));
};
