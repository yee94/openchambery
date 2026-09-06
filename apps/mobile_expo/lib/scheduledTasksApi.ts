import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error';

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: 'daily' | 'weekly' | 'once' | 'cron';
    times?: string[];
    time?: string;
    date?: string;
    weekdays?: number[];
    cron?: string;
    timezone?: string;
  };
  execution: {
    prompt: string;
    providerID: string;
    modelID: string;
    variant?: string;
    agent?: string;
    goalEnabled?: boolean;
    goalTokenBudget?: number;
  };
  state: {
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string;
    lastDurationMs?: number;
    lastSessionId?: string;
    nextRunAt?: number;
  };
};

export type GlobalScheduledTask = {
  projectId: string;
  task: ScheduledTask;
};

export type GlobalScheduledTasksResponse = {
  tasks: GlobalScheduledTask[];
  failedProjectIds: string[];
};

export type ScheduledTaskRun = {
  id: string;
  projectId: string;
  taskId: string;
  taskName: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'success' | 'error';
  sessionId: string | null;
  directory: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
};

export type ScheduledTaskRunsResponse = {
  runs: ScheduledTaskRun[];
  nextCursor: string | null;
  complete: boolean;
};

export type FetchScheduledTaskRunsOptions = {
  before?: string;
  limit?: number;
  projectId?: string;
  taskId?: string;
};

export class ScheduledTasksApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ScheduledTasksApiError';
    this.status = status;
  }
}

const parseErrorMessage = async (
  response: { status: number; json: () => Promise<unknown>; text: () => Promise<string> },
  fallback: string,
): Promise<string> => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      const msg = ((parsed as { error: string }).error || '').trim();
      if (msg) return msg;
    }
  } catch {
    /* fall through */
  }
  try {
    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    /* fall through */
  }
  return fallback;
};

const ensureId = (value: string, label: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new ScheduledTasksApiError(`${label} is required`);
  return trimmed;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isNullableFiniteNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));
const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const isNullableTimestamp = (value: unknown): value is number | null =>
  value === null || isTimestamp(value);

export const isScheduledTaskRun = (value: unknown): value is ScheduledTaskRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.id === 'string' &&
    run.id.length > 0 &&
    typeof run.projectId === 'string' &&
    run.projectId.length > 0 &&
    typeof run.taskId === 'string' &&
    run.taskId.length > 0 &&
    typeof run.taskName === 'string' &&
    (run.trigger === 'scheduled' || run.trigger === 'manual') &&
    (run.status === 'running' || run.status === 'success' || run.status === 'error') &&
    isNullableString(run.sessionId) &&
    isNullableString(run.directory) &&
    isNullableString(run.error) &&
    isTimestamp(run.startedAt) &&
    isNullableTimestamp(run.finishedAt) &&
    isNullableFiniteNumber(run.durationMs) &&
    (run.durationMs === null || run.durationMs >= 0)
  );
};

export const parseScheduledTaskRunsResponse = (value: unknown): ScheduledTaskRunsResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledTasksApiError('Malformed scheduled task runs response');
  }
  const response = value as Record<string, unknown>;
  if (
    !Array.isArray(response.runs) ||
    !response.runs.every(isScheduledTaskRun) ||
    !isNullableString(response.nextCursor) ||
    typeof response.complete !== 'boolean' ||
    response.complete !== (response.nextCursor === null) ||
    (response.nextCursor !== null && response.nextCursor.length === 0)
  ) {
    throw new ScheduledTasksApiError('Malformed scheduled task runs response');
  }
  return {
    runs: response.runs,
    nextCursor: response.nextCursor,
    complete: response.complete,
  };
};

export const parseGlobalScheduledTasksResponse = (value: unknown): GlobalScheduledTasksResponse => {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const tasksRaw = Array.isArray(row?.tasks) ? row!.tasks : [];
  const tasks: GlobalScheduledTask[] = [];
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const projectId = typeof rec.projectId === 'string' ? rec.projectId : '';
    const task = rec.task;
    if (!projectId || !task || typeof task !== 'object') continue;
    const t = task as Partial<ScheduledTask>;
    if (typeof t.id !== 'string' || typeof t.name !== 'string') continue;
    tasks.push({ projectId, task: task as ScheduledTask });
  }
  const failedProjectIds = Array.isArray(row?.failedProjectIds)
    ? row!.failedProjectIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { tasks, failedProjectIds };
};

export const fetchGlobalScheduledTasks = async (
  active: ActiveRuntime,
  signal?: AbortSignal,
): Promise<GlobalScheduledTasksResponse> => {
  const response = await openchamberFetch(active, '/api/openchamber/scheduled-tasks', { signal });
  if (!response.ok) {
    throw new ScheduledTasksApiError(
      await parseErrorMessage(response, 'Failed to load schedules'),
      response.status,
    );
  }
  return parseGlobalScheduledTasksResponse(await response.json());
};

export const fetchScheduledTaskRuns = async (
  active: ActiveRuntime,
  options: FetchScheduledTaskRunsOptions,
  signal?: AbortSignal,
): Promise<ScheduledTaskRunsResponse> => {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ScheduledTasksApiError('limit must be a positive integer');
  }
  params.set('limit', String(limit));
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.taskId) params.set('taskId', options.taskId);

  const response = await openchamberFetch(
    active,
    `/api/openchamber/scheduled-task-runs?${params.toString()}`,
    { signal },
  );
  if (!response.ok) {
    throw new ScheduledTasksApiError(
      await parseErrorMessage(response, 'Failed to load scheduled task history'),
      response.status,
    );
  }
  return parseScheduledTaskRunsResponse(await response.json());
};

export const upsertScheduledTask = async (
  active: ActiveRuntime,
  projectID: string,
  task: Partial<ScheduledTask>,
): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureId(projectID, 'projectId');
  const response = await openchamberFetch(
    active,
    `/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ task }),
    },
  );
  if (!response.ok) {
    throw new ScheduledTasksApiError(
      await parseErrorMessage(response, 'Failed to save schedule'),
      response.status,
    );
  }
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return [];
  }
  return (parsed as { tasks: ScheduledTask[] }).tasks;
};

export const deleteScheduledTask = async (
  active: ActiveRuntime,
  projectID: string,
  taskID: string,
): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureId(projectID, 'projectId');
  const safeTaskID = ensureId(taskID, 'taskId');
  const response = await openchamberFetch(
    active,
    `/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new ScheduledTasksApiError(
      await parseErrorMessage(response, 'Failed to delete schedule'),
      response.status,
    );
  }
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return [];
  }
  return (parsed as { tasks: ScheduledTask[] }).tasks;
};

export const runScheduledTaskNow = async (
  active: ActiveRuntime,
  projectID: string,
  taskID: string,
): Promise<{ sessionId?: string }> => {
  const safeProjectID = ensureId(projectID, 'projectId');
  const safeTaskID = ensureId(taskID, 'taskId');
  const response = await openchamberFetch(
    active,
    `/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}/run`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new ScheduledTasksApiError(
      await parseErrorMessage(response, 'Failed to run schedule'),
      response.status,
    );
  }
  const parsed = await response.json();
  const sessionId =
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { sessionId?: unknown }).sessionId === 'string' &&
    (parsed as { sessionId: string }).sessionId.length > 0
      ? (parsed as { sessionId: string }).sessionId
      : undefined;
  return { sessionId };
};

/** Optimistic patch: mark a task as running in a global list response. */
export const patchTaskRunning = (
  current: GlobalScheduledTasksResponse | null,
  projectId: string,
  taskId: string,
  nowMs = Date.now(),
): GlobalScheduledTasksResponse | null => {
  if (!current) return current;
  return {
    ...current,
    tasks: current.tasks.map((entry) => {
      if (entry.projectId !== projectId || entry.task.id !== taskId) return entry;
      return {
        projectId,
        task: {
          ...entry.task,
          state: {
            ...entry.task.state,
            lastStatus: 'running',
            lastRunAt: nowMs,
            updatedAt: nowMs,
          },
        },
      };
    }),
  };
};

export const replaceProjectTasks = (
  current: GlobalScheduledTasksResponse | null,
  projectId: string,
  tasks: ScheduledTask[],
): GlobalScheduledTasksResponse => ({
  tasks: [
    ...(current?.tasks.filter((entry) => entry.projectId !== projectId) ?? []),
    ...tasks.map((task) => ({ projectId, task })),
  ],
  failedProjectIds: current?.failedProjectIds.filter((id) => id !== projectId) ?? [],
});

export const taskIdentityKey = (projectId: string, taskId: string): string =>
  `${projectId}:${taskId}`;
