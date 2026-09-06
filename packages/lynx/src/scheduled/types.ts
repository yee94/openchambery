export type LynxScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error';

export type LynxScheduledTask = {
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
  };
  state: {
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: LynxScheduledTaskStatus;
    lastError?: string;
    nextRunAt?: number;
  };
};

export type LynxGlobalScheduledTask = {
  projectId: string;
  task: LynxScheduledTask;
};

export type LynxGlobalScheduledTasksResponse = {
  tasks: LynxGlobalScheduledTask[];
  failedProjectIds: string[];
};

export type LynxScheduledTaskRun = {
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

export type LynxScheduledTaskRunsPage = {
  runs: LynxScheduledTaskRun[];
  nextCursor: string | null;
  complete: boolean;
};

export type LynxScheduledLoadResult =
  | { status: 'ok'; response: LynxGlobalScheduledTasksResponse }
  | { status: 'failed'; error: Error }
  | { status: 'no-runtime' };
