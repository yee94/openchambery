import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(),
}));

const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
const {
  computeNextRunAt,
  createScheduledTasksRuntime,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
} = await import('./runtime.js');

const scheduledTask = {
  id: 'task-1',
  name: 'Task',
  enabled: true,
  schedule: { kind: 'daily', times: ['23:59'], timezone: 'UTC' },
  execution: { prompt: 'run', providerID: 'openai', modelID: 'gpt-4.1' },
  state: { createdAt: 1, updatedAt: 1, lastStatus: 'idle' },
};

const createRuntime = (updateScheduledTaskState, overrides = {}) => createScheduledTasksRuntime({
  projectConfigRuntime: {
    listScheduledTasks: vi.fn(async () => [scheduledTask]),
    updateScheduledTaskState,
    upsertScheduledTask: vi.fn(),
  },
  listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
  buildOpenCodeUrl: vi.fn(() => 'http://127.0.0.1:4096'),
  getOpenCodeAuthHeaders: vi.fn(() => ({})),
  waitForOpenCodeReady: vi.fn(async () => {
    throw new Error('OpenCode unavailable');
  }),
  logger: { info: vi.fn(), warn: vi.fn() },
  ...overrides,
});

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with Scheduled prefix and timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('[Scheduled] Morning Sync 2025-03-10 07:05');
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it('truncates long task names so the Scheduled title stays within 120 chars', () => {
    const title = formatScheduledSessionTitle({
      name: 'A'.repeat(200),
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title.startsWith('[Scheduled] ')).toBe(true);
    expect(title.endsWith(' 2025-03-10 07:05')).toBe(true);
    expect(title.length).toBe(120);
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });
});

describe('scheduled-tasks runtime cleanup', () => {
  it('releases the running lock after the initial running-state write fails', async () => {
    let calls = 0;
    const updateScheduledTaskState = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('initial state write failed');
      }
      return { task: scheduledTask };
    });
    const runtime = createRuntime(updateScheduledTaskState);
    await runtime.syncProject('project-1');

    const first = await runtime.runNow('project-1', 'task-1');
    const second = await runtime.runNow('project-1', 'task-1');

    expect(first).toMatchObject({ ok: false, status: 'error', error: 'initial state write failed' });
    expect(second.running).toBeUndefined();
    expect(updateScheduledTaskState).toHaveBeenCalledTimes(5);
    expect(runtime.getStatus().hasRunningScheduledTasks).toBe(false);
  });

  it('releases the running lock after the final state write fails', async () => {
    let calls = 0;
    const updateScheduledTaskState = vi.fn(async () => {
      calls += 1;
      if (calls === 3) {
        throw new Error('final state write failed');
      }
      return { task: scheduledTask };
    });
    const runtime = createRuntime(updateScheduledTaskState);
    await runtime.syncProject('project-1');

    const first = await runtime.runNow('project-1', 'task-1');
    const second = await runtime.runNow('project-1', 'task-1');

    expect(first).toMatchObject({ ok: false, status: 'error', error: 'final state write failed' });
    expect(second.running).toBeUndefined();
    expect(updateScheduledTaskState).toHaveBeenCalledTimes(5);
    expect(runtime.getStatus().hasRunningScheduledTasks).toBe(false);
  });
});

describe('scheduled-tasks project sync isolation', () => {
  it('continues syncing projects after one project fails and retries the failed project', async () => {
    vi.useFakeTimers();
    const projectConfigRuntime = {
      listScheduledTasks: vi.fn(async (projectID) => {
        if (projectID === 'project-1' && projectConfigRuntime.listScheduledTasks.mock.calls.filter(([id]) => id === projectID).length === 1) {
          throw new Error('project-1 config is unavailable');
        }
        return [{ ...scheduledTask, id: `${projectID}-task` }];
      }),
      updateScheduledTaskState: vi.fn(async (_projectID, _taskID, state) => ({
        task: { ...scheduledTask, state },
      })),
      upsertScheduledTask: vi.fn(),
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: vi.fn(async () => [
        { id: 'project-1', path: '/tmp/project-1' },
        { id: 'project-2', path: '/tmp/project-2' },
      ]),
      buildOpenCodeUrl: vi.fn(),
      getOpenCodeAuthHeaders: vi.fn(),
    });

    await runtime.start();

    expect(projectConfigRuntime.listScheduledTasks).toHaveBeenCalledWith('project-2');
    expect(runtime.getStatus().hasEnabledScheduledTasks).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(projectConfigRuntime.listScheduledTasks).toHaveBeenCalledTimes(3);
    expect(projectConfigRuntime.listScheduledTasks).toHaveBeenLastCalledWith('project-1');
    runtime.stop();
    vi.useRealTimers();
  });

  it('bounds failed project sync retries', async () => {
    vi.useFakeTimers();
    const listScheduledTasks = vi.fn(async () => {
      throw new Error('config is unavailable');
    });
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks,
        updateScheduledTaskState: vi.fn(),
        upsertScheduledTask: vi.fn(),
      },
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
      buildOpenCodeUrl: vi.fn(),
      getOpenCodeAuthHeaders: vi.fn(),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(listScheduledTasks).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(listScheduledTasks).toHaveBeenCalledTimes(4);
    runtime.stop();
    vi.useRealTimers();
  });

  it('clears pending project sync retries on stop', async () => {
    vi.useFakeTimers();
    const listScheduledTasks = vi.fn(async () => {
      throw new Error('config is unavailable');
    });
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks,
        updateScheduledTaskState: vi.fn(),
        upsertScheduledTask: vi.fn(),
      },
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
      buildOpenCodeUrl: vi.fn(),
      getOpenCodeAuthHeaders: vi.fn(),
    });

    await runtime.start();
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(listScheduledTasks).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('scheduled-tasks run history and session lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createOpencodeClient.mockReset();
  });

  const createHistoryStore = () => {
    const runs = new Map();
    return {
      startRun: vi.fn((record) => {
        const id = record.id;
        runs.set(id, { ...record, status: 'running', sessionId: null });
        return { id, status: 'running' };
      }),
      attachSession: vi.fn((runID, sessionID) => {
        const run = runs.get(runID);
        if (!run) throw new Error('run not found');
        run.sessionId = sessionID;
        return { id: runID, sessionId: sessionID };
      }),
      finishRun: vi.fn((runID, result) => {
        const run = runs.get(runID);
        if (!run) throw new Error('run not found');
        Object.assign(run, result);
        return { id: runID, ...result };
      }),
      runs,
    };
  };

  const createSuccessfulClient = ({
    updateResult,
    sessionID = 'ses_1',
    /** Override session settlement polls after prompt/command admission. */
    settlement = 'success',
  } = {}) => {
    const create = vi.fn(async () => ({ data: { id: sessionID } }));
    const update = vi.fn(async () => updateResult ?? { data: { id: sessionID } });
    const command = vi.fn(async () => ({ data: {} }));
    const abort = vi.fn(async () => ({ data: true }));
    const list = vi.fn(async () => ({ data: [] }));
    // Default settlement: idle + completed assistant so history records the real
    // turn outcome (not prompt_async admission alone).
    let poll = 0;
    const status = vi.fn(async () => {
      poll += 1;
      if (settlement === 'busy-then-success' && poll < 2) {
        return { data: { [sessionID]: { type: 'busy' } } };
      }
      return { data: { [sessionID]: { type: 'idle' } } };
    });
    const messages = vi.fn(async () => {
      if (settlement === 'assistant-error') {
        return {
          data: [{
            info: {
              id: 'msg_err',
              role: 'assistant',
              error: { name: 'ProviderError', message: 'upstream failed' },
            },
          }],
        };
      }
      if (settlement === 'busy-then-success') {
        if (poll < 2) {
          return { data: [{ info: { id: 'msg_user', role: 'user' } }] };
        }
      }
      return {
        data: [{
          info: {
            id: 'msg_ok',
            role: 'assistant',
            time: { completed: Date.now() },
          },
        }],
      };
    });
    const get = vi.fn(async () => {
      if (settlement === 'goal-complete') {
        return {
          data: {
            id: sessionID,
            metadata: {
              openchamber: {
                goal: { id: 'g1', status: 'complete', objective: 'done' },
              },
            },
          },
        };
      }
      if (settlement === 'goal-blocked') {
        return {
          data: {
            id: sessionID,
            metadata: {
              openchamber: {
                goal: { id: 'g1', status: 'blocked', objective: 'x', note: 'stuck' },
              },
            },
          },
        };
      }
      return { data: { id: sessionID, metadata: {} } };
    });
    createOpencodeClient.mockReturnValue({
      session: { create, update, command, abort, status, messages, get },
      command: { list },
    });
    return { create, update, command, abort, list, status, messages, get };
  };

  const settledSessionApis = (sessionID = 'ses_1') => ({
    status: vi.fn(async () => ({ data: { [sessionID]: { type: 'idle' } } })),
    messages: vi.fn(async () => ({
      data: [{ info: { id: 'msg_ok', role: 'assistant', time: { completed: Date.now() } } }],
    })),
    get: vi.fn(async () => ({ data: { id: sessionID, metadata: {} } })),
  });

  it('creates session with Scheduled title and scheduledTask metadata, attaches history, archives before prompt', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(true);
    expect(history.startRun).toHaveBeenCalledTimes(1);
    const started = history.startRun.mock.calls[0][0];
    expect(started).toMatchObject({
      projectId: 'project-1',
      taskId: 'task-1',
      taskName: 'Task',
      trigger: 'manual',
      directory: '/tmp/project-1',
    });
    expect(typeof started.id).toBe('string');

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/project-1',
      title: expect.stringMatching(/^\[Scheduled\] Task /),
      metadata: {
        openchamber: {
          scheduledTask: {
            projectID: 'project-1',
            taskID: 'task-1',
            runID: started.id,
            name: 'Task',
          },
        },
      },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(history.attachSession).toHaveBeenCalledWith(started.id, 'ses_1');
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/tmp/project-1',
      time: { archived: expect.any(Number) },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.update.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(history.finishRun).toHaveBeenCalledWith(started.id, expect.objectContaining({
      status: 'success',
      sessionId: 'ses_1',
    }));
    // Must wait for session settlement, not finish on prompt_async admission alone.
    expect(client.status).toHaveBeenCalled();
    expect(client.messages).toHaveBeenCalled();
    expect(client.status.mock.invocationCallOrder[0]).toBeGreaterThan(fetchMock.mock.invocationCallOrder[0]);

    vi.unstubAllGlobals();
  });

  it('records error outcome and real duration when the assistant turn fails after admission', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ settlement: 'assistant-error' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'error',
        error: 'ProviderError',
        sessionId: 'ses_1',
        durationMs: expect.any(Number),
      }),
    );
    expect(client.messages).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('keeps the run open while the session is busy and only finalizes after idle settlement', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({ settlement: 'busy-then-success' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    // First settlement poll sees busy and sleeps — history must still be open.
    await vi.advanceTimersByTimeAsync(0);
    expect(history.finishRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'success', sessionId: 'ses_1' }),
    );

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not prompt when archive fails and finalizes the run as error', async () => {
    const history = createHistoryStore();
    createSuccessfulClient({
      updateResult: { error: { status: 500, message: 'archive failed' } },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error' }),
    );

    vi.unstubAllGlobals();
  });

  it('retries archive once on 404 then prompts on success', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    const create = vi.fn(async () => ({ data: { id: 'ses_404' } }));
    const update = vi.fn()
      .mockResolvedValueOnce({ error: { status: 404 } })
      .mockResolvedValueOnce({ data: { id: 'ses_404' } });
    createOpencodeClient.mockReturnValue({
      session: { create, update, command: vi.fn(), ...settledSessionApis('ses_404') },
      command: { list: vi.fn(async () => ({ data: [] })) },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    await vi.advanceTimersByTimeAsync(250);
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('watchdog timeout aborts in-flight work, calls session.abort, and does not continue later stages', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let resolvePrompt;
    let promptStarted = false;
    let promptCompleted = false;
    const create = vi.fn(async () => ({ data: { id: 'ses_timeout' } }));
    const update = vi.fn(async () => ({ data: { id: 'ses_timeout' } }));
    const abort = vi.fn(async () => ({ data: true }));
    const command = vi.fn(async () => {
      throw new Error('command must not run after hanging prompt path');
    });
    const list = vi.fn(async () => ({ data: [] }));
    createOpencodeClient.mockReturnValue({
      session: { create, update, command, abort },
      command: { list },
    });

    const fetchMock = vi.fn((url, init) => {
      if (String(url).includes('prompt_async')) {
        promptStarted = true;
        return new Promise((resolve, reject) => {
          resolvePrompt = () => {
            promptCompleted = true;
            resolve({ ok: true, text: async () => '' });
          };
          const signal = init?.signal;
          if (signal) {
            const onAbort = () => {
              reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      maxRunDurationMs: 1_000,
    });
    await runtime.syncProject('project-1');

    const unhandled = [];
    const onUnhandled = (reason) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const runPromise = runtime.runNow('project-1', 'task-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(promptStarted).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await runPromise;

      expect(result.ok).toBe(false);
      expect(result.status).toBe('error');
      expect(result.error).toBe('schedule run timed out');
      expect(abort).toHaveBeenCalledWith({
        sessionID: 'ses_timeout',
        directory: '/tmp/project-1',
      });
      expect(promptCompleted).toBe(false);
      expect(command).not.toHaveBeenCalled();

      const started = history.startRun.mock.calls[0][0];
      expect(history.attachSession).toHaveBeenCalledWith(started.id, 'ses_timeout');
      expect(history.finishRun).toHaveBeenCalledWith(
        started.id,
        expect.objectContaining({
          status: 'error',
          error: 'schedule run timed out',
        }),
      );
      // Attach keeps the session openable from history even after timeout.
      expect(history.runs.get(started.id).sessionId).toBe('ses_timeout');

      // Flush any microtasks from the aborted runPromise swallow path.
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      resolvePrompt?.();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('watchdog timeout during hanging command aborts session and never prompt_async', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let commandReached = false;
    const create = vi.fn(async () => ({ data: { id: 'ses_cmd' } }));
    const update = vi.fn(async () => ({ data: { id: 'ses_cmd' } }));
    const abort = vi.fn(async () => ({ data: true }));
    const command = vi.fn((_params, options) => {
      commandReached = true;
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          return;
        }
        const onAbort = () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    const list = vi.fn(async () => ({ data: [{ name: 'review' }] }));
    createOpencodeClient.mockReturnValue({
      session: { create, update, command, abort },
      command: { list },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('prompt_async must not run when command is selected');
    });
    vi.stubGlobal('fetch', fetchMock);

    const taskWithCommand = {
      ...scheduledTask,
      execution: {
        ...scheduledTask.execution,
        prompt: '/review src',
      },
    };
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...taskWithCommand, state: { ...taskWithCommand.state, ...state } },
    }));
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: vi.fn(async () => [taskWithCommand]),
        updateScheduledTaskState,
        upsertScheduledTask: vi.fn(),
      },
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
      buildOpenCodeUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      getOpenCodeAuthHeaders: vi.fn(() => ({})),
      waitForOpenCodeReady: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
      maxRunDurationMs: 500,
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(commandReached).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    const result = await runPromise;

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      error: 'schedule run timed out',
    });
    expect(abort).toHaveBeenCalledWith({
      sessionID: 'ses_cmd',
      directory: '/tmp/project-1',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('watchdog timeout during hanging small-model distill returns without waiting and blocks later goal stages', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let resolveDistill;
    let distillStarted = false;
    const create = vi.fn(async () => ({ data: { id: 'ses_distill' } }));
    const update = vi.fn(async () => ({ data: { id: 'ses_distill' } }));
    const abort = vi.fn(async () => ({ data: true }));
    const command = vi.fn(async () => {
      throw new Error('command must not run after hanging distill');
    });
    const list = vi.fn(async () => ({ data: [] }));
    createOpencodeClient.mockReturnValue({
      session: { create, update, command, abort },
      command: { list },
    });

    const fetchMock = vi.fn(async (url, init) => {
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const generateSmallModelText = vi.fn(() => {
      distillStarted = true;
      return new Promise((resolve) => {
        resolveDistill = () => resolve({ text: 'distilled criteria' });
      });
    });
    const getSmallModelService = vi.fn(async () => ({ generateSmallModelText }));

    // Oversized prompt forces small-model distill (threshold 5000).
    const largePrompt = `finish the migration ${'x'.repeat(5100)}`;
    const goalTask = {
      ...scheduledTask,
      execution: {
        ...scheduledTask.execution,
        prompt: largePrompt,
        goalEnabled: true,
        goalTokenBudget: 12_000,
      },
    };
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...goalTask, state: { ...goalTask.state, ...state } },
    }));
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: vi.fn(async () => [goalTask]),
        updateScheduledTaskState,
        upsertScheduledTask: vi.fn(),
      },
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
      buildOpenCodeUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      getOpenCodeAuthHeaders: vi.fn(() => ({})),
      getSmallModelService,
      waitForOpenCodeReady: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
      maxRunDurationMs: 1_000,
    });
    await runtime.syncProject('project-1');

    const unhandled = [];
    const onUnhandled = (reason) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const runPromise = runtime.runNow('project-1', 'task-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(distillStarted).toBe(true);
      expect(generateSmallModelText).toHaveBeenCalled();

      // Timeout must return while distill is still gated (non-cancellable).
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await runPromise;

      expect(result.ok).toBe(false);
      expect(result.status).toBe('error');
      expect(result.error).toBe('schedule run timed out');
      expect(abort).toHaveBeenCalledWith({
        sessionID: 'ses_distill',
        directory: '/tmp/project-1',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();

      const started = history.startRun.mock.calls[0][0];
      expect(history.attachSession).toHaveBeenCalledWith(started.id, 'ses_distill');
      expect(history.finishRun).toHaveBeenCalledWith(
        started.id,
        expect.objectContaining({
          status: 'error',
          error: 'schedule run timed out',
        }),
      );

      // Release distill after finalize; abort gate must block goal PATCH / prompt.
      resolveDistill?.();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      resolveDistill?.();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('goalEnabled PATCH preserves scheduledTask marker alongside goal', async () => {
    const history = createHistoryStore();
    // Goal runs settle on terminal goal metadata, not the first idle turn.
    const client = createSuccessfulClient({ sessionID: 'ses_goal', settlement: 'goal-complete' });
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('/session/ses_goal') && init?.method === 'PATCH') {
        return { ok: true, text: async () => '' };
      }
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const goalTask = {
      ...scheduledTask,
      execution: {
        ...scheduledTask.execution,
        prompt: 'finish the migration',
        goalEnabled: true,
        goalTokenBudget: 12_000,
      },
    };
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...goalTask, state: { ...goalTask.state, ...state } },
    }));
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: vi.fn(async () => [goalTask]),
        updateScheduledTaskState,
        upsertScheduledTask: vi.fn(),
      },
      listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
      buildOpenCodeUrl: vi.fn(() => 'http://127.0.0.1:4096'),
      getOpenCodeAuthHeaders: vi.fn(() => ({})),
      waitForOpenCodeReady: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(true);
    expect(client.get).toHaveBeenCalled();
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/session/ses_goal') && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall[1].body);
    expect(body.metadata.openchamber.scheduledTask).toEqual({
      projectID: 'project-1',
      taskID: 'task-1',
      runID: history.startRun.mock.calls[0][0].id,
      name: 'Task',
    });
    expect(body.metadata.openchamber.goal).toMatchObject({
      status: 'active',
      tokenBudget: 12_000,
    });
    expect(typeof body.metadata.openchamber.goal.objectiveFile).toBe('boolean');
    expect(typeof body.metadata.openchamber.goal.objective).toBe('string');
    if (!body.metadata.openchamber.goal.objectiveFile) {
      expect(body.metadata.openchamber.goal.objective.length).toBeGreaterThan(0);
    }
    expect(client.abort).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('successful runs never call session.abort', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(true);
    expect(client.abort).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('persists lastSessionId when an error run still created a session', async () => {
    const history = createHistoryStore();
    createSuccessfulClient({ settlement: 'assistant-error' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    const finalPatch = updateScheduledTaskState.mock.calls.at(-1)[2];
    expect(finalPatch.lastStatus).toBe('error');
    expect(finalPatch.lastSessionId).toBe('ses_1');

    vi.unstubAllGlobals();
  });

  it('omits lastSessionId from the final patch when the failed run has no session', async () => {
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState);
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    const finalPatch = updateScheduledTaskState.mock.calls.at(-1)[2];
    expect(finalPatch.lastStatus).toBe('error');
    expect(Object.hasOwn(finalPatch, 'lastSessionId')).toBe(false);
  });

  it('marks lastStatus running when a history session continues, then success on idle', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ settlement: 'assistant-error' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const emitTaskRunEvent = vi.fn();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      emitTaskRunEvent,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');
    expect(result.status).toBe('error');
    expect(history.finishRun).toHaveBeenCalledTimes(1);

    await runtime.observeSessionEvent({
      payload: {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      },
    });

    expect(history.finishRun).toHaveBeenCalledTimes(1);
    const runningPatch = updateScheduledTaskState.mock.calls.at(-1)[2];
    expect(runningPatch).toEqual(expect.objectContaining({
      lastStatus: 'running',
      lastError: undefined,
      lastSessionId: 'ses_1',
    }));
    expect(Object.hasOwn(runningPatch, 'lastRunAt')).toBe(false);
    expect(emitTaskRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      projectID: 'project-1',
      taskID: 'task-1',
      status: 'running',
      sessionID: 'ses_1',
    }));

    client.messages.mockImplementation(async () => ({
      data: [{
        info: {
          id: 'msg_ok',
          role: 'assistant',
          time: { completed: Date.now() },
        },
      }],
    }));

    await runtime.observeSessionEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      },
    });

    expect(updateScheduledTaskState.mock.calls.at(-1)[2]).toEqual(expect.objectContaining({
      lastStatus: 'success',
      lastSessionId: 'ses_1',
    }));
    expect(history.finishRun).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('corrects lastStatus error → success on idle after a continuation, without rewriting history', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ settlement: 'assistant-error' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const emitTaskRunEvent = vi.fn();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      emitTaskRunEvent,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');
    expect(result.status).toBe('error');
    expect(history.finishRun).toHaveBeenCalledTimes(1);

    client.messages.mockImplementation(async () => ({
      data: [{
        info: {
          id: 'msg_ok',
          role: 'assistant',
          time: { completed: Date.now() },
        },
      }],
    }));

    await runtime.observeSessionEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      },
    });

    expect(history.finishRun).toHaveBeenCalledTimes(1);
    const correctionPatch = updateScheduledTaskState.mock.calls.at(-1)[2];
    expect(correctionPatch).toEqual(expect.objectContaining({
      lastStatus: 'success',
      lastError: undefined,
      lastSessionId: 'ses_1',
    }));
    expect(Object.hasOwn(correctionPatch, 'lastRunAt')).toBe(false);
    expect(Object.hasOwn(correctionPatch, 'lastDurationMs')).toBe(false);
    expect(Object.hasOwn(correctionPatch, 'nextRunAt')).toBe(false);
    expect(emitTaskRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      projectID: 'project-1',
      taskID: 'task-1',
      status: 'success',
      sessionID: 'ses_1',
    }));

    vi.unstubAllGlobals();
  });

  it('does not correct lastStatus while the task is still running', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    const erroredTask = {
      ...scheduledTask,
      state: {
        ...scheduledTask.state,
        lastStatus: 'error',
        lastSessionId: 'ses_1',
        lastError: 'ProviderError',
      },
    };
    createSuccessfulClient({ settlement: 'busy-then-success' });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const emitTaskRunEvent = vi.fn();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...erroredTask, state: { ...erroredTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      projectConfigRuntime: {
        listScheduledTasks: vi.fn(async () => [erroredTask]),
        updateScheduledTaskState,
        upsertScheduledTask: vi.fn(),
      },
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      emitTaskRunEvent,
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(history.finishRun).not.toHaveBeenCalled();

    const successEmitsBefore = emitTaskRunEvent.mock.calls.filter((call) => call[0].status === 'success').length;
    const continuationRunningBefore = updateScheduledTaskState.mock.calls.filter((call) => (
      call[2].lastStatus === 'running' && !Object.hasOwn(call[2], 'lastRunAt')
    )).length;
    await runtime.observeSessionEvent({
      payload: {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      },
    });
    await runtime.observeSessionEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      },
    });
    expect(history.finishRun).not.toHaveBeenCalled();
    expect(updateScheduledTaskState.mock.calls.map((call) => call[2].lastStatus)).not.toContain('success');
    expect(emitTaskRunEvent.mock.calls.filter((call) => call[0].status === 'success')).toHaveLength(successEmitsBefore);
    expect(updateScheduledTaskState.mock.calls.filter((call) => (
      call[2].lastStatus === 'running' && !Object.hasOwn(call[2], 'lastRunAt')
    ))).toHaveLength(continuationRunningBefore);

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;
    expect(result.ok).toBe(true);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not correct lastStatus when it is already success', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const emitTaskRunEvent = vi.fn();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      emitTaskRunEvent,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(true);
    expect(emitTaskRunEvent.mock.calls.map((call) => call[0].status)[0]).toBe('running');
    expect(history.finishRun).toHaveBeenCalledTimes(1);
    const stateWritesAfterRun = updateScheduledTaskState.mock.calls.length;
    const successEmitsAfterRun = emitTaskRunEvent.mock.calls.filter((call) => call[0].status === 'success').length;

    client.messages.mockImplementation(async () => ({
      data: [{
        info: {
          id: 'msg_ok',
          role: 'assistant',
          time: { completed: Date.now() },
        },
      }],
    }));

    await runtime.observeSessionEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_1',
          status: { type: 'idle' },
        },
      },
    });

    expect(history.finishRun).toHaveBeenCalledTimes(1);
    expect(updateScheduledTaskState).toHaveBeenCalledTimes(stateWritesAfterRun);
    expect(emitTaskRunEvent.mock.calls.filter((call) => call[0].status === 'success')).toHaveLength(successEmitsAfterRun);

    vi.unstubAllGlobals();
  });
});
