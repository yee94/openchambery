import { formatRelativeTime, formatSchedule, statusLabel, statusTone } from '@/lib/scheduledFormat';
import type {
  GlobalScheduledTask,
  ScheduledTaskStatus,
} from '@/lib/scheduledTasksApi';

export type WorkspaceFilter = 'all' | 'active' | 'paused';
export type WorkspaceView = 'tasks' | 'history';

export type ScheduledTaskCardModel = {
  projectId: string;
  taskId: string;
  identityKey: string;
  name: string;
  enabled: boolean;
  /** Never name-only — always includes schedule + next-run text. */
  scheduleLabel: string;
  nextRunLabel: string;
  metaLine: string;
  status: ScheduledTaskStatus;
  statusLabel: string;
  statusTone: ReturnType<typeof statusTone>;
  lastError?: string;
};

export const sortScheduledTasks = (tasks: GlobalScheduledTask[]): GlobalScheduledTask[] =>
  [...tasks].sort((a, b) => {
    if (a.task.enabled !== b.task.enabled) return a.task.enabled ? -1 : 1;
    return a.task.name.localeCompare(b.task.name);
  });

export const filterScheduledTasks = (
  tasks: GlobalScheduledTask[],
  filter: WorkspaceFilter,
  search = '',
): GlobalScheduledTask[] => {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return tasks.filter(({ task }) => {
    if (filter === 'active' && !task.enabled) return false;
    if (filter === 'paused' && task.enabled) return false;
    if (!normalizedSearch) return true;
    const schedule = formatSchedule(task).toLocaleLowerCase();
    return (
      task.name.toLocaleLowerCase().includes(normalizedSearch) ||
      schedule.includes(normalizedSearch)
    );
  });
};

/**
 * Cap MobileScheduledTab card contract: status disc + name + schedule · next-run.
 * Never emit name-only cards.
 */
export const toScheduledTaskCardModel = (
  entry: GlobalScheduledTask,
  nowMs = Date.now(),
): ScheduledTaskCardModel => {
  const { projectId, task } = entry;
  const status = (task.state?.lastStatus || 'idle') as ScheduledTaskStatus;
  const scheduleLabel = formatSchedule(task, false);
  const nextAt = task.state?.nextRunAt;
  const nextRunLabel = nextAt ? formatRelativeTime(nextAt, nowMs) : '—';
  return {
    projectId,
    taskId: task.id,
    identityKey: `${projectId}:${task.id}`,
    name: task.name,
    enabled: task.enabled,
    scheduleLabel,
    nextRunLabel,
    metaLine: `${scheduleLabel} · ${nextRunLabel}`,
    status,
    statusLabel: statusLabel(status),
    statusTone: statusTone(status),
    lastError: task.state?.lastError,
  };
};

export const buildScheduledTaskCards = (
  tasks: GlobalScheduledTask[],
  filter: WorkspaceFilter,
  search = '',
  nowMs = Date.now(),
): ScheduledTaskCardModel[] =>
  filterScheduledTasks(sortScheduledTasks(tasks), filter, search).map((entry) =>
    toScheduledTaskCardModel(entry, nowMs),
  );
