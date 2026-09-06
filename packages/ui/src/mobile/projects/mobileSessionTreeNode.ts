import type { MobileSessionTreeNode } from './MobileProjectsHome';

/**
 * Reuse the previous session-tree node object when display fields are identical.
 * Parent model rebuilds (running set / unseen map / directory churn) otherwise
 * allocate a fresh node per row and defeat row-level memo.
 */
export function reuseMobileSessionTreeNode(
  previous: MobileSessionTreeNode | undefined,
  next: MobileSessionTreeNode,
): MobileSessionTreeNode {
  if (
    previous
    && previous.id === next.id
    && previous.kind === next.kind
    && previous.title === next.title
    && previous.subtitle === next.subtitle
    && previous.changes === next.changes
    && previous.activityLabel === next.activityLabel
    && previous.unread === next.unread
    && previous.pinned === next.pinned
    && previous.archived === next.archived
    && previous.active === next.active
    && previous.directory === next.directory
    && previous.expanded === next.expanded
    // Type allows nested children even while home stays flat — identity must
    // participate so a future nested list cannot reuse a stale children ref.
    && previous.children === next.children
  ) {
    return previous;
  }
  return next;
}

/**
 * Structural-share an ordered list of session nodes against the previous list.
 * Unrelated rows keep their previous object identity.
 */
export function reuseMobileSessionTreeNodeList(
  previous: readonly MobileSessionTreeNode[] | undefined,
  next: readonly MobileSessionTreeNode[],
): MobileSessionTreeNode[] {
  if (!previous || previous.length === 0) {
    return next.slice();
  }
  const previousById = new Map(previous.map((node) => [node.id, node]));
  let shared = previous.length === next.length;
  const reused = next.map((node, index) => {
    const prior = previousById.get(node.id) ?? previous[index];
    const resolved = reuseMobileSessionTreeNode(prior, node);
    if (resolved !== previous[index]) shared = false;
    return resolved;
  });
  if (shared) {
    let identical = true;
    for (let i = 0; i < reused.length; i += 1) {
      if (reused[i] !== previous[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return previous as MobileSessionTreeNode[];
  }
  return reused;
}
