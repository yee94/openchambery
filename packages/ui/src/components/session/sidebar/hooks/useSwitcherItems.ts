import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePinnedSessionIds } from '@/queries/sessionIndexPinQueries';
import { useGitStore } from '@/stores/useGitStore';
import type { SessionNode } from '../types';
import { compareSessionsByPinnedAndTime, isPathWithinProject } from '../utils';

export type SwitcherItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

const MAX_PARENT_SESSIONS = 7;

type SwitcherItemsOptions = {
  scopeProjectId?: string | null;
};

const normalize = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const formatProjectLabel = (project: { label?: string | null; path: string } | null): string | null => {
  if (!project) return null;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
};

export const useSwitcherItems = (enabled: boolean, options: SwitcherItemsOptions = {}): SwitcherItem[] => {
  const { scopeProjectId = null } = options;
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const pinnedSessionIds = usePinnedSessionIds();

  const normalizedProjects = React.useMemo(
    () => projects
      .map((project) => ({ ...project, normalizedPath: normalize(project.path) }))
      .filter((project) => project.normalizedPath),
    [projects],
  );

  const findProjectForDirectory = React.useCallback(
    (directory: string | null) => {
      if (!directory) return null;
      const matches = normalizedProjects
        .filter((project) => isPathWithinProject(directory, project.normalizedPath))
        .sort((a, b) => (b.normalizedPath?.length ?? 0) - (a.normalizedPath?.length ?? 0));
      return matches[0] ?? null;
    },
    [normalizedProjects],
  );

  const visibleDirectories = React.useMemo(() => {
    if (!enabled) return [];
    return Array.from(new Set(activeSessions
      .filter((session) => !session.time?.archived)
      .filter((session) => !(session as Session & { parentID?: string | null }).parentID)
      .filter((session) => {
        if (!scopeProjectId) return true;
        return findProjectForDirectory(resolveGlobalSessionDirectory(session))?.id === scopeProjectId;
      })
      .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds))
      .slice(0, MAX_PARENT_SESSIONS)
      .map((session) => resolveGlobalSessionDirectory(session))
      .filter((directory): directory is string => Boolean(directory))));
  }, [activeSessions, enabled, findProjectForDirectory, pinnedSessionIds, scopeProjectId]);

  const branchesCacheRef = React.useRef<Map<string, string | null>>(new Map());
  const branchesByDirectory = useGitStore((state) => {
    const previous = branchesCacheRef.current;
    let same = previous.size === visibleDirectories.length;
    if (same) {
      for (const directory of visibleDirectories) {
        if (previous.get(directory) !== (state.directories.get(directory)?.status?.current ?? null)) {
          same = false;
          break;
        }
      }
    }
    if (same) return previous;
    const next = new Map<string, string | null>();
    visibleDirectories.forEach((directory) => next.set(directory, state.directories.get(directory)?.status?.current ?? null));
    branchesCacheRef.current = next;
    return next;
  });

  const items = React.useMemo<SwitcherItem[]>(() => {
    if (!enabled) return [];

    const childrenByParent = new Map<string, Session[]>();
    for (const session of activeSessions) {
      const parentId = (session as Session & { parentID?: string | null }).parentID;
      if (!parentId) continue;
      if (session.time?.archived) continue;
      const bucket = childrenByParent.get(parentId);
      if (bucket) {
        bucket.push(session);
      } else {
        childrenByParent.set(parentId, [session]);
      }
    }
    childrenByParent.forEach((list) => {
      list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
    });

    const parents = activeSessions
      .filter((session) => !session.time?.archived)
      .filter((session) => !(session as Session & { parentID?: string | null }).parentID)
      .filter((session) => {
        if (!scopeProjectId) return true;
        const directory = resolveGlobalSessionDirectory(session);
        return findProjectForDirectory(directory)?.id === scopeProjectId;
      })
      .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds))
      .slice(0, MAX_PARENT_SESSIONS);

    const buildNode = (session: Session): SessionNode => {
      const childSessions = childrenByParent.get(session.id) ?? [];
      return {
        session,
        children: childSessions.map((child) => buildNode(child)),
        worktree: null,
      };
    };

    return parents.map((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      const matchedProject = findProjectForDirectory(directory);
      const projectLabel = formatProjectLabel(matchedProject);
      const branchLabel = directory ? branchesByDirectory.get(directory) ?? null : null;
      return {
        node: buildNode(session),
        projectId: matchedProject?.id ?? null,
        groupDirectory: directory,
        secondaryMeta: {
          projectLabel,
          branchLabel: branchLabel && branchLabel !== projectLabel ? branchLabel : null,
        },
      };
    });
  }, [activeSessions, branchesByDirectory, enabled, findProjectForDirectory, pinnedSessionIds, scopeProjectId]);

  return items;
};
