import type { Session } from '@opencode-ai/sdk/v2';
import { sessionOrderActivityMatches, type SessionFolder } from '@/stores/useSessionFoldersStore';
import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';
import { compareSessionsByPinnedAndTime } from './utils';

type SessionNodeLike = { session: Session };

type Args = {
  folders: Array<{ folder: SessionFolder; nodes: SessionNodeLike[] }>;
  visibleUngroupedNodes: SessionNodeLike[];
  collapsedFolderIds: ReadonlySet<string>;
  hasSessionSearchQuery: boolean;
};

export type VisibleSortableSessionOrder = {
  sessionIds: string[];
  folderIdBySessionId: Map<string, string | null>;
};

export const buildSessionActivitySnapshot = (
  sessions: readonly Session[],
): Record<string, number> => Object.fromEntries(
  sessions.map((session) => [session.id, getSessionActivityUpdatedAt(session)]),
);

export const buildEffectiveSessionOrderIndex = (
  nodes: readonly SessionNodeLike[],
  sessionOrder: readonly string[] | undefined,
  savedActivity: Readonly<Record<string, number>> | undefined,
): Map<string, number> => {
  const activity = buildSessionActivitySnapshot(nodes.map((node) => node.session));
  if (!sessionOrderActivityMatches(activity, savedActivity)) return new Map();
  return new Map((sessionOrder ?? []).map((id, index) => [id, index]));
};

export const createSessionNodeComparator = (
  nodes: readonly SessionNodeLike[],
  sessionOrder: readonly string[] | undefined,
  savedActivity: Readonly<Record<string, number>> | undefined,
  pinnedSessionIds: ReadonlySet<string>,
): ((a: SessionNodeLike, b: SessionNodeLike) => number) => {
  const sessionOrderIndex = buildEffectiveSessionOrderIndex(nodes, sessionOrder, savedActivity);
  return (a, b) => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds);
  };
};

/** Mirrors the folder-first DOM order used by SessionGroupSection. */
export const buildVisibleSortableSessionOrder = ({
  folders,
  visibleUngroupedNodes,
  collapsedFolderIds,
  hasSessionSearchQuery,
}: Args): VisibleSortableSessionOrder => {
  const folderById = new Map(folders.map((entry) => [entry.folder.id, entry]));
  const childrenByParentId = new Map<string | null, string[]>();
  folders.forEach(({ folder }) => {
    const parentId = folder.parentId ?? null;
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(folder.id);
    childrenByParentId.set(parentId, children);
  });

  const sessionIds: string[] = [];
  const folderIdBySessionId = new Map<string, string | null>();
  const appendFolder = (folderId: string): void => {
    const entry = folderById.get(folderId);
    if (!entry) return;
    if (!hasSessionSearchQuery && collapsedFolderIds.has(folderId)) return;
    (childrenByParentId.get(folderId) ?? []).forEach(appendFolder);
    entry.nodes.forEach((node) => {
      sessionIds.push(node.session.id);
      folderIdBySessionId.set(node.session.id, folderId);
    });
  };

  (childrenByParentId.get(null) ?? []).forEach(appendFolder);
  visibleUngroupedNodes.forEach((node) => {
    sessionIds.push(node.session.id);
    folderIdBySessionId.set(node.session.id, null);
  });
  return { sessionIds, folderIdBySessionId };
};

export const canReorderVisibleSessions = (
  activeSessionId: string,
  overSessionId: string,
  folderIdBySessionId: ReadonlyMap<string, string | null>,
): boolean => folderIdBySessionId.get(activeSessionId) === folderIdBySessionId.get(overSessionId);
