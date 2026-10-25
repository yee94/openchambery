import React from 'react';
import type { SessionGroup } from '../types';
import { useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { normalizePath } from '@/lib/pathNormalization';

export const useGroupOrdering = (groupOrderByProject: Map<string, string[]>) => {
  const worktreeOrderByProject = useWorktreeOrderStore((state) => state.orderByProject);
  const getOrderedGroups = React.useMemo(
    () => (projectId: string, groups: SessionGroup[]) => {
      const preferredOrder = groupOrderByProject.get(projectId);
      const worktreeOrder = worktreeOrderByProject[projectId];
      if (!preferredOrder?.length && !worktreeOrder?.length) {
        return groups;
      }
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const ordered: SessionGroup[] = [];
      preferredOrder?.forEach((id) => {
        const group = groupById.get(id);
        if (group) {
          ordered.push(group);
          groupById.delete(id);
        }
      });
      groups.forEach((group) => {
        if (groupById.has(group.id)) {
          ordered.push(group);
        }
      });
      if (!worktreeOrder?.length) return ordered;
      const rank = new Map(worktreeOrder.map((path, index) => [normalizePath(path), index]));
      const worktrees = ordered.filter((group) => group.worktree && !group.isMain);
      worktrees.sort((a, b) => (rank.get(normalizePath(a.directory)) ?? Number.MAX_SAFE_INTEGER)
        - (rank.get(normalizePath(b.directory)) ?? Number.MAX_SAFE_INTEGER));
      let index = 0;
      return ordered.map((group) => group.worktree && !group.isMain ? worktrees[index++] : group);
    },
    [groupOrderByProject, worktreeOrderByProject],
  );

  return { getOrderedGroups };
};
