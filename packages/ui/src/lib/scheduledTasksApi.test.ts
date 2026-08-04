import { beforeEach, describe, expect, mock, test } from 'bun:test';

let responseStatus = 200;
let responsePayload: unknown;
let seenPath = '';

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string) => {
    seenPath = path;
    return new Response(JSON.stringify(responsePayload), { status: responseStatus });
  },
}));

const { fetchScheduledTaskRuns } = await import('./scheduledTasksApi');

const validRun = {
  id: 'run-1',
  projectId: 'project-1',
  taskId: 'task-1',
  taskName: 'Nightly review',
  trigger: 'scheduled',
  status: 'success',
  sessionId: 'session-1',
  directory: '/workspace/project-1',
  error: null,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_003_000,
  durationMs: 3_000,
} as const;

describe('fetchScheduledTaskRuns', () => {
  beforeEach(() => {
    responseStatus = 200;
    responsePayload = { runs: [validRun], nextCursor: 'cursor-2', complete: false };
    seenPath = '';
  });

  test('builds the global history URL with opaque cursor and filters', async () => {
    const result = await fetchScheduledTaskRuns({
      before: 'opaque cursor/+',
      limit: 20,
      projectId: 'project-1',
      taskId: 'task-1',
    });

    expect(seenPath).toBe('/api/openchamber/scheduled-task-runs?before=opaque+cursor%2F%2B&limit=20&projectId=project-1&taskId=task-1');
    expect(result).toEqual(responsePayload);
  });

  test('uses the bounded default page size', async () => {
    await fetchScheduledTaskRuns({});
    expect(seenPath).toBe('/api/openchamber/scheduled-task-runs?limit=20');
  });

  test('rejects malformed authoritative responses', async () => {
    responsePayload = { runs: [{ ...validRun, startedAt: 'yesterday' }], nextCursor: null, complete: true };
    await expect(fetchScheduledTaskRuns({})).rejects.toThrow('Malformed scheduled task runs response');

    responsePayload = { runs: [], nextCursor: 42, complete: true };
    await expect(fetchScheduledTaskRuns({})).rejects.toThrow('Malformed scheduled task runs response');

    responsePayload = { runs: [], nextCursor: null, complete: false };
    await expect(fetchScheduledTaskRuns({})).rejects.toThrow('Malformed scheduled task runs response');

    responsePayload = { runs: [], nextCursor: 'unexpected', complete: true };
    await expect(fetchScheduledTaskRuns({})).rejects.toThrow('Malformed scheduled task runs response');
  });

  test('throws HTTP failures', async () => {
    responseStatus = 503;
    responsePayload = { error: 'History is temporarily unavailable' };
    await expect(fetchScheduledTaskRuns({})).rejects.toThrow('History is temporarily unavailable');
  });
});
