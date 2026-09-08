/**
 * Cap MobileSessionsSheet `collectSessionTreeIds` / `getParentId` for Lynx.
 * Uses OpenCode/Cap `parentID` links from session-index. Portable — no Cap stores.
 */

export type LynxSessionParentLink = {
  id: string;
  parentID?: string | null;
};

export type LynxSessionTreeTarget = {
  sessionId: string;
  directory: string | null;
};

/** Cap `getParentId` — OpenCode session.parentID. */
export const getLynxParentId = (
  session: LynxSessionParentLink | null | undefined,
): string | null => {
  const parent = session?.parentID?.trim();
  return parent ? parent : null;
};

/**
 * Cap `collectSessionTreeIds`: root + all descendants via parentID.
 * DFS preorder; cycles skipped via visited set.
 */
export const collectLynxSessionTreeIds = (
  sessionId: string,
  sessions: readonly LynxSessionParentLink[],
): string[] => {
  const rootId = sessionId.trim();
  if (!rootId) return [];

  const childrenByParent = new Map<string, string[]>();
  for (const candidate of sessions) {
    const parentId = getLynxParentId(candidate);
    if (!parentId) continue;
    const childId = candidate.id?.trim();
    if (!childId) continue;
    const childIds = childrenByParent.get(parentId) ?? [];
    childIds.push(childId);
    childrenByParent.set(parentId, childIds);
  }

  const collected: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    collected.push(id);
    for (const childId of childrenByParent.get(id) ?? []) visit(childId);
  };
  visit(rootId);
  return collected;
};

/**
 * Resolve tree ids to delete/archive targets with directories from session-index map.
 * Falls back to the provided root directory when a child has no directory entry.
 */
export const resolveLynxSessionTreeTargets = (
  root: { sessionId: string; directory?: string | null },
  sessionById: ReadonlyMap<string, LynxSessionParentLink & { directory?: string | null }>,
): LynxSessionTreeTarget[] => {
  const rootId = root.sessionId.trim();
  if (!rootId) return [];

  const sessions = [...sessionById.values()];
  if (!sessionById.has(rootId)) {
    sessions.push({
      id: rootId,
      parentID: null,
      directory: root.directory ?? null,
    });
  }

  const ids = collectLynxSessionTreeIds(rootId, sessions);
  const fallbackDirectory = root.directory?.trim() ? root.directory.trim() : null;
  return ids.map((id) => {
    const hit = sessionById.get(id);
    const directory = hit?.directory?.trim()
      ? hit.directory.trim()
      : (id === rootId ? fallbackDirectory : fallbackDirectory);
    return { sessionId: id, directory };
  });
};

export const LYNX_SESSION_TREE_IDS_NOTES = [
  'Cap MobileSessionsSheet collectSessionTreeIds + getParentId (session.parentID).',
  'Menu archive/delete applies to root + descendants; report archivedIds/failedIds honestly.',
  'Deferred: Cap toast lib / bulk multi-select (desktop sidebar folders) / @dnd-kit.',
] as const;
