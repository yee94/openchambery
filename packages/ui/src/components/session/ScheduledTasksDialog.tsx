import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { cn, formatDirectoryName } from '@/lib/utils';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import {
  deleteScheduledTask,
  fetchGlobalScheduledTasks,
  fetchScheduledTaskRuns,
  type GlobalScheduledTask,
  type GlobalScheduledTasksResponse,
  runScheduledTaskNow,
  upsertScheduledTask,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskStatus,
} from '@/lib/scheduledTasksApi';
import { ScheduledTaskEditorDialog } from './ScheduledTaskEditorDialog';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { useMobileBackRoute } from '@/mobile/mobileBackNavigation';
import { MobileTabPageHeader } from '@/mobile/MobileTabPageHeader';
import { openSessionWithFeedback } from '@/sync/openSessionWithFeedback';
import { isIPadApp } from '@/lib/platform';
import { parseRoute, updateBrowserURL } from '@/lib/router';

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  const valid = raw.filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

const formatSchedule = (
  task: ScheduledTask,
  t: ReturnType<typeof useI18n>['t'],
  includeTimezone = true,
): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  const formatWeekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (task.schedule.kind === 'daily') {
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (task.schedule.kind === 'once') {
    const date = typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
      ? task.schedule.date
      : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
      ? task.schedule.time
      : '--:--';
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (includeTimezone && task.schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: task.schedule.cron || '',
      timezone: task.schedule.timezone,
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron || '' });
};

const formatRelativeTime = (value: number | undefined, t: ReturnType<typeof useI18n>['t']): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute') : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: m })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: m });
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
};

/** History list timestamps — compact enough for mobile cards without ellipsis. */
const formatRunDateTime = (value: number): string => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(value));

/** Prefer wall-clock span when finished; live elapsed while running. */
const resolveRunDurationMs = (run: ScheduledTaskRun, nowMs: number): number | null => {
  if (run.status === 'running') {
    return Math.max(0, nowMs - run.startedAt);
  }
  if (typeof run.finishedAt === 'number' && Number.isFinite(run.finishedAt)) {
    const wallMs = Math.max(0, run.finishedAt - run.startedAt);
    if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
      // Prefer the longer span so a short dispatch sample never under-reports
      // a later finishAt from state/history convergence.
      return Math.max(run.durationMs, wallMs);
    }
    return wallMs;
  }
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
    return run.durationMs;
  }
  return null;
};

/**
 * Compact wall-clock duration beside status (e.g. 12s, 2m 50s, 1h 2m).
 * Units are symbols shared with goal-strip duration; no prose labels.
 */
const formatCompactRunDuration = (durationMs: number | null): string | null => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return '<1s';
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

type StatusTone = 'success' | 'error' | 'warning' | 'muted';

const STATUS_META: Record<
  ScheduledTaskStatus,
  {
    tone: StatusTone;
    Icon: IconName;
    spin?: boolean;
  }
> = {
  success: { tone: 'success', Icon: 'checkbox-circle' },
  error: { tone: 'error', Icon: 'error-warning' },
  running: { tone: 'warning', Icon: 'loader-4', spin: true },
  idle: { tone: 'muted', Icon: 'pulse' },
};

const toneStyle = (tone: StatusTone): React.CSSProperties => {
  if (tone === 'muted') {
    return {};
  }
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-background)`,
    borderColor: `var(--status-${tone}-border)`,
  };
};

type TaskIdentity = { projectId: string; taskId: string };

const taskIdentityKey = ({ projectId, taskId }: TaskIdentity) => `${projectId}:${taskId}`;
const globalScheduledTasksQueryKey = queryKeys.scoped('scheduled-tasks');
const globalScheduledTaskRunsQueryKey = queryKeys.scoped('scheduled-task-runs');

let mobileCloseRequest: (() => boolean) | null = null;

const requestScheduledTasksDialogClose = (): boolean => {
  if (mobileCloseRequest) return mobileCloseRequest();
  useUIStore.getState().setScheduledTasksDialogOpen(false);
  return true;
};

const replaceProjectTasks = (
  current: GlobalScheduledTasksResponse | undefined,
  projectId: string,
  tasks: ScheduledTask[],
): GlobalScheduledTasksResponse => ({
  tasks: [
    ...(current?.tasks.filter((entry) => entry.projectId !== projectId) ?? []),
    ...tasks.map((task) => ({ projectId, task })),
  ],
  failedProjectIds: current?.failedProjectIds.filter((id) => id !== projectId) ?? [],
});

export function ScheduledTasksDialog() {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  if (!isMobile) return null;

  return (
    <MobileOverlayPanel
      open={open}
      title={t('sessions.scheduledTasks.dialog.title')}
      onClose={() => requestScheduledTasksDialogClose()}
      className="h-[min(92dvh,760px)] max-w-none sm:max-w-2xl"
      contentMaxHeightClassName="max-h-none"
      renderHeader={() => null}
      containedBody
    >
      <ScheduledTasksWorkspace presentation="mobile-panel" open={open} onOpenChange={setOpen} />
    </MobileOverlayPanel>
  );
}

type WorkspaceFilter = 'all' | 'active' | 'paused';
type WorkspaceEditorMode = 'closed' | 'create' | 'edit';
type WorkspaceView = 'tasks' | 'history';

export function ScheduledTasksWorkspace({
  presentation = 'workspace',
  open = true,
  onOpenChange,
  registerEditorBackHandler,
  onEditorActiveChange,
}: {
  presentation?: 'workspace' | 'mobile-panel' | 'mobile-tab';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Tab-mode Android back: when the editor is open, cancel it (with dirty-draft
   * confirm) and return true. Host owns the back chain; tab mode must not also
   * listen for the global dialog close event.
   */
  registerEditorBackHandler?: (handler: (() => boolean) | null) => void;
  /** Lets the root mobile tab hand its large title to the detail screen. */
  onEditorActiveChange?: (active: boolean) => void;
} = {}) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const isMobile = useUIStore((state) => state.isMobile);
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const preferredProjectID = activeProject?.id || projects[0]?.id || '';
  const [createProjectID, setCreateProjectID] = React.useState(preferredProjectID);
  const [selectedTaskIdentity, setSelectedTaskIdentity] = React.useState<TaskIdentity | null>(null);
  const [editorMode, setEditorMode] = React.useState<WorkspaceEditorMode>('closed');
  const [filter, setFilter] = React.useState<WorkspaceFilter>('all');
  const [workspaceView, setWorkspaceView] = React.useState<WorkspaceView>(() => {
    const route = parseRoute();
    return route.scheduleView === 'history' ? 'history' : 'tasks';
  });
  const [search, setSearch] = React.useState('');
  const [draftDirty, setDraftDirty] = React.useState(false);
  const [mutatingTaskIdentity, setMutatingTaskIdentity] = React.useState<string | null>(null);
  const [contextMenuTaskIdentity, setContextMenuTaskIdentity] = React.useState<string | null>(null);
  const [dropdownMenuTaskIdentity, setDropdownMenuTaskIdentity] = React.useState<string | null>(null);
  const [historyTaskFilter, setHistoryTaskFilter] = React.useState<TaskIdentity | null>(null);
  const mobileNavigationSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const mobileNavigationUnderlayRef = React.useRef<HTMLDivElement | null>(null);
  // `mobile-tab` shares the mobile layout but is hosted as a root tab page:
  // no panel header (the tab supplies its own large-title header) and no
  // close/back wiring against the dialog open flag.
  const isMobileTab = presentation === 'mobile-tab';
  const isMobilePanel = presentation === 'mobile-panel' || isMobileTab;

  React.useEffect(() => {
    if (!isMobileTab) return;
    onEditorActiveChange?.(editorMode !== 'closed');
    return () => onEditorActiveChange?.(false);
  }, [editorMode, isMobileTab, onEditorActiveChange]);

  // Path → UI: when deep-linked to /schedule/history (or browser back), mirror view.
  React.useEffect(() => {
    if (!open) return;
    const onPop = () => {
      const route = parseRoute();
      if (route.tab === 'schedule' || useUIStore.getState().activeMainTab === 'schedule') {
        const next = route.scheduleView === 'history' ? 'history' : 'tasks';
        setWorkspaceView((prev) => (prev === next ? prev : next));
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  React.useEffect(() => {
    if (projects.some((project) => project.id === createProjectID)) return;
    setCreateProjectID(preferredProjectID);
  }, [createProjectID, preferredProjectID, projects]);

  const tasksQuery = useQuery({
    queryKey: globalScheduledTasksQueryKey,
    enabled: open,
    refetchOnMount: 'always',
    queryFn: fetchGlobalScheduledTasks,
    select: (response) => ({
      ...response,
      tasks: [...response.tasks].sort((a, b) => {
        if (a.task.enabled !== b.task.enabled) {
          return a.task.enabled ? -1 : 1;
        }
        return a.task.name.localeCompare(b.task.name);
      }),
    }),
  });
  const tasks = React.useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data]);
  const failedProjectIds = tasksQuery.data?.failedProjectIds ?? [];
  const selectedTaskEntry = React.useMemo(
    () => selectedTaskIdentity
      ? tasks.find(({ projectId, task }) => projectId === selectedTaskIdentity.projectId && task.id === selectedTaskIdentity.taskId) ?? null
      : null,
    [selectedTaskIdentity, tasks],
  );
  const selectedTask = selectedTaskEntry?.task ?? null;
  const runsQuery = useInfiniteQuery({
    queryKey: [...globalScheduledTaskRunsQueryKey, historyTaskFilter?.projectId ?? '', historyTaskFilter?.taskId ?? ''],
    enabled: open && workspaceView === 'history',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchScheduledTaskRuns({
      before: pageParam,
      limit: 20,
      ...(historyTaskFilter
        ? { projectId: historyTaskFilter.projectId, taskId: historyTaskFilter.taskId }
        : {}),
    }, signal),
    getNextPageParam: (lastPage) => lastPage.complete ? undefined : lastPage.nextCursor ?? undefined,
    refetchOnMount: 'always',
  });
  const runs = React.useMemo(() => {
    const seen = new Set<string>();
    const result: ScheduledTaskRun[] = [];
    for (const page of runsQuery.data?.pages ?? []) {
      for (const run of page.runs) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        result.push(run);
      }
    }
    return result;
  }, [runsQuery.data]);
  const hasRunningRuns = React.useMemo(() => runs.some((run) => run.status === 'running'), [runs]);
  const historyFilterLabel = React.useMemo(() => {
    if (!historyTaskFilter) return null;
    const entry = tasks.find(({ projectId, task }) => (
      projectId === historyTaskFilter.projectId && task.id === historyTaskFilter.taskId
    ));
    if (entry?.task.name) return entry.task.name;
    const runName = runs.find((run) => (
      run.projectId === historyTaskFilter.projectId && run.taskId === historyTaskFilter.taskId
    ))?.taskName;
    return runName || historyTaskFilter.taskId;
  }, [historyTaskFilter, runs, tasks]);
  // Wall-clock tick so running history rows advance elapsed duration without
  // waiting for the next scheduled-task-ran event.
  const [historyNowMs, setHistoryNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!open || workspaceView !== 'history' || !hasRunningRuns) {
      return undefined;
    }
    setHistoryNowMs(Date.now());
    const timerID = window.setInterval(() => setHistoryNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timerID);
  }, [hasRunningRuns, open, workspaceView]);
  const projectById = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  React.useEffect(() => {
    if (tasksQuery.error) {
      toast.error(tasksQuery.error instanceof Error ? tasksQuery.error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed'));
    }
  }, [tasksQuery.error, t]);

  React.useEffect(() => {
    let timeoutID: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') {
        return;
      }
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      timeoutID = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: globalScheduledTasksQueryKey, exact: true });
        void queryClient.invalidateQueries({ queryKey: globalScheduledTaskRunsQueryKey });
      }, 400);
    });
    return () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (editorMode === 'edit' && selectedTaskIdentity && !selectedTaskEntry && tasksQuery.isSuccess) {
      setSelectedTaskIdentity(null);
      setEditorMode('closed');
    }
  }, [editorMode, selectedTaskEntry, selectedTaskIdentity, tasksQuery.isSuccess]);

  const saveTaskMutation = useMutation({
    mutationFn: ({ projectID, taskDraft }: { projectID: string; taskDraft: Partial<ScheduledTask> }) => upsertScheduledTask(projectID, taskDraft),
    onSuccess: (nextTasks, { projectID }) => {
      queryClient.setQueryData<GlobalScheduledTasksResponse>(globalScheduledTasksQueryKey, (current) => replaceProjectTasks(current, projectID, nextTasks));
    },
  });
  const deleteTaskMutation = useMutation({
    mutationFn: ({ projectID, taskID }: { projectID: string; taskID: string }) => deleteScheduledTask(projectID, taskID),
    onSuccess: (nextTasks, { projectID }) => {
      queryClient.setQueryData<GlobalScheduledTasksResponse>(globalScheduledTasksQueryKey, (current) => replaceProjectTasks(current, projectID, nextTasks));
    },
  });
  const runTaskMutation = useMutation({
    mutationFn: ({ projectID, taskID }: { projectID: string; taskID: string }) => runScheduledTaskNow(projectID, taskID),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: globalScheduledTasksQueryKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: globalScheduledTaskRunsQueryKey });
    },
  });
  const toggleTaskMutation = useMutation({
    mutationFn: ({ projectID, task }: { projectID: string; task: ScheduledTask }) => upsertScheduledTask(projectID, task),
    onMutate: ({ projectID, task }) => {
      const previousTasks = queryClient.getQueryData<GlobalScheduledTasksResponse>(globalScheduledTasksQueryKey);
      queryClient.setQueryData<GlobalScheduledTasksResponse>(globalScheduledTasksQueryKey, (current) => current ? {
        ...current,
        tasks: current.tasks.map((item) => item.projectId === projectID && item.task.id === task.id ? { projectId: projectID, task } : item),
      } : current);
      return { previousTasks };
    },
    onSuccess: (nextTasks, { projectID }) => {
      queryClient.setQueryData<GlobalScheduledTasksResponse>(globalScheduledTasksQueryKey, (current) => replaceProjectTasks(current, projectID, nextTasks));
    },
    onError: (_error, _variables, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(globalScheduledTasksQueryKey, context.previousTasks);
      }
    },
  });

  const confirmDraftChange = useEvent(() => (
    !draftDirty || window.confirm(t('sessions.scheduledTasks.workspace.confirm.discardChanges'))
 ));

  React.useEffect(() => {
    if (!draftDirty) {
      setMainTabGuard(null);
      return;
    }
    const guard = (nextTab: MainTab) => (
      nextTab === 'schedule' || window.confirm(t('sessions.scheduledTasks.workspace.confirm.discardChanges'))
    );
    setMainTabGuard(guard);
    return () => {
      if (useUIStore.getState().mainTabGuard === guard) {
        setMainTabGuard(null);
      }
    };
  }, [draftDirty, setMainTabGuard, t]);

  const handleSelectTask = useEvent((entry: GlobalScheduledTask) => {
    const identity = { projectId: entry.projectId, taskId: entry.task.id };
    if (taskIdentityKey(identity) === (selectedTaskIdentity ? taskIdentityKey(selectedTaskIdentity) : '') && editorMode === 'edit') {
      return;
    }
    if (!confirmDraftChange()) {
      return;
    }
    setSelectedTaskIdentity(identity);
    setEditorMode('edit');
    setDraftDirty(false);
  });

  const handleCreate = useEvent(() => {
    if (!createProjectID || !confirmDraftChange()) {
      return;
    }
    setSelectedTaskIdentity(null);
    setEditorMode('create');
    setDraftDirty(false);
  });

  const syncScheduledPath = useEvent((nextView: WorkspaceView, task?: { projectId: string; taskId: string } | null) => {
    const ui = useUIStore.getState();
    // Schedule is a top-level primary — never /session/$id/schedule
    updateBrowserURL({
      sessionId: null,
      tab: 'schedule',
      isSettingsOpen: ui.isSettingsDialogOpen,
      settingsPath: ui.settingsPage,
      diffFile: null,
      scheduleView: nextView,
      scheduleProjectId: task?.projectId ?? null,
      scheduleTaskId: task?.taskId ?? null,
    });
  });

  const handleWorkspaceViewChange = useEvent((nextView: WorkspaceView) => {
    if (workspaceView === nextView) return;
    if (editorMode !== 'closed' && !confirmDraftChange()) return;
    setSelectedTaskIdentity(null);
    setEditorMode('closed');
    setDraftDirty(false);
    setHistoryTaskFilter(null);
    setWorkspaceView(nextView);
    syncScheduledPath(nextView, null);
  });

  const handleOpenSession = useEvent((sessionId: string | null | undefined, directory: string | null | undefined) => {
    // Missing session id or workspace path: toast "unable to load conversation …"
    // — never open under the wrong current project cwd.
    if (presentation === 'mobile-panel' && sessionId && directory) {
      onOpenChange?.(false);
    }
    openSessionWithFeedback(sessionId, directory, {
      phoneShell: Boolean(isMobilePanel && !isIPadApp()),
      switchToChat: true,
    });
  });

  const handleOpenRunSession = useEvent((run: ScheduledTaskRun) => {
    handleOpenSession(run.sessionId, run.directory);
  });

  const handleOpenTaskHistory = useEvent((entry: GlobalScheduledTask) => {
    if (editorMode !== 'closed' && !confirmDraftChange()) {
      return;
    }
    setSelectedTaskIdentity(null);
    setEditorMode('closed');
    setDraftDirty(false);
    setHistoryTaskFilter({ projectId: entry.projectId, taskId: entry.task.id });
    setWorkspaceView('history');
    syncScheduledPath('history', null);
  });

  const handleClearHistoryTaskFilter = useEvent(() => {
    setHistoryTaskFilter(null);
  });

  const handleEditorOpenTaskHistory = useEvent(() => {
    if (selectedTaskEntry) {
      handleOpenTaskHistory(selectedTaskEntry);
    }
  });

  const handleRetryRuns = useEvent(async () => {
    if (runsQuery.data && runsQuery.hasNextPage) {
      await runsQuery.fetchNextPage();
      return;
    }
    await runsQuery.refetch();
  });

  const handleCancelEditor = useEvent((nextOpen: boolean) => {
    if (nextOpen || !confirmDraftChange()) {
      return;
    }
    setSelectedTaskIdentity(null);
    setEditorMode('closed');
    setDraftDirty(false);
  });

  const requestClose = useEvent(() => {
    if (editorMode !== 'closed') {
      handleCancelEditor(false);
      return true;
    }
    onOpenChange?.(false);
    return true;
  });

  // Dialog / mobile-panel only: global close event is owned by the overlay path.
  // Tab mode must not double-listen — it registers via registerEditorBackHandler.
  React.useEffect(() => {
    if (presentation !== 'mobile-panel' || !open) return;
    mobileCloseRequest = requestClose;
    const handleCloseRequest = () => requestClose();
    window.addEventListener('oc:scheduled-tasks-close-request', handleCloseRequest);
    return () => {
      if (mobileCloseRequest === requestClose) mobileCloseRequest = null;
      window.removeEventListener('oc:scheduled-tasks-close-request', handleCloseRequest);
    };
    // useEvent keeps requestClose stable while open controls subscription lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation, open]);

  const handleEditorBack = useEvent(() => {
    if (editorMode !== 'closed') {
      handleCancelEditor(false);
      return true;
    }
    return false;
  });

  useMobileBackRoute({
    id: 'mobile-scheduled-editor',
    active: isMobileTab && editorMode !== 'closed',
    onBack: handleEditorBack,
    surfaceRef: mobileNavigationSurfaceRef,
    underlayRef: mobileNavigationUnderlayRef,
  });

  React.useEffect(() => {
    if (!registerEditorBackHandler) return;
    registerEditorBackHandler(handleEditorBack);
    return () => registerEditorBackHandler(null);
    // useEvent keeps handleEditorBack stable; registration identity drives lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerEditorBackHandler]);

  const handleSaveTask = useEvent(async (taskDraft: Partial<ScheduledTask>) => {
    const projectID = selectedTaskIdentity?.projectId || createProjectID;
    if (!projectID) {
      throw new Error(t('sessions.scheduledTasks.dialog.error.chooseProjectFirst'));
    }
    const previousIDs = new Set(tasks.filter((entry) => entry.projectId === projectID).map((entry) => entry.task.id));
    const nextTasks = await saveTaskMutation.mutateAsync({ projectID, taskDraft });
    const savedTask = taskDraft.id
      ? nextTasks.find((task) => task.id === taskDraft.id)
      : nextTasks.find((task) => !previousIDs.has(task.id));
    const fallbackTask = [...nextTasks]
      .filter((task) => task.name === taskDraft.name)
      .sort((a, b) => (b.state?.updatedAt || 0) - (a.state?.updatedAt || 0))[0];
    const nextSelectedTask = savedTask || fallbackTask;
    if (nextSelectedTask) {
      setSelectedTaskIdentity({ projectId: projectID, taskId: nextSelectedTask.id });
      setEditorMode('edit');
    }
    setDraftDirty(false);
    toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
    return nextSelectedTask;
  });

  const handleDeleteTask = useEvent(async (entry: GlobalScheduledTask) => {
    const { projectId, task } = entry;
    if (!window.confirm(t('sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: task.name }))) {
      return;
    }
    setMutatingTaskIdentity(taskIdentityKey({ projectId, taskId: task.id }));
    try {
      await deleteTaskMutation.mutateAsync({ projectID: projectId, taskID: task.id });
      const deletedTaskIdentity = taskIdentityKey({ projectId, taskId: task.id });
      if (selectedTaskIdentity && taskIdentityKey(selectedTaskIdentity) === deletedTaskIdentity) {
        setSelectedTaskIdentity(null);
        setEditorMode('closed');
        setDraftDirty(false);
      }
      toast.success(t('sessions.scheduledTasks.dialog.toast.deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.deleteFailed'));
    } finally {
      setMutatingTaskIdentity(null);
    }
  });

  const handleRunTask = useEvent(async ({ projectId, task }: GlobalScheduledTask) => {
    setMutatingTaskIdentity(taskIdentityKey({ projectId, taskId: task.id }));
    try {
      await runTaskMutation.mutateAsync({ projectID: projectId, taskID: task.id });
      toast.success(t('sessions.scheduledTasks.dialog.toast.started'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.runFailed'));
    } finally {
      setMutatingTaskIdentity(null);
    }
  });

  const handleToggleTask = useEvent(async ({ projectId, task }: GlobalScheduledTask, enabled: boolean) => {
    setMutatingTaskIdentity(taskIdentityKey({ projectId, taskId: task.id }));
    try {
      await toggleTaskMutation.mutateAsync({ projectID: projectId, task: { ...task, enabled } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.updateFailed'));
    } finally {
      setMutatingTaskIdentity(null);
    }
  });

  const filteredTasks = React.useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return tasks.filter(({ task }) => {
      if (filter === 'active' && !task.enabled) {
        return false;
      }
      if (filter === 'paused' && task.enabled) {
        return false;
      }
      return !normalizedSearch
        || task.name.toLocaleLowerCase().includes(normalizedSearch)
        || formatSchedule(task, t).toLocaleLowerCase().includes(normalizedSearch);
    });
  }, [filter, search, t, tasks]);

  const renderWorkspaceProjectLabel = (project: ProjectEntry) => {
    const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
    const fallback = <Icon name={iconName ?? 'folder'} className="size-3.5" style={iconColor ? { color: iconColor } : undefined} />;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden text-muted-foreground">
          {project.iconImage ? <ProjectIconImage project={project} className="size-full object-contain" fallback={fallback} /> : fallback}
        </span>
        <span className="truncate">{formatDirectoryName(project.path)}</span>
      </span>
    );
  };
  const editorProjectOptions = projects.map((project) => ({
    id: project.id,
    label: renderWorkspaceProjectLabel(project),
  }));

  return (
    <div className={cn(
      'relative flex min-h-0',
      // mobile-tab participates in MobileTabsRoot tabpanel scroll (like Projects).
      // Keep shell background transparent so the floating shell tone shows through.
      isMobileTab
        ? 'oc-mobile-scheduled-workspace w-full flex-col overflow-visible bg-transparent'
        : 'h-full overflow-hidden bg-background',
      isMobilePanel && 'flex-col',
    )} data-presentation={presentation}>
      <div
        ref={isMobileTab ? mobileNavigationUnderlayRef : undefined}
        data-mobile-navigation-underlay={isMobileTab ? 'true' : undefined}
        aria-hidden={isMobileTab && editorMode !== 'closed' ? true : undefined}
        inert={isMobileTab && editorMode !== 'closed' ? true : undefined}
        className={cn(
          isMobileTab
            // In-flow underlay: tabpanel owns safe-area/dock padding and scrollbar-none.
            // Editor back animation still targets this node via underlayRef.
            ? 'flex w-full min-w-0 flex-col gap-[var(--oc-mobile-page-gap)]'
            : 'contents',
        )}
      >
      {isMobileTab ? <MobileTabPageHeader title={t('sessions.scheduledTasks.dialog.title')} /> : null}
      {isMobilePanel && !isMobileTab ? (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/40 px-2">
          {editorMode !== 'closed' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-lg"
              onClick={requestClose}
              aria-label={t('header.actions.backAria')}
            >
              <Icon name="arrow-left" className="size-5" />
            </Button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate px-1 typography-ui-label font-semibold text-foreground">
            {editorMode === 'edit'
              ? t('sessions.scheduledTasks.editor.title.edit')
              : editorMode === 'create'
                ? t('sessions.scheduledTasks.editor.title.new')
                : t('sessions.scheduledTasks.dialog.title')}
          </h2>
          {editorMode === 'edit' && selectedTaskEntry ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 rounded-lg"
                  disabled={Boolean(mutatingTaskIdentity)}
                  aria-label={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: selectedTaskEntry.task.name })}
                >
                  <Icon name="more-2" className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem className="min-h-11" onSelect={() => void handleRunTask(selectedTaskEntry)}>
                  <Icon name="play" className="size-4" />
                  {t('sessions.scheduledTasks.dialog.actions.runNow')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  onSelect={() => handleOpenTaskHistory(selectedTaskEntry)}
                >
                  <Icon name="history" className="size-4" />
                  {t('sessions.scheduledTasks.workspace.views.history')}
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" onSelect={() => void handleToggleTask(selectedTaskEntry, !selectedTaskEntry.task.enabled)}>
                  <Icon name={selectedTaskEntry.task.enabled ? 'pause' : 'play'} className="size-4" />
                  {selectedTaskEntry.task.enabled
                    ? t('sessions.scheduledTasks.dialog.actions.pause')
                    : t('sessions.scheduledTasks.dialog.actions.resume')}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" className="min-h-11" onSelect={() => void handleDeleteTask(selectedTaskEntry)}>
                  <Icon name="delete-bin" className="size-4" />
                  {t('sessions.scheduledTasks.dialog.actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : editorMode === 'closed' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-lg"
              onClick={requestClose}
              aria-label={t('mobile.surface.closeAria')}
            >
              <Icon name="close" className="size-5" />
            </Button>
          ) : (
            <span className="size-11 shrink-0" aria-hidden="true" />
          )}
        </header>
      ) : null}
      <section className={cn(
        'min-w-0 flex-col transition-[width] duration-300 ease-out',
        // mobile-tab: natural height so the enclosing tabpanel can scroll.
        isMobileTab ? 'flex-none overflow-visible' : 'flex-1 overflow-hidden',
        isMobilePanel && !isMobileTab && editorMode !== 'closed' ? 'hidden' : 'flex',
      )}>
        <header className={cn(
          'shrink-0',
          isMobileTab ? 'pb-0 pt-0' : isMobilePanel ? 'px-3 pb-3 pt-3' : 'px-4 pb-5 pt-4 sm:px-6',
        )}>
          <div className={cn('mx-auto w-full', isMobileTab ? 'max-w-[26rem]' : 'max-w-4xl')}>
          <div
            className={cn(
              // Desktop: quiet muted track. Mobile: shared segmented track metrics
              // (pad/gap/item height) with the filter row below.
              // Tasks: denser tab→filter. History mobile-tab: no mb here so
              // content owns a single --oc-mobile-page-gap (same as Tasks filter→list).
              (workspaceView === 'tasks' || historyTaskFilter || !isMobileTab) && 'mb-3',
              isMobileTab
                ? 'oc-mobile-floating-surface oc-mobile-segmented-track'
                : 'grid grid-cols-2 gap-1 rounded-xl bg-[var(--surface-muted)] p-1',
            )}
            role="tablist"
            aria-label={t('sessions.scheduledTasks.workspace.views.aria')}
          >
            {(['tasks', 'history'] as const).map((view) => (
              <Button
                key={view}
                type="button"
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={workspaceView === view}
                className={cn(
                  isMobileTab
                    ? 'oc-mobile-segmented-item'
                    : 'relative min-h-9 rounded-lg text-muted-foreground transition-[background-color,color,box-shadow] motion-reduce:transition-none',
                  !isMobileTab && isMobilePanel && 'min-h-11',
                  !isMobileTab && (workspaceView === view
                    ? 'text-foreground hover:bg-transparent hover:text-foreground'
                    : 'hover:bg-interactive-hover/40 hover:text-foreground'),
                )}
                onClick={() => handleWorkspaceViewChange(view)}
              >
                {workspaceView === view ? (
                  <motion.span
                    layoutId="scheduled-workspace-view-pill"
                    className={cn(
                      // Mobile radius comes from .oc-mobile-segmented-item CSS vars.
                      'oc-segmented-selected-pill absolute inset-0',
                      !isMobileTab && 'rounded-lg',
                    )}
                    transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="relative z-[1] inline-flex items-center gap-1.5">
                  <Icon name={view === 'tasks' ? 'calendar-schedule' : 'history'} className="size-4 shrink-0" />
                  {t(`sessions.scheduledTasks.workspace.views.${view}`)}
                </span>
              </Button>
            ))}
          </div>
          {workspaceView === 'history' && historyFilterLabel ? (
            <div
              className={cn(
                'flex min-w-0 items-center',
                isMobileTab ? 'mt-[var(--oc-mobile-page-gap)]' : 'mt-3',
              )}
              role="status"
              aria-label={t('sessions.scheduledTasks.history.filter.aria', { name: historyFilterLabel })}
            >
              <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-[var(--surface-elevated)] py-1 pl-3 pr-1">
                <span className="min-w-0 truncate typography-meta text-foreground">{historyFilterLabel}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn('shrink-0 rounded-full', isMobilePanel ? 'size-8' : 'size-7')}
                  onClick={handleClearHistoryTaskFilter}
                  aria-label={t('sessions.scheduledTasks.history.filter.clearAria')}
                >
                  <Icon name="close" className="size-3.5" />
                </Button>
              </span>
            </div>
          ) : null}
          {workspaceView === 'tasks' ? (
          <>
          <div className={cn(
            isMobileTab
              // Same track class as the view switcher — pad/gap owned by CSS.
              ? 'oc-mobile-floating-surface oc-mobile-segmented-track oc-mobile-scheduled-controls'
              : cn('flex items-center justify-between', isMobilePanel ? 'gap-2' : 'gap-3'),
          )}>
            <div
              className={cn(
                isMobileTab
                  ? 'oc-mobile-segmented-group'
                  : cn('flex items-center gap-1', isMobilePanel && 'min-w-0 flex-1'),
              )}
              role="group"
              aria-label={t('sessions.scheduledTasks.dialog.title')}
            >
              {(['all', 'active', 'paused'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    isMobileTab
                      ? 'oc-mobile-segmented-item'
                      // Avoid overflow-hidden (mobile.css → overflow-y:auto). Soft
                      // selected-pill shadow must not be clipped on desktop either.
                      : 'relative border-0 bg-transparent text-muted-foreground shadow-none transition-[color,background-color] duration-150 ease-out motion-reduce:transition-none',
                    !isMobileTab && (isMobilePanel ? 'h-11 min-h-11 min-w-0 flex-1 rounded-xl px-2' : '!h-9 !min-h-9 rounded-xl px-3'),
                    !isMobileTab && (filter === value
                      ? 'text-foreground hover:bg-transparent hover:text-foreground'
                      : 'hover:bg-interactive-hover/40 hover:text-foreground'),
                  )}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {filter === value ? (
                    <motion.span
                      layoutId="scheduled-task-filter-pill"
                      className={cn(
                        // Mobile radius comes from .oc-mobile-segmented-item CSS vars.
                        'oc-segmented-selected-pill absolute inset-0',
                        !isMobileTab && 'rounded-xl',
                      )}
                      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="relative z-[1]">{t(`sessions.scheduledTasks.workspace.filters.${value}`)}</span>
                </Button>
              ))}
            </div>
            {isMobileTab ? (
              <Button
                variant="ghost"
                data-mobile-press-feedback="compact"
                className="oc-mobile-segmented-action shrink-0 bg-foreground text-background transition-[background-color,box-shadow] duration-150 ease-out hover:bg-foreground/90 hover:text-background hover:shadow-sm active:bg-interactive-active motion-reduce:transition-none"
                onClick={handleCreate}
                disabled={!createProjectID}
                aria-label={t('sessions.scheduledTasks.dialog.actions.create')}
              >
                <Icon name="add" className="size-4" />
              </Button>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  variant="ghost"
                  data-mobile-press-feedback={isMobilePanel ? 'compact' : undefined}
                  className={cn(
                    'shrink-0 rounded-full bg-foreground text-background transition-[background-color,box-shadow] duration-150 ease-out hover:bg-foreground/90 hover:text-background hover:shadow-sm active:bg-interactive-active motion-reduce:transition-none',
                    isMobilePanel ? 'size-11 min-h-11 px-0 min-[400px]:w-auto min-[400px]:px-3.5' : '!h-9 !min-h-9 px-3.5',
                  )}
                  onClick={handleCreate}
                  disabled={!createProjectID}
                  aria-label={t('sessions.scheduledTasks.dialog.actions.create')}
                >
                  <Icon name="add" className="h-4 w-4" /> <span className={cn(isMobilePanel && 'hidden min-[400px]:inline')}>{t('sessions.scheduledTasks.dialog.actions.create')}</span>
                </Button>
              </div>
            )}
          </div>
          {!isMobileTab ? (
            <div className={cn('group relative w-full', isMobilePanel ? 'mt-3' : 'mt-7')}>
              <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-[color,transform] duration-150 ease-out group-focus-within:scale-105 group-focus-within:text-foreground motion-reduce:transition-none" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('sessions.scheduledTasks.workspace.search.placeholder')}
                className={cn(
                  'rounded-full bg-[var(--surface-elevated)] pl-10 pr-4 ring-1 ring-inset ring-border/50 transition-[background-color,box-shadow,color] duration-200 ease-out hover:[&:not(:focus)]:ring-border focus:bg-[var(--surface-elevated)] focus:shadow-sm focus:ring-2 focus:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
                  isMobilePanel ? 'h-11 min-h-11' : '!h-9 !min-h-9',
                )}
              />
            </div>
          ) : null}
          </>
          ) : null}
          </div>
        </header>

        <div className={cn(
          isMobileTab
            // No nested scroll region: tabpanel is the only vertical scroller.
            // One page-gap after tab (History) or after filter row (Tasks).
            ? 'flex-none overflow-visible pt-[var(--oc-mobile-page-gap)]'
            : 'min-h-0 flex-1 overflow-y-auto',
          !isMobileTab && (isMobilePanel
            ? 'overscroll-none px-3 pb-[max(1rem,env(safe-area-inset-bottom))]'
            : 'px-6 pb-6 [scrollbar-gutter:stable]'),
        )}>
          <div className={cn(
            'mx-auto w-full',
            isMobileTab ? 'max-w-[26rem]' : 'max-w-4xl border-t border-border/40 pt-4',
          )}>
          {workspaceView === 'history' ? (
            <div className="space-y-3">
              {runsQuery.isLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 typography-meta text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" />
                  {t('sessions.scheduledTasks.history.loading')}
                </div>
              ) : runsQuery.error && runs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-4">
                  <div className="flex items-start gap-3">
                    <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
                    <div className="min-w-0 flex-1">
                      <p className="typography-ui-label font-medium text-foreground">{t('sessions.scheduledTasks.history.error.title')}</p>
                      <p className="mt-1 break-words typography-meta text-muted-foreground">
                        {runsQuery.error instanceof Error ? runsQuery.error.message : t('sessions.scheduledTasks.history.error.description')}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void handleRetryRuns()}>
                      {t('sessions.scheduledTasks.history.retry')}
                    </Button>
                  </div>
                </div>
              ) : runs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center">
                  <Icon name="history" className="mx-auto size-5 text-muted-foreground" />
                  <p className="mt-2 typography-ui-label font-medium text-foreground">{t('sessions.scheduledTasks.history.empty.title')}</p>
                  <p className="mt-1 typography-meta text-muted-foreground">{t('sessions.scheduledTasks.history.empty.description')}</p>
                </div>
              ) : (
                <div className={cn(
                  // Match Tasks list rhythm on mobile tab (space-y-4); denser sheet / desktop rows elsewhere.
                  isMobileTab
                    ? 'space-y-4'
                    : isMobilePanel
                      ? 'space-y-2'
                      : 'divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]',
                )}>
                  {runs.map((run) => {
                    const project = projectById.get(run.projectId);
                    const projectLabel = project ? formatDirectoryName(project.path) : run.projectId;
                    const directoryLabel = run.directory ? formatDirectoryName(run.directory) : null;
                    const locationLabel = directoryLabel && directoryLabel !== projectLabel
                      ? `${projectLabel} · ${directoryLabel}`
                      : projectLabel;
                    const statusMeta = STATUS_META[run.status];
                    const canOpenSession = Boolean(run.sessionId && run.directory);
                    const durationMs = resolveRunDurationMs(run, historyNowMs);
                    const durationLabel = formatCompactRunDuration(durationMs)
                      ?? (run.status === 'running' ? t('sessions.scheduledTasks.history.duration.pending') : null);
                    const startedLabel = formatRunDateTime(run.startedAt);
                    const triggerLabel = t(`sessions.scheduledTasks.history.trigger.${run.trigger}`);
                    const triggerIcon: IconName = run.trigger === 'manual' ? 'play' : 'calendar-schedule';
                    const statusLabel = t(`sessions.scheduledTasks.dialog.status.${run.status}`);
                    const statusColor = statusMeta.tone === 'muted' ? undefined : { color: `var(--status-${statusMeta.tone})` };
                    const projectIconName: IconName = project?.icon
                      ? (PROJECT_ICON_MAP[project.icon] ?? 'folder')
                      : 'folder';
                    const projectIconColor = project?.color ? PROJECT_COLOR_MAP[project.color] : undefined;
                    const projectIcon = (
                      <span className="flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-muted-foreground">
                        {project?.iconImage ? (
                          <ProjectIconImage
                            project={project}
                            className="size-full object-contain"
                            fallback={(
                              <Icon
                                name={projectIconName}
                                className="size-3.5"
                                style={projectIconColor ? { color: projectIconColor } : undefined}
                              />
                            )}
                          />
                        ) : (
                          <Icon
                            name={projectIconName}
                            className="size-3.5"
                            style={projectIconColor ? { color: projectIconColor } : undefined}
                          />
                        )}
                      </span>
                    );
                    const statusIcon = (
                      <span
                        className={cn(
                          'mt-0.5 flex shrink-0 items-center justify-center rounded-full border',
                          isMobilePanel ? 'size-7' : 'size-8',
                        )}
                        style={toneStyle(statusMeta.tone)}
                        title={statusLabel}
                        aria-label={statusLabel}
                      >
                        <Icon
                          name={statusMeta.Icon}
                          className={cn(
                            isMobilePanel ? 'size-3.5' : 'size-4',
                            statusMeta.spin && 'animate-spin motion-reduce:animate-none',
                          )}
                        />
                      </span>
                    );
                    const locationRow = (
                      <p
                        className={cn(
                          'mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground',
                          isMobilePanel ? 'typography-micro' : 'truncate typography-meta',
                        )}
                        title={run.directory ?? projectLabel}
                      >
                        {projectIcon}
                        <span className={cn('min-w-0', isMobilePanel ? 'break-words' : 'truncate')}>
                          {locationLabel}
                        </span>
                      </p>
                    );
                    // Compact cluster: duration (muted) immediately left of status.
                    const durationStatus = (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {durationLabel ? (
                          <span className="typography-micro tabular-nums text-muted-foreground" title={durationLabel}>
                            {durationLabel}
                          </span>
                        ) : null}
                        <span className="typography-micro font-medium" style={statusColor}>
                          {statusLabel}
                        </span>
                      </div>
                    );

                    // Shared card body (mobile card chrome vs desktop list row).
                    // Must be full width so justify-between can pin duration / open
                    // session to the trailing edge and keep rows vertically aligned.
                    // Mobile: allow meta to wrap and avoid flex-1 + nowrap, which
                    // ellipsizes time/trigger next to "打开会话".
                    const runBody = (
                      <div className={cn(
                        'flex w-full min-w-0 items-start',
                        isMobilePanel ? 'gap-2.5' : 'gap-3',
                      )}>
                        {statusIcon}
                        <div className="min-w-0 flex-1">
                          <div className="flex w-full min-w-0 items-start justify-between gap-2">
                            <h3 className={cn(
                              'min-w-0 flex-1 font-semibold text-foreground',
                              isMobilePanel
                                ? 'break-words typography-meta leading-snug'
                                : 'truncate typography-ui-label',
                            )}>
                              {run.taskName}
                            </h3>
                            {durationStatus}
                          </div>
                          {locationRow}
                          <div className={cn(
                            'mt-1 flex w-full min-w-0 gap-2',
                            // Mobile: whole card opens the session — no trailing button.
                            isMobilePanel
                              ? 'items-center'
                              : 'items-center justify-between gap-3',
                          )}>
                            <div className={cn(
                              'flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground',
                              isMobilePanel && 'gap-x-2.5 gap-y-0.5',
                            )}>
                              <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={startedLabel}>
                                <Icon name="time" className="size-3 shrink-0" aria-hidden="true" />
                                <span className="whitespace-nowrap tabular-nums">{startedLabel}</span>
                              </span>
                              <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={triggerLabel}>
                                <Icon name={triggerIcon} className="size-3 shrink-0" aria-hidden="true" />
                                <span className="whitespace-nowrap">{triggerLabel}</span>
                              </span>
                            </div>
                            {!isMobilePanel && canOpenSession ? (
                              <span className="shrink-0 self-center typography-ui-label font-medium text-foreground">
                                {t('sessions.scheduledTasks.history.openSession')}
                              </span>
                            ) : null}
                          </div>
                          {run.error ? (
                            // Inline glyph + copy so the icon sits on the first line and wraps
                            // only at the trailing edge (not a stacked flex/grid column).
                            <p
                              className={cn(
                                'mt-1.5 min-w-0 break-words typography-micro text-[var(--surface-muted-foreground)] [overflow-wrap:anywhere]',
                                isMobilePanel ? 'line-clamp-3' : 'line-clamp-1',
                              )}
                              title={run.error.slice(0, 300)}
                            >
                              <Icon
                                name="error-warning"
                                className="mr-1 inline-block size-3 align-[-0.125em] text-[var(--status-error)]"
                                aria-hidden="true"
                              />
                              {run.error.slice(0, 300)}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );

                    if (isMobilePanel) {
                      // Whole-card open + shared soft press scale (same as task cards).
                      const openLabel = t('sessions.scheduledTasks.history.openSession');
                      const shellClass = cn(
                        // scheduled-task-card: container-type for soft press scale (mobile.css).
                        'oc-mobile-scheduled-task-card w-full',
                        isMobileTab
                          ? 'oc-mobile-floating-surface oc-mobile-project-shell rounded-[var(--oc-mobile-surface-radius)]'
                          : 'rounded-xl border border-border/60 bg-[var(--surface-elevated)] shadow-sm dark:shadow-none',
                      );
                      if (canOpenSession) {
                        return (
                          <article
                            key={run.id}
                            data-mobile-press-surface="soft"
                            className={shellClass}
                          >
                            <button
                              type="button"
                              data-mobile-press-surface-trigger
                              className={cn(
                                'oc-mobile-scheduled-task-row w-full p-3 text-left outline-none',
                                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]',
                              )}
                              aria-label={openLabel}
                              onClick={() => handleOpenRunSession(run)}
                            >
                              {runBody}
                            </button>
                          </article>
                        );
                      }
                      return (
                        <article
                          key={run.id}
                          className={cn(shellClass, 'p-3')}
                        >
                          {runBody}
                        </article>
                      );
                    }

                    if (canOpenSession) {
                      return (
                        <article key={run.id} className="w-full min-w-0">
                          <button
                            type="button"
                            className="w-full min-w-0 px-4 py-3 text-left outline-none transition-colors hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none"
                            aria-label={t('sessions.scheduledTasks.history.openSession')}
                            onClick={() => handleOpenRunSession(run)}
                          >
                            {runBody}
                          </button>
                        </article>
                      );
                    }

                    return (
                      <article key={run.id} className="w-full min-w-0 px-4 py-3">
                        {runBody}
                      </article>
                    );
                  })}
                  {runsQuery.error ? (
                    <div className={cn(
                      'flex flex-wrap items-center justify-between gap-2 p-3 typography-meta text-[var(--status-error-foreground)]',
                      isMobilePanel
                        ? 'rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)]'
                        : 'border-t border-[var(--status-error-border)] bg-[var(--status-error-background)]',
                    )}>
                      <span>{t('sessions.scheduledTasks.history.error.more')}</span>
                      <Button variant="outline" size="sm" onClick={() => void handleRetryRuns()}>{t('sessions.scheduledTasks.history.retry')}</Button>
                    </div>
                  ) : null}
                  {runsQuery.hasNextPage ? (
                    <div className={cn('flex justify-center', isMobilePanel ? 'pt-2' : 'border-t border-border/40 px-4 py-3')}>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(isMobilePanel && 'min-h-11')}
                        disabled={runsQuery.isFetchingNextPage}
                        onClick={() => void runsQuery.fetchNextPage()}
                      >
                        {runsQuery.isFetchingNextPage ? <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" /> : <Icon name="history" className="size-4" />}
                        {runsQuery.isFetchingNextPage ? t('sessions.scheduledTasks.history.loadingMore') : t('sessions.scheduledTasks.history.loadMore')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
          <>
          {failedProjectIds.length > 0 ? (
            <div className="mb-3 rounded-xl border p-3 typography-meta" style={toneStyle('warning')}>
              {t('sessions.scheduledTasks.workspace.partialLoadWarning')}
            </div>
          ) : null}
          {tasksQuery.isLoading ? (
            <div className="flex items-center gap-2 px-4 py-3 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('sessions.scheduledTasks.dialog.loading')}
            </div>
          ) : tasksQuery.error ? (
            <div className="rounded-xl border border-dashed border-border p-4 typography-meta text-muted-foreground">
              {tasksQuery.error instanceof Error ? tasksQuery.error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed')}
            </div>
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              {filteredTasks.length === 0 ? (
                <motion.div
                  key="empty"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="rounded-xl border border-dashed border-border p-4 typography-meta text-muted-foreground"
                >
                  {tasks.length > 0 ? t('sessions.scheduledTasks.workspace.search.noResults') : t('sessions.scheduledTasks.dialog.empty.noTasks')}
                </motion.div>
              ) : (
                <motion.div
                  key="tasks"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className={cn(isMobileTab ? 'space-y-4' : 'space-y-1')}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                  {filteredTasks.map((entry) => {
                const { projectId, task } = entry;
                const identityKey = taskIdentityKey({ projectId, taskId: task.id });
                const selected = editorMode === 'edit' && selectedTaskIdentity !== null && taskIdentityKey(selectedTaskIdentity) === identityKey;
                const nextAt = task.state?.nextRunAt;
                const status = (task.state?.lastStatus || 'idle') as ScheduledTaskStatus;
                const meta = STATUS_META[status];
                const isBusy = mutatingTaskIdentity === identityKey;
                const renderMenuItems = (Item: React.ElementType) => (
                  <>
                    <Item
                      className={cn(isMobilePanel && 'min-h-11')}
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        void handleRunTask(entry);
                      }}
                      disabled={isBusy}
                    >
                      <Icon name="play" className="size-4" />
                      {t('sessions.scheduledTasks.dialog.actions.runNow')}
                    </Item>
                    <Item
                      className={cn(isMobilePanel && 'min-h-11')}
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        handleOpenTaskHistory(entry);
                      }}
                    >
                      <Icon name="history" className="size-4" />
                      {t('sessions.scheduledTasks.workspace.views.history')}
                    </Item>
                    <Item
                      className={cn(isMobilePanel && 'min-h-11')}
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        void handleToggleTask(entry, !task.enabled);
                      }}
                      disabled={isBusy}
                    >
                      <Icon name={task.enabled ? 'pause' : 'play'} className="size-4" />
                      {task.enabled
                        ? t('sessions.scheduledTasks.dialog.actions.pause')
                        : t('sessions.scheduledTasks.dialog.actions.resume')}
                    </Item>
                    <Item
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        void handleDeleteTask(entry);
                      }}
                      disabled={isBusy}
                      className={cn('text-destructive focus:text-destructive', isMobilePanel && 'min-h-11')}
                    >
                      <Icon name="delete-bin" className="size-4" />
                      {t('sessions.scheduledTasks.dialog.actions.delete')}
                    </Item>
                  </>
                );
                return (
                  <motion.div
                    key={identityKey}
                    layout="position"
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                    data-mobile-press-surface={isMobileTab ? 'soft' : undefined}
                    className={cn(isMobileTab && 'oc-mobile-floating-surface oc-mobile-project-shell oc-mobile-scheduled-task-card')}
                  >
                  <ContextMenu
                    open={contextMenuTaskIdentity === identityKey}
                    onOpenChange={(open) => {
                      if (open) {
                        setDropdownMenuTaskIdentity(null);
                      }
                      setContextMenuTaskIdentity(open ? identityKey : null);
                    }}
                  >
                    <div className={cn(
                      'group flex w-full items-center gap-1',
                      isMobileTab && 'oc-mobile-project-card',
                    )}>
                    <ContextMenuTrigger
                      render={(
                        <button
                          type="button"
                          onClick={() => handleSelectTask(entry)}
                          onContextMenu={!isMobilePanel && !isMobile ? (event) => {
                            event.preventDefault();
                            setDropdownMenuTaskIdentity(null);
                            setContextMenuTaskIdentity(identityKey);
                          } : undefined}
                          data-mobile-press-surface-trigger={isMobileTab ? true : undefined}
                          className={cn(
                            'flex min-h-11 min-w-0 flex-1 items-center rounded-xl border py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
                            isMobileTab
                              ? 'oc-mobile-project-trigger oc-mobile-scheduled-task-row border-0 bg-transparent transition-opacity duration-150'
                              : 'transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out active:bg-interactive-active',
                            isMobilePanel && !isMobileTab ? 'gap-2.5 px-3' : !isMobileTab ? 'gap-3 px-4' : undefined,
                            !isMobileTab && (selected
                              ? 'border-border/50 bg-[var(--surface-elevated)] shadow-sm dark:shadow-none'
                              : 'border-transparent hover:bg-interactive-hover'),
                            !task.enabled && 'opacity-65',
                          )}
                          aria-pressed={selected}
                        />
                      )}
                    >
                    <span
                      className={cn(
                        'flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[border-color,color,background-color] duration-150 motion-reduce:transition-none',
                        isMobileTab
                          ? 'oc-mobile-project-icon oc-mobile-glass-control'
                          : 'size-5 border border-border',
                      )}
                      style={task.enabled && meta.tone !== 'muted' ? { color: `var(--status-${meta.tone})` } : undefined}
                    >
                      <AnimatePresence initial={false} mode="wait">
                        <motion.span
                          key={`${task.enabled}-${status}`}
                          initial={reduceMotion ? false : { opacity: 0, scale: 0.72 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
                          transition={{ duration: reduceMotion ? 0 : 0.15 }}
                          className="flex"
                        >
                          <Icon
                            name={task.enabled ? meta.Icon : 'pause'}
                            className={cn(
                              isMobileTab ? 'oc-mobile-project-icon-glyph' : 'size-3.5',
                              meta.spin && task.enabled && 'animate-spin',
                            )}
                          />
                        </motion.span>
                      </AnimatePresence>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn(
                        'block truncate font-medium',
                        isMobileTab ? 'oc-mobile-project-title oc-mobile-entity-title font-semibold' : 'typography-ui-label',
                      )}>{task.name}</span>
                      <span className={cn(
                        'mt-1 flex min-w-0 items-center text-muted-foreground',
                        isMobileTab ? 'oc-mobile-project-meta oc-mobile-entity-meta' : 'gap-1 typography-micro',
                      )}>
                        <span className="truncate">{formatSchedule(task, t, !isMobileTab)}</span>
                        <span className="shrink-0 text-muted-foreground/50">·</span>
                        <span className="shrink-0 truncate">
                          {nextAt ? formatRelativeTime(nextAt, t) : '—'}
                        </span>
                      </span>
                    </span>
                    </ContextMenuTrigger>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'shrink-0 self-center rounded-lg text-muted-foreground',
                        isMobilePanel ? 'size-11 rounded-full' : 'size-9',
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleOpenTaskHistory(entry);
                      }}
                      aria-label={t('sessions.scheduledTasks.workspace.views.history')}
                    >
                      <Icon name="history" className="size-4" />
                    </Button>
                    <DropdownMenu
                      open={dropdownMenuTaskIdentity === identityKey}
                      onOpenChange={(open) => {
                        if (open) {
                          setContextMenuTaskIdentity(null);
                        }
                        setDropdownMenuTaskIdentity(open ? identityKey : null);
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'shrink-0 self-center text-muted-foreground transition-[opacity,transform,background-color] duration-150 ease-out data-[popup-open]:bg-interactive-hover motion-reduce:transition-none',
                            isMobileTab
                              ? 'oc-mobile-project-action oc-mobile-scheduled-task-action rounded-full'
                              : 'rounded-lg',
                            isMobileTab
                              ? undefined
                              : isMobilePanel
                                ? 'size-11'
                                : 'size-8 translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 data-[popup-open]:translate-x-0 data-[popup-open]:opacity-100',
                            selected && !isMobileTab && 'opacity-100',
                          )}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: task.name })}
                        >
                          <Icon name="more-2" className={isMobileTab ? 'size-5' : 'size-4'} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40 motion-reduce:transition-none" onClick={(event) => event.stopPropagation()}>
                        {renderMenuItems(DropdownMenuItem)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                    <ContextMenuContent className="min-w-40 motion-reduce:transition-none">
                      {renderMenuItems(ContextMenuItem)}
                    </ContextMenuContent>
                  </ContextMenu>
                  </motion.div>
                );
                  })}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          )}
          </>
          )}
          </div>
        </div>
      </section>
      </div>

      {!isMobile ? (
        <AnimatePresence initial={false}>
          {editorMode !== 'closed' ? (
          <motion.div
            key="scheduled-task-details"
            initial={reduceMotion ? { opacity: 1, width: 0 } : { opacity: 0, width: 0, x: 24 }}
            animate={{ opacity: 1, width: 'clamp(380px, 36vw, 480px)', x: 0 }}
            exit={reduceMotion ? { opacity: 0, width: 0 } : { opacity: 0, width: 0, x: 24 }}
            transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="h-full min-h-0 max-w-[480px] shrink-0 overflow-hidden"
          >
            <aside className="h-full min-h-0 w-[clamp(380px,36vw,480px)] border-l border-border/60 bg-background">
              <ScheduledTaskEditorDialog
                open
                presentation="panel"
                task={editorMode === 'edit' ? selectedTask : null}
                onOpenChange={handleCancelEditor}
                onSave={handleSaveTask}
                onDirtyChange={setDraftDirty}
                onRun={async () => { if (selectedTaskEntry) await handleRunTask(selectedTaskEntry); }}
                onOpenTaskHistory={handleEditorOpenTaskHistory}
                onDelete={async () => { if (selectedTaskEntry) await handleDeleteTask(selectedTaskEntry); }}
                onToggleEnabled={async (_task, enabled) => { if (selectedTaskEntry) await handleToggleTask(selectedTaskEntry, enabled); }}
                actionBusy={Boolean(mutatingTaskIdentity)}
                projectID={selectedTaskIdentity?.projectId || createProjectID}
                projectOptions={editorProjectOptions}
                onProjectChange={editorMode === 'create' ? setCreateProjectID : undefined}
              />
            </aside>
          </motion.div>
          ) : null}
        </AnimatePresence>
      ) : editorMode !== 'closed' ? (
        <div
          ref={isMobileTab ? mobileNavigationSurfaceRef : undefined}
          className={cn(
            isMobileTab
              ? 'fixed inset-0 z-50 flex h-[100dvh] w-full min-w-0 max-w-full flex-col overflow-hidden bg-background [contain:layout_paint]'
              : 'contents',
          )}
        >
          <ScheduledTaskEditorDialog
            open
            presentation={isMobileTab ? 'mobile-tab' : isMobilePanel ? 'mobile-panel' : undefined}
            task={editorMode === 'edit' ? selectedTask : null}
            onOpenChange={handleCancelEditor}
            onSave={handleSaveTask}
            onDirtyChange={setDraftDirty}
            onRun={async () => { if (selectedTaskEntry) await handleRunTask(selectedTaskEntry); }}
            onOpenTaskHistory={handleEditorOpenTaskHistory}
            onDelete={async () => { if (selectedTaskEntry) await handleDeleteTask(selectedTaskEntry); }}
            onToggleEnabled={async (_task, enabled) => { if (selectedTaskEntry) await handleToggleTask(selectedTaskEntry, enabled); }}
            actionBusy={Boolean(mutatingTaskIdentity)}
            projectID={selectedTaskIdentity?.projectId || createProjectID}
            projectOptions={editorProjectOptions}
            onProjectChange={editorMode === 'create' ? setCreateProjectID : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
