import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduledTaskRunHistoryStore } from './run-history-store.js';

const directories = [];

const createTempDbPath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-run-history-'));
  directories.push(dir);
  return path.join(dir, 'scheduled-task-runs.sqlite');
};

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const startSample = (store, overrides = {}) => store.startRun({
  id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 10)}`,
  projectId: overrides.projectId ?? 'project-a',
  taskId: overrides.taskId ?? 'task-1',
  taskName: overrides.taskName ?? 'Morning Sync',
  trigger: overrides.trigger ?? 'scheduled',
  directory: overrides.directory ?? '/tmp/project-a',
  startedAt: overrides.startedAt,
});

describe('scheduled task run history store', () => {
  it('lists runs newest-first and supports stable keyset pagination', () => {
    let now = 1_000;
    const store = createScheduledTaskRunHistoryStore({
      dbPath: createTempDbPath(),
      clock: () => now,
    });

    const a = startSample(store, { id: 'run-a', startedAt: 100 });
    store.finishRun(a.id, { status: 'success', finishedAt: 110 });
    const b = startSample(store, { id: 'run-b', startedAt: 200 });
    store.finishRun(b.id, { status: 'error', error: 'boom', finishedAt: 220 });
    // Same startedAt as b; run_id DESC should place run-c before run-b when ties.
    const c = startSample(store, { id: 'run-c', startedAt: 200 });
    store.finishRun(c.id, { status: 'success', finishedAt: 230 });
    const d = startSample(store, { id: 'run-d', startedAt: 300 });
    store.finishRun(d.id, { status: 'success', finishedAt: 310 });

    const first = store.listRuns({ limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual(['run-d', 'run-c']);
    expect(first.complete).toBe(false);
    expect(typeof first.nextCursor).toBe('string');

    const second = store.listRuns({ before: first.nextCursor, limit: 2 });
    expect(second.runs.map((run) => run.id)).toEqual(['run-b', 'run-a']);
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeNull();

    // Stable: same cursor must not repeat or skip when replaying.
    const replay = store.listRuns({ before: first.nextCursor, limit: 2 });
    expect(replay.runs.map((run) => run.id)).toEqual(['run-b', 'run-a']);

    store.close();
  });

  it('filters by projectId and taskId', () => {
    const store = createScheduledTaskRunHistoryStore({ dbPath: createTempDbPath() });

    startSample(store, { id: 'p1-t1', projectId: 'p1', taskId: 't1', startedAt: 10 });
    startSample(store, { id: 'p1-t2', projectId: 'p1', taskId: 't2', startedAt: 20 });
    startSample(store, { id: 'p2-t1', projectId: 'p2', taskId: 't1', startedAt: 30 });

    expect(store.listRuns({ projectID: 'p1' }).runs.map((run) => run.id)).toEqual(['p1-t2', 'p1-t1']);
    expect(store.listRuns({ taskID: 't1' }).runs.map((run) => run.id)).toEqual(['p2-t1', 'p1-t1']);
    expect(store.listRuns({ projectID: 'p1', taskID: 't1' }).runs.map((run) => run.id)).toEqual(['p1-t1']);

    store.close();
  });

  it('converges leftover running rows to error on open', () => {
    const dbPath = createTempDbPath();
    let now = 1_000;
    const first = createScheduledTaskRunHistoryStore({
      dbPath,
      clock: () => now,
    });
    const running = startSample(first, { id: 'orphan', startedAt: 500 });
    first.attachSession(running.id, 'ses_orphan');
    first.close();

    now = 2_500;
    const reopened = createScheduledTaskRunHistoryStore({
      dbPath,
      clock: () => now,
    });
    const listed = reopened.listRuns({ limit: 10 });
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({
      id: 'orphan',
      status: 'error',
      sessionId: 'ses_orphan',
      startedAt: 500,
      finishedAt: 2_500,
      durationMs: 2_000,
    });
    expect(typeof listed.runs[0].error).toBe('string');
    expect(listed.runs[0].error.length).toBeGreaterThan(0);

    reopened.close();
  });

  it('returns camelCase DTOs and empty success pages', () => {
    const store = createScheduledTaskRunHistoryStore({ dbPath: createTempDbPath() });
    const empty = store.listRuns({});
    expect(empty).toEqual({ runs: [], nextCursor: null, complete: true });

    const started = startSample(store, {
      id: 'run-dto',
      projectId: 'proj',
      taskId: 'task',
      taskName: 'Nightly',
      trigger: 'manual',
      directory: '/repo',
      startedAt: 42,
    });
    store.attachSession(started.id, 'ses_1');
    store.finishRun(started.id, { status: 'success', finishedAt: 100 });

    const page = store.listRuns({ limit: 1 });
    expect(page.runs[0]).toEqual({
      id: 'run-dto',
      projectId: 'proj',
      taskId: 'task',
      taskName: 'Nightly',
      trigger: 'manual',
      status: 'success',
      sessionId: 'ses_1',
      directory: '/repo',
      error: null,
      startedAt: 42,
      finishedAt: 100,
      durationMs: 58,
    });
    expect(page.complete).toBe(true);

    store.close();
  });

  it('rejects invalid list cursors', () => {
    const store = createScheduledTaskRunHistoryStore({ dbPath: createTempDbPath() });
    expect(() => store.listRuns({ before: 'not-a-cursor' })).toThrow(/cursor/i);
    store.close();
  });

  it('rejects non-integer and non-positive limits', () => {
    const store = createScheduledTaskRunHistoryStore({ dbPath: createTempDbPath() });
    expect(() => store.listRuns({ limit: 1.5 })).toThrow(/limit/i);
    expect(() => store.listRuns({ limit: '1.5' })).toThrow(/limit/i);
    expect(() => store.listRuns({ limit: 0 })).toThrow(/limit/i);
    expect(() => store.listRuns({ limit: -3 })).toThrow(/limit/i);
    store.close();
  });
});
