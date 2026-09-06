import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import * as client from '@/lib/openchamberClient';
import {
  deleteScheduledTask,
  fetchGlobalScheduledTasks,
  fetchScheduledTaskRuns,
  parseGlobalScheduledTasksResponse,
  parseScheduledTaskRunsResponse,
  patchTaskRunning,
  replaceProjectTasks,
  runScheduledTaskNow,
  upsertScheduledTask,
  type GlobalScheduledTasksResponse,
  type ScheduledTask,
} from '@/lib/scheduledTasksApi';

const active = {
  clientToken: 'tok',
  transport: { kind: 'direct', url: 'http://127.0.0.1:2606' },
} as ActiveRuntime;

afterEach(() => {
  vi.restoreAllMocks();
});

const mockJson = (status: number, body: unknown) => {
  vi.spyOn(client, 'openchamberFetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
};

const sampleTask = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  name: 'Daily report',
  enabled: true,
  schedule: { kind: 'daily', times: ['23:30'], timezone: 'Asia/Shanghai' },
  execution: { prompt: 'summarize', providerID: 'openai', modelID: 'gpt-4o' },
  state: {
    createdAt: 1,
    updatedAt: 2,
    nextRunAt: Date.now() + 3_600_000,
    lastStatus: 'success',
  },
  ...over,
});

describe('parseGlobalScheduledTasksResponse', () => {
  it('keeps failedProjectIds and composite entries', () => {
    const parsed = parseGlobalScheduledTasksResponse({
      tasks: [{ projectId: 'p1', task: sampleTask() }],
      failedProjectIds: ['p2'],
    });
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.projectId).toBe('p1');
    expect(parsed.failedProjectIds).toEqual(['p2']);
  });
});

describe('parseScheduledTaskRunsResponse', () => {
  it('rejects malformed complete/cursor pairs', () => {
    expect(() =>
      parseScheduledTaskRunsResponse({
        runs: [],
        nextCursor: 'abc',
        complete: true,
      }),
    ).toThrow(/Malformed/);
  });

  it('accepts a valid page', () => {
    const page = parseScheduledTaskRunsResponse({
      runs: [
        {
          id: 'r1',
          projectId: 'p1',
          taskId: 't1',
          taskName: 'Daily',
          trigger: 'manual',
          status: 'success',
          sessionId: 's1',
          directory: '/code',
          error: null,
          startedAt: 1000,
          finishedAt: 2000,
          durationMs: 1000,
        },
      ],
      nextCursor: null,
      complete: true,
    });
    expect(page.runs[0]?.taskName).toBe('Daily');
  });
});

describe('scheduled task HTTP APIs', () => {
  it('GETs /api/openchamber/scheduled-tasks', async () => {
    mockJson(200, {
      tasks: [{ projectId: 'p1', task: sampleTask() }],
      failedProjectIds: [],
    });
    const res = await fetchGlobalScheduledTasks(active);
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/scheduled-tasks',
      expect.any(Object),
    );
    expect(res.tasks[0]?.task.name).toBe('Daily report');
  });

  it('GETs history via /api/openchamber/scheduled-task-runs', async () => {
    mockJson(200, { runs: [], nextCursor: null, complete: true });
    await fetchScheduledTaskRuns(active, { limit: 20, projectId: 'p1', taskId: 't1' });
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      expect.stringContaining('/api/openchamber/scheduled-task-runs?'),
      expect.any(Object),
    );
    const path = vi.mocked(client.openchamberFetch).mock.calls[0]?.[1] as string;
    expect(path).toContain('projectId=p1');
    expect(path).toContain('taskId=t1');
  });

  it('PUTs project scheduled-tasks', async () => {
    mockJson(200, { tasks: [sampleTask({ name: 'Saved' })] });
    const tasks = await upsertScheduledTask(active, 'p1', {
      name: 'Saved',
      enabled: true,
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: { prompt: 'hi', providerID: 'openai', modelID: 'gpt-4o' },
    });
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/projects/p1/scheduled-tasks',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(tasks[0]?.name).toBe('Saved');
  });

  it('DELETEs project scheduled-tasks/{id}', async () => {
    mockJson(200, { tasks: [] });
    await deleteScheduledTask(active, 'p1', 't1');
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/projects/p1/scheduled-tasks/t1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('POSTs run endpoint', async () => {
    mockJson(200, { sessionId: 'sess-1' });
    const result = await runScheduledTaskNow(active, 'p1', 't1');
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/projects/p1/scheduled-tasks/t1/run',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.sessionId).toBe('sess-1');
  });
});

describe('optimistic running + replaceProjectTasks', () => {
  it('patches lastStatus to running without dropping siblings', () => {
    const current: GlobalScheduledTasksResponse = {
      tasks: [
        { projectId: 'p1', task: sampleTask({ id: 't1', name: 'A' }) },
        { projectId: 'p1', task: sampleTask({ id: 't2', name: 'B', enabled: false }) },
        { projectId: 'p2', task: sampleTask({ id: 't9', name: 'Other' }) },
      ],
      failedProjectIds: ['px'],
    };
    const patched = patchTaskRunning(current, 'p1', 't1', 99_000);
    expect(patched?.tasks.find((e) => e.task.id === 't1')?.task.state.lastStatus).toBe('running');
    expect(patched?.tasks.find((e) => e.task.id === 't2')?.task.name).toBe('B');
    expect(patched?.tasks.find((e) => e.projectId === 'p2')?.task.id).toBe('t9');
    expect(patched?.failedProjectIds).toEqual(['px']);
  });

  it('replaceProjectTasks swaps one project only', () => {
    const current: GlobalScheduledTasksResponse = {
      tasks: [
        { projectId: 'p1', task: sampleTask({ id: 'old' }) },
        { projectId: 'p2', task: sampleTask({ id: 'keep' }) },
      ],
      failedProjectIds: ['p1', 'p3'],
    };
    const next = replaceProjectTasks(current, 'p1', [sampleTask({ id: 'new', name: 'New' })]);
    expect(next.tasks.map((e) => `${e.projectId}:${e.task.id}`).sort()).toEqual([
      'p1:new',
      'p2:keep',
    ]);
    expect(next.failedProjectIds).toEqual(['p3']);
  });
});
