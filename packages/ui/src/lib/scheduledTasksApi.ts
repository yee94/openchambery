import { runtimeFetch } from './runtime-fetch';

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

type ScheduledTaskRunsResponse = {
  runs: ScheduledTaskRun[];
  nextCursor: string | null;
  complete: boolean;
};

type FetchScheduledTaskRunsOptions = {
  before?: string;
  limit?: number;
  projectId?: string;
  taskId?: string;
};

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

const ensureProjectID = (projectID: string): string => {
  const trimmed = typeof projectID === 'string' ? projectID.trim() : '';
  if (!trimmed) {
    throw new Error('projectId is required');
  }
  return trimmed;
};

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNullableFiniteNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const isNullableTimestamp = (value: unknown): value is number | null => value === null || isTimestamp(value);

const isScheduledTaskRun = (value: unknown): value is ScheduledTaskRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === 'string' && run.id.length > 0
    && typeof run.projectId === 'string' && run.projectId.length > 0
    && typeof run.taskId === 'string' && run.taskId.length > 0
    && typeof run.taskName === 'string'
    && (run.trigger === 'scheduled' || run.trigger === 'manual')
    && (run.status === 'running' || run.status === 'success' || run.status === 'error')
    && isNullableString(run.sessionId)
    && isNullableString(run.directory)
    && isNullableString(run.error)
    && isTimestamp(run.startedAt)
    && isNullableTimestamp(run.finishedAt)
    && isNullableFiniteNumber(run.durationMs)
    && (run.durationMs === null || run.durationMs >= 0);
};

const parseScheduledTaskRunsResponse = (value: unknown): ScheduledTaskRunsResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed scheduled task runs response');
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.runs)
    || !response.runs.every(isScheduledTaskRun)
    || !isNullableString(response.nextCursor)
    || typeof response.complete !== 'boolean'
    || response.complete !== (response.nextCursor === null)
    || (response.nextCursor !== null && response.nextCursor.length === 0)) {
    throw new Error('Malformed scheduled task runs response');
  }
  return {
    runs: response.runs,
    nextCursor: response.nextCursor,
    complete: response.complete,
  };
};

export const fetchScheduledTaskRuns = async (
  options: FetchScheduledTaskRunsOptions,
  signal?: AbortSignal,
): Promise<ScheduledTaskRunsResponse> => {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer');
  }
  params.set('limit', String(limit));
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.taskId) params.set('taskId', options.taskId);

  const response = await runtimeFetch(`/api/openchamber/scheduled-task-runs?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load scheduled task history'));
  }
  const parsed = await response.json().catch(() => null);
  return parseScheduledTaskRunsResponse(parsed);
};

export const fetchScheduledTasks = async (projectID: string): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load schedules'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const fetchGlobalScheduledTasks = async (): Promise<GlobalScheduledTasksResponse> => {
  const response = await runtimeFetch('/api/openchamber/scheduled-tasks');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load schedules'));
  }
  const parsed = await response.json().catch(() => null);
  return {
    tasks: Array.isArray(parsed?.tasks) ? parsed.tasks as GlobalScheduledTask[] : [],
    failedProjectIds: Array.isArray(parsed?.failedProjectIds) ? parsed.failedProjectIds.filter((id: unknown): id is string => typeof id === 'string') : [],
  };
};

export const upsertScheduledTask = async (projectID: string, task: Partial<ScheduledTask>): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ task }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to save schedule'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const deleteScheduledTask = async (projectID: string, taskID: string): Promise<ScheduledTask[]> => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to delete schedule'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const runScheduledTaskNow = async (projectID: string, taskID: string): Promise<{ sessionId?: string }> => {
  const safeProjectID = ensureProjectID(projectID);
  const safeTaskID = ensureProjectID(taskID);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks/${encodeURIComponent(safeTaskID)}/run`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to run schedule'));
  }
  const parsed = await response.json().catch(() => null);
  return {
    sessionId: typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : undefined,
  };
};
