import { getRelativeFilePath, normalizeFilePath } from '@/lib/path-utils';

export const FILE_TREE_EXPAND_ALL_MAX_DEPTH = 10;

type FileTreeDirectoryNode = {
  path: string;
  type: string;
};

export const getFileTreeDirectoryDepth = (root: string, path: string): number => {
  const relative = getRelativeFilePath(path, root);
  if (!relative || relative === '.' || relative === path) {
    return 0;
  }
  return relative.split('/').filter(Boolean).length;
};

export const collectExpandableDirectoryPaths = (
  root: string,
  childrenByDir: Record<string, readonly FileTreeDirectoryNode[] | undefined>,
  maxDepth = FILE_TREE_EXPAND_ALL_MAX_DEPTH,
): string[] => {
  const normalizedRoot = normalizeFilePath(root);
  if (!normalizedRoot || maxDepth < 1) {
    return [];
  }

  const seen = new Set<string>();
  const paths: string[] = [];

  for (const nodes of Object.values(childrenByDir)) {
    if (!nodes) continue;
    for (const node of nodes) {
      if (node.type !== 'directory') continue;
      const normalized = normalizeFilePath(node.path);
      if (!normalized || seen.has(normalized)) continue;
      const depth = getFileTreeDirectoryDepth(normalizedRoot, normalized);
      if (depth < 1 || depth > maxDepth) continue;
      seen.add(normalized);
      paths.push(normalized);
    }
  }

  return paths;
};

export const shouldCollapseFileTree = (expandedPaths: readonly string[]): boolean => (
  expandedPaths.some((path) => Boolean(normalizeFilePath(path)))
);

export const collectUnexpandedDirectoryPaths = (
  expandableDirectoryPaths: readonly string[],
  expandedPaths: readonly string[],
): string[] => {
  const expandedPathSet = new Set(
    expandedPaths.map((path) => normalizeFilePath(path)).filter(Boolean),
  );
  return expandableDirectoryPaths.filter((path) => !expandedPathSet.has(path));
};

export const isFileTreeExpandAllSettled = (
  expandableDirectoryPaths: readonly string[],
  expandedPaths: readonly string[],
  loadedOrFailedPaths: ReadonlySet<string>,
): boolean => {
  if (expandedPaths.length === 0) {
    return expandableDirectoryPaths.length === 0;
  }
  if (collectUnexpandedDirectoryPaths(expandableDirectoryPaths, expandedPaths).length > 0) {
    return false;
  }
  return expandedPaths.every((path) => loadedOrFailedPaths.has(normalizeFilePath(path)));
};
