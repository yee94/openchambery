import type { Session } from '@/lib/opencode/v2-types';
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

/**
 * Manual drag order and later session activity are peers on one list:
 * start from the saved order, then promote only members whose activity advanced
 * past the drag-time baseline (or that are new to the scope). Unchanged members
 * keep their relative order. Duplicate/stale activity does not reshuffle.
 */
const buildEffectiveSessionOrder = (
  memberIds: readonly string[],
  sessionOrder: readonly string[] | undefined,
  activityBySessionId: Readonly<Record<string, number>>,
  savedActivity: Readonly<Record<string, number>> | undefined,
): string[] => {
  if (!sessionOrder || sessionOrder.length === 0 || !savedActivity) return [];

  const memberIdSet = new Set(memberIds);
  const orderIdSet = new Set(sessionOrder);
  const baseOrder = [
    ...sessionOrder.filter((id) => memberIdSet.has(id)),
    ...memberIds.filter((id) => !orderIdSet.has(id)),
  ];
  if (baseOrder.length === 0) return [];

  if (sessionOrderActivityMatches(activityBySessionId, savedActivity)) {
    return baseOrder;
  }

  const isBumped = (id: string): boolean => {
    const saved = savedActivity[id];
    // The baseline includes folded rows outside the draggable slice.
    if (saved === undefined) return !orderIdSet.has(id);
    return (activityBySessionId[id] ?? 0) > saved;
  };

  const bumped: string[] = [];
  const stable: string[] = [];
  baseOrder.forEach((id) => {
    if (isBumped(id)) bumped.push(id);
    else stable.push(id);
  });
  if (bumped.length === 0) return baseOrder;

  const baseIndex = new Map(baseOrder.map((id, index) => [id, index]));
  bumped.sort((left, right) => {
    const activityDelta = (activityBySessionId[right] ?? 0) - (activityBySessionId[left] ?? 0);
    if (activityDelta !== 0) return activityDelta;
    return (baseIndex.get(left) ?? 0) - (baseIndex.get(right) ?? 0);
  });
  return [...bumped, ...stable];
};

export const buildEffectiveSessionOrderIndex = (
  nodes: readonly SessionNodeLike[],
  sessionOrder: readonly string[] | undefined,
  savedActivity: Readonly<Record<string, number>> | undefined,
): Map<string, number> => {
  const activity = buildSessionActivitySnapshot(nodes.map((node) => node.session));
  const effectiveOrder = buildEffectiveSessionOrder(
    nodes.map((node) => node.session.id),
    sessionOrder,
    activity,
    savedActivity,
  );
  return new Map(effectiveOrder.map((id, index) => [id, index]));
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
