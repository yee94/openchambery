import { describe, expect, test } from 'vitest';

import type { LynxHttpResponse } from '../connection/types';
import { deleteScheduledTask, loadGlobalScheduledTasks, loadScheduledTaskRuns, runScheduledTaskNow, upsertScheduledTask } from './api';

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const task = {
  id: 'task_1',
  name: 'Morning digest',
  enabled: true,
  schedule: { kind: 'daily', times: ['09:00'] },
  execution: { prompt: 'summarize', providerID: 'anthropic', modelID: 'claude' },
  state: { createdAt: 1, updatedAt: 2 },
};

describe('scheduled tasks API', () => {
  test('loads Cap global list and keeps failedProjectIds', async () => {
    const result = await loadGlobalScheduledTasks(async (path) => {
      expect(path).toBe('/api/openchamber/scheduled-tasks');
      return jsonResponse(200, {
        tasks: [{ projectId: '/repo', task }],
        failedProjectIds: ['/other'],
      });
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.response.tasks).toHaveLength(1);
    expect(result.response.failedProjectIds).toEqual(['/other']);
  });

  test('null runtime is no-runtime, never fake-success empty', async () => {
    expect(await loadGlobalScheduledTasks(null)).toEqual({ status: 'no-runtime' });
  });

  test('HTTP failure is failed', async () => {
    const result = await loadGlobalScheduledTasks(async () => jsonResponse(503, { error: 'down' }));
    expect(result.status).toBe('failed');
  });

  test('history hits Cap scheduled-task-runs route', async () => {
    const page = await loadScheduledTaskRuns(async (path) => {
      expect(path.startsWith('/api/openchamber/scheduled-task-runs?')).toBe(true);
      return jsonResponse(200, {
        runs: [{
          id: 'run_1',
          projectId: '/repo',
          taskId: 'task_1',
          taskName: 'Morning digest',
          trigger: 'scheduled',
          status: 'success',
          sessionId: 'ses_1',
          directory: '/repo',
          error: null,
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
        }],
        nextCursor: null,
        complete: true,
      });
    });
    expect(page.runs).toHaveLength(1);
    expect(page.complete).toBe(true);
  });


  test('delete hits Cap DELETE route', async () => {
    const tasks = await deleteScheduledTask(async (path, init) => {
      expect(path).toBe('/api/projects/%2Frepo/scheduled-tasks/task_1');
      expect(init?.method).toBe('DELETE');
      return jsonResponse(200, { tasks: [task] });
    }, '/repo', 'task_1');
    expect(tasks[0]?.id).toBe('task_1');
  });

  test('delete requires ids', async () => {
    await expect(deleteScheduledTask(async () => jsonResponse(200, { tasks: [] }), '', 'task_1')).rejects.toThrow(/projectId/);
    await expect(deleteScheduledTask(async () => jsonResponse(200, { tasks: [] }), '/repo', '  ')).rejects.toThrow(/taskId/);
  });

  test('run now hits Cap POST /run and returns sessionId', async () => {
    const result = await runScheduledTaskNow(async (path, init) => {
      expect(path).toBe('/api/projects/%2Frepo/scheduled-tasks/task_1/run');
      expect(init?.method).toBe('POST');
      return jsonResponse(200, { sessionId: 'ses_run' });
    }, '/repo', 'task_1');
    expect(result.sessionId).toBe('ses_run');
  });

  test('run now omits empty sessionId', async () => {
    const result = await runScheduledTaskNow(async () => jsonResponse(200, {}), '/repo', 'task_1');
    expect(result.sessionId).toBeUndefined();
  });

  test('run now HTTP failure throws (never fake-success)', async () => {
    await expect(runScheduledTaskNow(async () => jsonResponse(500, { error: 'nope' }), '/repo', 'task_1')).rejects.toThrow(/Failed to run/);
  });

  test('upsert editor hook uses Cap PUT', async () => {
    const tasks = await upsertScheduledTask(async (path, init) => {
      expect(path).toBe('/api/projects/%2Frepo/scheduled-tasks');
      expect(init?.method).toBe('PUT');
      return jsonResponse(200, { tasks: [task] });
    }, '/repo', { name: 'Morning digest' });
    expect(tasks[0]?.id).toBe('task_1');
  });
});
