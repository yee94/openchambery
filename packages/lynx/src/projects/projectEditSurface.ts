/**
 * Pure helpers for Cap MobileProjectEditSurface worktree reorder (portable ↑/↓).
 */

export type LynxEditableWorktree = {
  path: string;
  label: string;
  branch?: string | null;
  kind: 'main' | 'worktree';
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

/** Cap normalizePath spirit for worktree order keys. */
export const normalizeLynxWorktreeOrderPath = normalizePath;

export const moveLynxWorktreeOrder = <T extends { path: string }>(
  items: T[],
  path: string,
  direction: 'up' | 'down',
): T[] => {
  const index = items.findIndex((item) => normalizePath(item.path) === normalizePath(path));
  if (index < 0) return items;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
};

export const applyLynxWorktreeOrderPaths = <T extends { path: string }>(
  items: T[],
  orderedPaths: string[],
): T[] => {
  if (orderedPaths.length === 0) return items;
  const byPath = new Map(items.map((item) => [normalizePath(item.path), item]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const path of orderedPaths) {
    const key = normalizePath(path);
    const item = byPath.get(key);
    if (!item || seen.has(key)) continue;
    ordered.push(item);
    seen.add(key);
  }
  for (const item of items) {
    const key = normalizePath(item.path);
    if (seen.has(key)) continue;
    ordered.push(item);
  }
  return ordered;
};

export const lynxEditableWorktreeLabel = (worktree: {
  branch?: string | null;
  label?: string | null;
  name?: string | null;
  path: string;
}): string =>
  (worktree.branch || worktree.label || worktree.name || worktree.path).trim() || worktree.path;
