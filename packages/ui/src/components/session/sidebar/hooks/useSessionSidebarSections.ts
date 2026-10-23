import React from 'react';
import { replaceEqualDeep } from '@tanstack/react-query';
import type { Session } from '@/lib/opencode/v2-types';
import type { SessionGroup, SessionNode, GroupSearchData } from '../types';
import { dedupeSessionsById, normalizePath } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';

type ProjectItem = {
  id: string;
  path: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
};

type ProjectSection = {
  project: ProjectItem;
  groups: SessionGroup[];
};

const EMPTY_GROUP_SEARCH = new WeakMap<SessionGroup, GroupSearchData>();

type Args = {
  normalizedProjects: ProjectItem[];
  getSessionsForProject: (projectId: string) => Session[];
  getArchivedSessionsForProject: (projectId: string) => Session[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  projectRepoStatus: Map<string, boolean | null>;
  projectRootBranches: Map<string, string | null>;
  lastRepoStatus: boolean;
  buildGroupedSessions: (
    sessions: Session[],
    projectRoot: string,
    availableWorktrees: WorktreeMetadata[],
    rootBranch: string | null,
    isRepo: boolean,
  ) => SessionGroup[];
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  filterSessionNodesForSearch: (nodes: SessionNode[], query: string) => SessionNode[];
  buildGroupSearchText: (group: SessionGroup) => string;
  foldersMap: SessionFoldersMap;
};

export const useSessionSidebarSections = (args: Args) => {
  const {
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
  } = args;

  const committedSections = React.useRef<ProjectSection[]>([]);
  const projectSections = React.useMemo<ProjectSection[]>(() => {
    const previousById = new Map(committedSections.current.map((section) => [section.project.id, section]));
    const sections = normalizedProjects.map((project) => {
      const previous = previousById.get(project.id);
      const projectSessions = dedupeSessionsById([
        ...getSessionsForProject(project.id),
        ...getArchivedSessionsForProject(project.id),
      ]);
      const worktreesForProject = availableWorktreesByProject.get(project.normalizedPath) ?? [];
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatus;
      const previousGroups = new Map(previous?.groups.map((group) => [group.id, group]));
      const groups = buildGroupedSessions(
        projectSessions,
        project.normalizedPath,
        worktreesForProject,
        projectRootBranches.get(project.id) ?? null,
        isRepo,
      ).map((group) => replaceEqualDeep(previousGroups.get(group.id), group));
      return replaceEqualDeep(previous, { project, groups });
    });
    return sections.length === committedSections.current.length
      && sections.every((section, index) => section === committedSections.current[index])
      ? committedSections.current : sections;
  }, [
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    lastRepoStatus,
    buildGroupedSessions,
    projectRootBranches,
  ]);

  React.useLayoutEffect(() => {
    committedSections.current = projectSections;
  }, [projectSections]);

  const visibleProjectSections = React.useMemo(() => {
    return projectSections;
  }, [projectSections]);

  const groupSearchDataByGroup = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return EMPTY_GROUP_SEARCH;
    }
    const result = new WeakMap<SessionGroup, GroupSearchData>();

    const countNodes = (nodes: SessionNode[]): number => nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);

    visibleProjectSections.forEach((section) => {
      section.groups.forEach((group) => {
        const filteredNodes = filterSessionNodesForSearch(group.sessions, normalizedSessionSearchQuery);
        const matchedSessionCount = countNodes(filteredNodes);
        const groupMatches = buildGroupSearchText(group).includes(normalizedSessionSearchQuery);
        const scopeKey = normalizePath(group.directory ?? null);
        const scopeFolders = scopeKey ? (foldersMap[scopeKey] ?? []) : [];
        const folderNameMatchCount = scopeFolders.filter((folder) => folder.name.toLowerCase().includes(normalizedSessionSearchQuery)).length;

        result.set(group, {
          filteredNodes,
          matchedSessionCount,
          folderNameMatchCount,
          groupMatches,
          hasMatch: groupMatches || matchedSessionCount > 0 || folderNameMatchCount > 0,
        });
      });
    });

    return result;
  }, [
    hasSessionSearchQuery,
    visibleProjectSections,
    filterSessionNodesForSearch,
    normalizedSessionSearchQuery,
    buildGroupSearchText,
    foldersMap,
  ]);

  const searchableProjectSections = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return visibleProjectSections;
    }

    return visibleProjectSections
      .map((section) => ({
        ...section,
        groups: section.groups.filter((group) => groupSearchDataByGroup.get(group)?.hasMatch === true),
      }))
      .filter((section) => section.groups.length > 0);
  }, [hasSessionSearchQuery, visibleProjectSections, groupSearchDataByGroup]);

  const sectionsForRender = hasSessionSearchQuery ? searchableProjectSections : visibleProjectSections;

  const searchMatchCount = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return 0;
    }

    return sectionsForRender.reduce((total, section) => {
      return total + section.groups.reduce((groupTotal, group) => {
        const data = groupSearchDataByGroup.get(group);
        if (!data) {
          return groupTotal;
        }
        const metadataMatches = data.folderNameMatchCount + (data.groupMatches ? 1 : 0);
        return groupTotal + data.matchedSessionCount + metadataMatches;
      }, 0);
    }, 0);
  }, [hasSessionSearchQuery, sectionsForRender, groupSearchDataByGroup]);

  return {
    projectSections,
    visibleProjectSections,
    groupSearchDataByGroup,
    searchableProjectSections,
    sectionsForRender,
    searchMatchCount,
  };
};
