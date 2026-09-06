import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConnection } from '@/context/ConnectionContext';
import { loadProjectsSettings, type ProjectEntry } from '@/lib/projectsSettingsApi';
import {
  buildScheduledTaskCards,
  type ScheduledTaskCardModel,
  type WorkspaceFilter,
  type WorkspaceView,
} from '@/lib/scheduledModel';
import {
  deleteScheduledTask,
  fetchGlobalScheduledTasks,
  fetchScheduledTaskRuns,
  patchTaskRunning,
  replaceProjectTasks,
  runScheduledTaskNow,
  upsertScheduledTask,
  type GlobalScheduledTask,
  type GlobalScheduledTasksResponse,
  type ScheduledTask,
  type ScheduledTaskRun,
} from '@/lib/scheduledTasksApi';

export type ScheduledStatus = 'idle' | 'loading' | 'ready' | 'error';

export type TaskIdentity = { projectId: string; taskId: string };

export type ScheduledWorkspaceState = {
  status: ScheduledStatus;
  error: string | null;
  tasks: GlobalScheduledTask[];
  failedProjectIds: string[];
  cards: ScheduledTaskCardModel[];
  runs: ScheduledTaskRun[];
  runsLoading: boolean;
  runsError: string | null;
  runsComplete: boolean;
  runsNextCursor: string | null;
  view: WorkspaceView;
  filter: WorkspaceFilter;
  search: string;
  projects: ProjectEntry[];
  activeProjectId: string | null;
  createProjectId: string;
  editorMode: 'closed' | 'create' | 'edit';
  selected: TaskIdentity | null;
  selectedEntry: GlobalScheduledTask | null;
  historyTaskFilter: TaskIdentity | null;
  historyFilterLabel: string | null;
  mutatingKey: string | null;
  toast: string | null;
  refresh: () => Promise<void>;
  refreshRuns: (reset?: boolean) => Promise<void>;
  loadMoreRuns: () => Promise<void>;
  setView: (view: WorkspaceView) => void;
  setFilter: (filter: WorkspaceFilter) => void;
  setSearch: (search: string) => void;
  setCreateProjectId: (id: string) => void;
  openCreate: () => void;
  openEdit: (entry: GlobalScheduledTask) => void;
  closeEditor: () => void;
  openTaskHistory: (entry: GlobalScheduledTask) => void;
  clearHistoryTaskFilter: () => void;
  runNow: (entry: GlobalScheduledTask) => Promise<void>;
  toggleEnabled: (entry: GlobalScheduledTask, enabled: boolean) => Promise<void>;
  saveTask: (draft: Partial<ScheduledTask>) => Promise<ScheduledTask | null>;
  removeTask: (entry: GlobalScheduledTask) => Promise<void>;
  clearToast: () => void;
};

const identityKey = (id: TaskIdentity | null): string | null =>
  id ? `${id.projectId}:${id.taskId}` : null;

/**
 * Live Scheduled workspace: global tasks + history runs + CRUD/run mutations.
 * Failure stays in `error` — never coerces to empty success.
 */
export function useScheduledWorkspace(): ScheduledWorkspaceState {
  const { state } = useConnection();
  const active = state.active;
  const [status, setStatus] = useState<ScheduledStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<GlobalScheduledTasksResponse | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [createProjectId, setCreateProjectId] = useState('');
  const [view, setViewState] = useState<WorkspaceView>('tasks');
  const [filter, setFilter] = useState<WorkspaceFilter>('all');
  const [search, setSearch] = useState('');
  const [editorMode, setEditorMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [selected, setSelected] = useState<TaskIdentity | null>(null);
  const [historyTaskFilter, setHistoryTaskFilter] = useState<TaskIdentity | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsComplete, setRunsComplete] = useState(true);
  const [runsNextCursor, setRunsNextCursor] = useState<string | null>(null);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestId = useRef(0);
  const runsRequestId = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (!active) {
      setStatus('idle');
      setPayload(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      const [next, settings] = await Promise.all([
        fetchGlobalScheduledTasks(active),
        loadProjectsSettings(active).catch(() => ({ projects: [] as ProjectEntry[], activeProjectId: null })),
      ]);
      if (id !== requestId.current) return;
      setPayload(next);
      setProjects(settings.projects);
      setActiveProjectId(settings.activeProjectId);
      const preferred =
        settings.activeProjectId && settings.projects.some((p) => p.id === settings.activeProjectId)
          ? settings.activeProjectId
          : settings.projects[0]?.id || '';
      setCreateProjectId((prev) =>
        prev && settings.projects.some((p) => p.id === prev) ? prev : preferred,
      );
      setStatus('ready');
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [active]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshRuns = useCallback(
    async (reset = true) => {
      if (!active || view !== 'history') return;
      const id = ++runsRequestId.current;
      setRunsLoading(true);
      setRunsError(null);
      try {
        const page = await fetchScheduledTaskRuns(active, {
          limit: 20,
          ...(historyTaskFilter
            ? { projectId: historyTaskFilter.projectId, taskId: historyTaskFilter.taskId }
            : {}),
        });
        if (id !== runsRequestId.current) return;
        setRuns(page.runs);
        setRunsNextCursor(page.nextCursor);
        setRunsComplete(page.complete);
      } catch (err) {
        if (id !== runsRequestId.current) return;
        if (reset) setRuns([]);
        setRunsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === runsRequestId.current) setRunsLoading(false);
      }
    },
    [active, historyTaskFilter, view],
  );

  useEffect(() => {
    if (view === 'history') void refreshRuns(true);
  }, [view, historyTaskFilter, refreshRuns]);

  const loadMoreRuns = useCallback(async () => {
    if (!active || !runsNextCursor || runsComplete || runsLoading) return;
    const id = ++runsRequestId.current;
    setRunsLoading(true);
    setRunsError(null);
    try {
      const page = await fetchScheduledTaskRuns(active, {
        before: runsNextCursor,
        limit: 20,
        ...(historyTaskFilter
          ? { projectId: historyTaskFilter.projectId, taskId: historyTaskFilter.taskId }
          : {}),
      });
      if (id !== runsRequestId.current) return;
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const merged = [...prev];
        for (const run of page.runs) {
          if (seen.has(run.id)) continue;
          seen.add(run.id);
          merged.push(run);
        }
        return merged;
      });
      setRunsNextCursor(page.nextCursor);
      setRunsComplete(page.complete);
    } catch (err) {
      if (id !== runsRequestId.current) return;
      setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === runsRequestId.current) setRunsLoading(false);
    }
  }, [active, historyTaskFilter, runsComplete, runsLoading, runsNextCursor]);

  const tasks = useMemo(() => payload?.tasks ?? [], [payload]);
  const failedProjectIds = payload?.failedProjectIds ?? [];
  const cards = useMemo(
    () => buildScheduledTaskCards(tasks, filter, search, nowMs),
    [tasks, filter, search, nowMs],
  );

  const selectedEntry = useMemo(() => {
    if (!selected) return null;
    return (
      tasks.find(
        (entry) => entry.projectId === selected.projectId && entry.task.id === selected.taskId,
      ) ?? null
    );
  }, [selected, tasks]);

  const historyFilterLabel = useMemo(() => {
    if (!historyTaskFilter) return null;
    const entry = tasks.find(
      (e) => e.projectId === historyTaskFilter.projectId && e.task.id === historyTaskFilter.taskId,
    );
    if (entry?.task.name) return entry.task.name;
    return (
      runs.find(
        (r) => r.projectId === historyTaskFilter.projectId && r.taskId === historyTaskFilter.taskId,
      )?.taskName || historyTaskFilter.taskId
    );
  }, [historyTaskFilter, runs, tasks]);

  const setView = useCallback((next: WorkspaceView) => {
    setEditorMode('closed');
    setSelected(null);
    setHistoryTaskFilter(null);
    setViewState(next);
  }, []);

  const openCreate = useCallback(() => {
    setSelected(null);
    setEditorMode('create');
  }, []);

  const openEdit = useCallback((entry: GlobalScheduledTask) => {
    setSelected({ projectId: entry.projectId, taskId: entry.task.id });
    setEditorMode('edit');
  }, []);

  const closeEditor = useCallback(() => {
    setSelected(null);
    setEditorMode('closed');
  }, []);

  const openTaskHistory = useCallback((entry: GlobalScheduledTask) => {
    setSelected(null);
    setEditorMode('closed');
    setHistoryTaskFilter({ projectId: entry.projectId, taskId: entry.task.id });
    setViewState('history');
  }, []);

  const clearHistoryTaskFilter = useCallback(() => setHistoryTaskFilter(null), []);

  const runNow = useCallback(
    async (entry: GlobalScheduledTask) => {
      if (!active) return;
      const key = `${entry.projectId}:${entry.task.id}`;
      setMutatingKey(key);
      // Optimistic running — Cap MobileScheduledTab parity for in-progress from start.
      setPayload((prev) => patchTaskRunning(prev, entry.projectId, entry.task.id));
      try {
        await runScheduledTaskNow(active, entry.projectId, entry.task.id);
        setToast('sessions.scheduledTasks.dialog.toast.started');
        await refresh();
        if (view === 'history') await refreshRuns(true);
      } catch (err) {
        setToast(err instanceof Error ? err.message : 'sessions.scheduledTasks.dialog.toast.runFailed');
        await refresh();
      } finally {
        setMutatingKey(null);
      }
    },
    [active, refresh, refreshRuns, view],
  );

  const toggleEnabled = useCallback(
    async (entry: GlobalScheduledTask, enabled: boolean) => {
      if (!active) return;
      const key = `${entry.projectId}:${entry.task.id}`;
      setMutatingKey(key);
      const optimisticTask = { ...entry.task, enabled };
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              tasks: prev.tasks.map((item) =>
                item.projectId === entry.projectId && item.task.id === entry.task.id
                  ? { projectId: entry.projectId, task: optimisticTask }
                  : item,
              ),
            }
          : prev,
      );
      try {
        const nextTasks = await upsertScheduledTask(active, entry.projectId, optimisticTask);
        setPayload((prev) => replaceProjectTasks(prev, entry.projectId, nextTasks));
      } catch (err) {
        setToast(
          err instanceof Error ? err.message : 'sessions.scheduledTasks.dialog.toast.updateFailed',
        );
        await refresh();
      } finally {
        setMutatingKey(null);
      }
    },
    [active, refresh],
  );

  const saveTask = useCallback(
    async (draft: Partial<ScheduledTask>): Promise<ScheduledTask | null> => {
      if (!active) return null;
      const projectID = selected?.projectId || createProjectId;
      if (!projectID) throw new Error('sessions.scheduledTasks.dialog.error.chooseProjectFirst');
      const previousIDs = new Set(
        tasks.filter((e) => e.projectId === projectID).map((e) => e.task.id),
      );
      const nextTasks = await upsertScheduledTask(active, projectID, draft);
      setPayload((prev) => replaceProjectTasks(prev, projectID, nextTasks));
      const savedTask = draft.id
        ? nextTasks.find((task) => task.id === draft.id)
        : nextTasks.find((task) => !previousIDs.has(task.id));
      const fallbackTask = [...nextTasks]
        .filter((task) => task.name === draft.name)
        .sort((a, b) => (b.state?.updatedAt || 0) - (a.state?.updatedAt || 0))[0];
      const nextSelected = savedTask || fallbackTask || null;
      if (nextSelected) {
        setSelected({ projectId: projectID, taskId: nextSelected.id });
        setEditorMode('edit');
      }
      setToast('sessions.scheduledTasks.dialog.toast.saved');
      return nextSelected;
    },
    [active, createProjectId, selected, tasks],
  );

  const removeTask = useCallback(
    async (entry: GlobalScheduledTask) => {
      if (!active) return;
      const key = `${entry.projectId}:${entry.task.id}`;
      setMutatingKey(key);
      try {
        const nextTasks = await deleteScheduledTask(active, entry.projectId, entry.task.id);
        setPayload((prev) => replaceProjectTasks(prev, entry.projectId, nextTasks));
        if (identityKey(selected) === key) {
          setSelected(null);
          setEditorMode('closed');
        }
        setToast('sessions.scheduledTasks.dialog.toast.deleted');
      } catch (err) {
        setToast(
          err instanceof Error ? err.message : 'sessions.scheduledTasks.dialog.toast.deleteFailed',
        );
      } finally {
        setMutatingKey(null);
      }
    },
    [active, selected],
  );

  return {
    status,
    error,
    tasks,
    failedProjectIds,
    cards,
    runs,
    runsLoading,
    runsError,
    runsComplete,
    runsNextCursor,
    view,
    filter,
    search,
    projects,
    activeProjectId,
    createProjectId,
    editorMode,
    selected,
    selectedEntry,
    historyTaskFilter,
    historyFilterLabel,
    mutatingKey,
    toast,
    refresh,
    refreshRuns,
    loadMoreRuns,
    setView,
    setFilter,
    setSearch,
    setCreateProjectId,
    openCreate,
    openEdit,
    closeEditor,
    openTaskHistory,
    clearHistoryTaskFilter,
    runNow,
    toggleEnabled,
    saveTask,
    removeTask,
    clearToast: () => setToast(null),
  };
}
