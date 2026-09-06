import type { LynxRuntimeFetch } from '../runtime/fetch';
import type {
  LynxGlobalScheduledTask,
  LynxGlobalScheduledTasksResponse,
  LynxScheduledLoadResult,
  LynxScheduledTask,
  LynxScheduledTaskRun,
  LynxScheduledTaskRunsPage,
} from './types';

const ensureOk = async (response: { ok: boolean; status: number }, fallback: string): Promise<void> => {
  if (response.ok) return;
  throw new Error(`${fallback} (${response.status})`);
};

const isTask = (value: unknown): value is LynxScheduledTask => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === 'string'
    && typeof task.name === 'string'
    && typeof task.enabled === 'boolean'
    && Boolean(task.schedule)
    && typeof task.schedule === 'object'
    && Boolean(task.execution)
    && typeof task.execution === 'object'
    && Boolean(task.state)
    && typeof task.state === 'object';
};

const isGlobalTask = (value: unknown): value is LynxGlobalScheduledTask => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.projectId === 'string' && isTask(row.task);
};

const isRun = (value: unknown): value is LynxScheduledTaskRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === 'string'
    && typeof run.projectId === 'string'
    && typeof run.taskId === 'string'
    && typeof run.taskName === 'string'
    && (run.trigger === 'scheduled' || run.trigger === 'manual')
    && (run.status === 'running' || run.status === 'success' || run.status === 'error')
    && (run.sessionId === null || typeof run.sessionId === 'string')
    && (run.directory === null || typeof run.directory === 'string')
    && (run.error === null || typeof run.error === 'string')
    && typeof run.startedAt === 'number'
    && (run.finishedAt === null || typeof run.finishedAt === 'number')
    && (run.durationMs === null || typeof run.durationMs === 'number');
};

/**
 * Cap `GET /api/openchamber/scheduled-tasks`.
 * Partial project failures stay in `failedProjectIds` — never silently empty-success.
 */
export const loadGlobalScheduledTasks = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxScheduledLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/openchamber/scheduled-tasks', {
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    await ensureOk(response, 'Failed to load schedules');
    const parsed = await response.json() as {
      tasks?: unknown;
      failedProjectIds?: unknown;
    };
    const tasks = Array.isArray(parsed?.tasks)
      ? parsed.tasks.filter(isGlobalTask)
      : [];
    const failedProjectIds = Array.isArray(parsed?.failedProjectIds)
      ? parsed.failedProjectIds.filter((id): id is string => typeof id === 'string')
      : [];
    // If the payload shape is wholly wrong (tasks key missing / not array) treat as failed.
    if (parsed && 'tasks' in parsed && !Array.isArray(parsed.tasks)) {
      return { status: 'failed', error: new Error('Malformed scheduled tasks response') };
    }
    return {
      status: 'ok',
      response: { tasks, failedProjectIds } satisfies LynxGlobalScheduledTasksResponse,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const loadScheduledTaskRuns = async (
  runtimeFetch: LynxRuntimeFetch,
  options: {
    before?: string;
    limit?: number;
    projectId?: string;
    taskId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LynxScheduledTaskRunsPage> => {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  params.set('limit', String(limit));
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.taskId) params.set('taskId', options.taskId);

  const response = await runtimeFetch(`/api/openchamber/scheduled-task-runs?${params.toString()}`, {
    signal: options.signal,
  });
  await ensureOk(response, 'Failed to load scheduled task history');
  const parsed = await response.json() as {
    runs?: unknown;
    nextCursor?: unknown;
    complete?: unknown;
  };
  if (!Array.isArray(parsed.runs)
    || !parsed.runs.every(isRun)
    || !(parsed.nextCursor === null || typeof parsed.nextCursor === 'string')
    || typeof parsed.complete !== 'boolean'
    || parsed.complete !== (parsed.nextCursor === null)) {
    throw new Error('Malformed scheduled task runs response');
  }
  return {
    runs: parsed.runs,
    nextCursor: parsed.nextCursor,
    complete: parsed.complete,
  };
};

/** Editor create/update — Cap PUT. Callers must surface failures; never fake-success. */
export const upsertScheduledTask = async (
  runtimeFetch: LynxRuntimeFetch,
  projectId: string,
  task: Partial<LynxScheduledTask>,
): Promise<LynxScheduledTask[]> => {
  const safeProjectID = projectId.trim();
  if (!safeProjectID) throw new Error('projectId is required');
  const response = await runtimeFetch(
    `/api/projects/${encodeURIComponent(safeProjectID)}/scheduled-tasks`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ task }),
    },
  );
  await ensureOk(response, 'Failed to save schedule');
  const parsed = await response.json() as { tasks?: unknown };
  if (!parsed || !Array.isArray(parsed.tasks)) return [];
  return parsed.tasks.filter(isTask);
};
