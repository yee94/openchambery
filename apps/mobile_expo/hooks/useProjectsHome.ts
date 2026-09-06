import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConnection } from '@/context/ConnectionContext';
import { checkIsGitRepository, listGitWorktrees } from '@/lib/gitWorktreesApi';
import {
  buildProjectsHomeModel,
  gitWorktreesToMetadata,
  nextBucketVisibleCount,
  resetBucketVisibleCount,
  type ProjectsHomeModel,
  type WorktreeMetadataLite,
} from '@/lib/projectsHomeModel';
import {
  loadProjectsSettings,
  putProjectsSettings,
  type ProjectEntry,
  type ProjectsSettingsSlice,
} from '@/lib/projectsSettingsApi';
import {
  loadSessionIndexSnapshot,
  SessionIndexError,
  type SessionIndexSnapshot,
} from '@/lib/sessionIndex';
import { fetchWorktreeOrder } from '@/lib/worktreeOrderApi';
import { normalizePath } from '@/lib/sessionHomeModel';

export type ProjectsHomeStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export type ProjectsHomeState = {
  status: ProjectsHomeStatus;
  model: ProjectsHomeModel | null;
  snapshot: SessionIndexSnapshot | null;
  projects: ProjectEntry[];
  activeProjectId: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setWorktreeExpanded: (projectId: string, bucketKey: string, expanded: boolean) => void;
  showMoreBucket: (projectId: string, bucketKey: string) => void;
  showFewerBucket: (projectId: string, bucketKey: string) => void;
  replaceProjects: (slice: ProjectsSettingsSlice) => void;
  saveProjects: (next: ProjectEntry[], activeProjectId?: string | null) => Promise<ProjectsSettingsSlice>;
  worktreesByProjectPath: ReadonlyMap<string, WorktreeMetadataLite[]>;
  refreshProjectWorktrees: (projectPath: string) => Promise<WorktreeMetadataLite[]>;
  probeGitRepo: (projectId: string, projectPath: string) => Promise<boolean>;
  gitRepoByProjectId: Readonly<Record<string, boolean>>;
};

const emptyModel = (): ProjectsHomeModel => ({
  projects: [],
  pinnedSessions: [],
  inProgressSessions: [],
  catalog: [],
});

/**
 * Live Projects home: session-index + settings projects + git worktrees.
 * Failure stays in `error` — never coerces to empty success.
 */
export function useProjectsHome(options?: {
  unseenBySession?: Readonly<Record<string, number>>;
  runningSessionIds?: ReadonlySet<string>;
  untitledLabel?: string;
  currentSessionId?: string | null;
}): ProjectsHomeState {
  const { state } = useConnection();
  const active = state.active;
  const [status, setStatus] = useState<ProjectsHomeStatus>('idle');
  const [snapshot, setSnapshot] = useState<SessionIndexSnapshot | null>(null);
  const [projectsSlice, setProjectsSlice] = useState<ProjectsSettingsSlice>({
    projects: [],
    activeProjectId: null,
  });
  const [worktreesByProjectPath, setWorktreesByProjectPath] = useState<
    Map<string, WorktreeMetadataLite[]>
  >(() => new Map());
  const [worktreeOrderByProjectId, setWorktreeOrderByProjectId] = useState<
    Record<string, string[]>
  >({});
  const [gitRepoByProjectId, setGitRepoByProjectId] = useState<Record<string, boolean>>({});
  const [projectExpanded, setProjectExpandedMap] = useState<Record<string, boolean>>({});
  const [worktreeExpanded, setWorktreeExpandedMap] = useState<Record<string, boolean>>({});
  const [visibleCountByBucket, setVisibleCountByBucket] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refreshProjectWorktrees = useCallback(
    async (projectPath: string): Promise<WorktreeMetadataLite[]> => {
      if (!active) return [];
      const path = normalizePath(projectPath);
      try {
        const listed = await listGitWorktrees(active, path);
        const meta = gitWorktreesToMetadata(path, listed);
        setWorktreesByProjectPath((prev) => {
          const next = new Map(prev);
          next.set(path, meta);
          return next;
        });
        return meta;
      } catch {
        setWorktreesByProjectPath((prev) => {
          const next = new Map(prev);
          next.set(path, prev.get(path) ?? []);
          return next;
        });
        return [];
      }
    },
    [active],
  );

  const probeGitRepo = useCallback(
    async (projectId: string, projectPath: string): Promise<boolean> => {
      if (!active) return false;
      try {
        const ok = await checkIsGitRepository(active, normalizePath(projectPath));
        setGitRepoByProjectId((prev) =>
          prev[projectId] === ok ? prev : { ...prev, [projectId]: ok },
        );
        return ok;
      } catch {
        setGitRepoByProjectId((prev) =>
          prev[projectId] === false ? prev : { ...prev, [projectId]: false },
        );
        return false;
      }
    },
    [active],
  );

  const refresh = useCallback(async () => {
    if (!active) {
      setStatus('idle');
      setSnapshot(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      const [nextSnapshot, nextSettings] = await Promise.all([
        loadSessionIndexSnapshot(active),
        loadProjectsSettings(active).catch(() => ({ projects: [], activeProjectId: null })),
      ]);
      if (id !== requestId.current) return;
      if (nextSnapshot == null) {
        setSnapshot(null);
        setStatus('unsupported');
        return;
      }
      setSnapshot(nextSnapshot);
      setProjectsSlice(nextSettings);

      const worktreeEntries = await Promise.all(
        nextSettings.projects.map(async (project) => {
          const path = normalizePath(project.path);
          try {
            const listed = await listGitWorktrees(active, path);
            return [path, gitWorktreesToMetadata(path, listed)] as const;
          } catch {
            return [path, [] as WorktreeMetadataLite[]] as const;
          }
        }),
      );
      if (id !== requestId.current) return;
      setWorktreesByProjectPath(new Map(worktreeEntries));

      const orderEntries = await Promise.all(
        nextSettings.projects.map(async (project) => {
          try {
            const order = await fetchWorktreeOrder(active, normalizePath(project.path));
            return order ? ([project.id, order.orderedPaths] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      if (id !== requestId.current) return;
      const orderMap: Record<string, string[]> = {};
      for (const entry of orderEntries) {
        if (entry) orderMap[entry[0]] = entry[1];
      }
      setWorktreeOrderByProjectId(orderMap);

      const gitEntries = await Promise.all(
        nextSettings.projects.map(async (project) => {
          try {
            const ok = await checkIsGitRepository(active, normalizePath(project.path));
            return [project.id, ok] as const;
          } catch {
            return [project.id, false] as const;
          }
        }),
      );
      if (id !== requestId.current) return;
      setGitRepoByProjectId(Object.fromEntries(gitEntries));

      setStatus('ready');
    } catch (err) {
      if (id !== requestId.current) return;
      const message =
        err instanceof SessionIndexError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'projects home request failed';
      setError(message);
      setStatus('error');
    }
  }, [active]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = useMemo(() => {
    if (!snapshot) return status === 'ready' ? emptyModel() : null;
    return buildProjectsHomeModel(snapshot, projectsSlice.projects, {
      unseenBySession: options?.unseenBySession,
      runningSessionIds: options?.runningSessionIds,
      untitledLabel: options?.untitledLabel,
      activeProjectId: projectsSlice.activeProjectId,
      currentSessionId: options?.currentSessionId,
      projectExpanded,
      worktreeExpanded,
      visibleCountByBucket,
      worktreesByProjectPath,
      worktreeOrderByProjectId,
      gitRepoByProjectId,
    });
  }, [
    gitRepoByProjectId,
    options?.currentSessionId,
    options?.runningSessionIds,
    options?.unseenBySession,
    options?.untitledLabel,
    projectExpanded,
    projectsSlice.activeProjectId,
    projectsSlice.projects,
    snapshot,
    status,
    visibleCountByBucket,
    worktreeExpanded,
    worktreeOrderByProjectId,
    worktreesByProjectPath,
  ]);

  const setProjectExpanded = useCallback((projectId: string, expanded: boolean) => {
    setProjectExpandedMap((prev) =>
      prev[projectId] === expanded ? prev : { ...prev, [projectId]: expanded },
    );
  }, []);

  const setWorktreeExpanded = useCallback(
    (projectId: string, bucketKey: string, expanded: boolean) => {
      const key = `${projectId}::${bucketKey}`;
      setWorktreeExpandedMap((prev) =>
        prev[key] === expanded ? prev : { ...prev, [key]: expanded },
      );
    },
    [],
  );

  const showMoreBucket = useCallback((projectId: string, bucketKey: string) => {
    const key = `${projectId}::${bucketKey}`;
    setVisibleCountByBucket((prev) => {
      const next = new Map(prev);
      const current = next.get(key) ?? resetBucketVisibleCount();
      next.set(key, nextBucketVisibleCount(current));
      return next;
    });
  }, []);

  const showFewerBucket = useCallback((projectId: string, bucketKey: string) => {
    const key = `${projectId}::${bucketKey}`;
    setVisibleCountByBucket((prev) => {
      const next = new Map(prev);
      next.set(key, resetBucketVisibleCount());
      return next;
    });
  }, []);

  const replaceProjects = useCallback((slice: ProjectsSettingsSlice) => {
    setProjectsSlice(slice);
  }, []);

  const saveProjects = useCallback(
    async (next: ProjectEntry[], activeProjectId?: string | null) => {
      if (!active) {
        const slice = {
          projects: next,
          activeProjectId: activeProjectId ?? projectsSlice.activeProjectId,
        };
        setProjectsSlice(slice);
        return slice;
      }
      const saved = await putProjectsSettings(active, {
        projects: next,
        activeProjectId: activeProjectId === undefined ? projectsSlice.activeProjectId : activeProjectId,
      });
      setProjectsSlice(saved);
      return saved;
    },
    [active, projectsSlice.activeProjectId],
  );

  return {
    status,
    model,
    snapshot,
    projects: projectsSlice.projects,
    activeProjectId: projectsSlice.activeProjectId,
    error,
    refresh,
    setProjectExpanded,
    setWorktreeExpanded,
    showMoreBucket,
    showFewerBucket,
    replaceProjects,
    saveProjects,
    worktreesByProjectPath,
    refreshProjectWorktrees,
    probeGitRepo,
    gitRepoByProjectId,
  };
}
