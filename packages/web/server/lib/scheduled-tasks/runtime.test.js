import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../opencode/v2-client.js', () => ({
  makeOpenCodeV2Client: vi.fn(),
}));

vi.mock('../session-goal/objectives.js', () => ({
  writeObjective: vi.fn(async () => ({ content: 'ok' })),
}));

const { makeOpenCodeV2Client } = await import('../opencode/v2-client.js');
const { writeObjective } = await import('../session-goal/objectives.js');
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

describe('scheduled-tasks v2 cutover residuals', () => {
  it('runtime source has no 1.x SDK, HeyAPI wrappers, or retired session APIs', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'), 'utf8');
    expect(source).not.toContain('@opencode-ai/sdk');
    expect(source).not.toContain('createOpencodeClient');
    expect(source).not.toContain('prompt_async');
    expect(source).not.toContain('session.abort');
    expect(source).not.toContain('session.status');
    expect(source).not.toContain('session.messages');
    expect(source).not.toContain('session.update');
    expect(source).not.toContain('time: { archived');
    expect(source).not.toContain('result?.error');
  });
});

describe('scheduled-tasks run history and session lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    makeOpenCodeV2Client.mockReset();
    writeObjective.mockClear();
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
    sessionID = 'ses_1',
    /** Override session settlement polls after prompt/command admission. */
    settlement = 'success',
    activeImpl,
    messageListImpl,
  } = {}) => {
    const create = vi.fn(async () => ({ id: sessionID }));
    const prompt = vi.fn(async () => ({ id: 'inbox_1', type: 'user' }));
    const command = vi.fn(async () => ({ id: 'inbox_1', type: 'user' }));
    const interrupt = vi.fn(async () => undefined);
    const list = vi.fn(async () => ({ data: [] }));
    // Default settlement: idle (absent from active map) + completed assistant
    // so history records the real turn outcome (not prompt admission alone).
    let poll = 0;
    const active = vi.fn(async () => {
      if (typeof activeImpl === 'function') {
        return activeImpl();
      }
      poll += 1;
      if (settlement === 'busy-then-success' && poll < 2) {
        return { [sessionID]: { type: 'running' } };
      }
      return {};
    });
    const messageList = vi.fn(async () => {
      if (typeof messageListImpl === 'function') {
        return messageListImpl();
      }
      if (settlement === 'assistant-error') {
        return {
          data: [{
            id: 'msg_err',
            type: 'assistant',
            error: { name: 'ProviderError', message: 'upstream failed' },
          }],
        };
      }
      if (settlement === 'busy-then-success' && poll < 2) {
        return { data: [{ id: 'msg_user', type: 'user' }] };
      }
      return {
        data: [{
          id: 'msg_ok',
          type: 'assistant',
          time: { completed: Date.now() },
        }],
      };
    });
    const get = vi.fn(async () => ({
      id: sessionID,
      location: { directory: '/tmp/project-1' },
    }));
    makeOpenCodeV2Client.mockReturnValue({
      session: { create, prompt, command, interrupt, active, get },
      message: { list: messageList },
      command: { list },
    });
    return { create, prompt, command, interrupt, list, active, messageList, get };
  };

  it('creates session with Scheduled title and location, attaches history, then prompts via session.prompt', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();

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

    expect(makeOpenCodeV2Client).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      authHeaders: {},
    });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      location: { directory: '/tmp/project-1' },
      title: expect.stringMatching(/^\[Scheduled\] Task /),
      model: { id: 'gpt-4.1', providerID: 'openai' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.create.mock.calls[0][0].metadata).toBeUndefined();
    expect(client.create.mock.calls[0][0].directory).toBeUndefined();
    expect(history.attachSession).toHaveBeenCalledWith(started.id, 'ses_1');
    expect(client.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      text: 'run',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(history.finishRun).toHaveBeenCalledWith(started.id, expect.objectContaining({
      status: 'success',
      sessionId: 'ses_1',
    }));
    // Must wait for session settlement, not finish on prompt admission alone.
    expect(client.active).toHaveBeenCalled();
    expect(client.messageList).toHaveBeenCalled();
    expect(client.active.mock.invocationCallOrder[0]).toBeGreaterThan(client.prompt.mock.invocationCallOrder[0]);
  });

  it('records error outcome and real duration when the assistant turn fails after admission', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ settlement: 'assistant-error' });

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
    expect(client.messageList).toHaveBeenCalled();
  });

  it('keeps the run open while the session is in the active map and only finalizes after idle settlement', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({ settlement: 'busy-then-success' });

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    // First settlement poll sees membership and sleeps — history must still be open.
    await vi.advanceTimersByTimeAsync(0);
    expect(history.finishRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'success', sessionId: 'ses_1' }),
    );

    vi.useRealTimers();
  });

  it('does not prompt when attachSession fails and finalizes the run as error', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    history.attachSession.mockImplementation(() => {
      throw new Error('attach exploded');
    });

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
    expect(result.error).toMatch(/attachSession failed/);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('does not treat session.active failure as idle success', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({
      activeImpl: async () => {
        throw new Error('active unavailable');
      },
    });

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      maxRunDurationMs: 2_500,
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(history.finishRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toBe('schedule run timed out');
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'error',
        error: 'schedule run timed out',
      }),
    );

    vi.useRealTimers();
  });

  it('watchdog timeout interrupts in-flight work and does not continue later stages', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let resolvePrompt;
    let promptStarted = false;
    let promptCompleted = false;
    const create = vi.fn(async () => ({ id: 'ses_timeout' }));
    const interrupt = vi.fn(async () => undefined);
    const command = vi.fn(async () => {
      throw new Error('command must not run after hanging prompt path');
    });
    const list = vi.fn(async () => ({ data: [] }));
    const prompt = vi.fn((_params, options) => {
      promptStarted = true;
      return new Promise((resolve, reject) => {
        resolvePrompt = () => {
          promptCompleted = true;
          resolve({ id: 'inbox_1', type: 'user' });
        };
        const signal = options?.signal;
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
    });
    makeOpenCodeV2Client.mockReturnValue({
      session: { create, prompt, command, interrupt },
      command: { list },
    });

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
      expect(interrupt).toHaveBeenCalledWith({
        sessionID: 'ses_timeout',
        continue: false,
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
      vi.useRealTimers();
    }
  });

  it('watchdog timeout during hanging command interrupts session and never session.prompt', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let commandReached = false;
    const create = vi.fn(async () => ({ id: 'ses_cmd' }));
    const interrupt = vi.fn(async () => undefined);
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
    const prompt = vi.fn(async () => {
      throw new Error('session.prompt must not run when command is selected');
    });
    makeOpenCodeV2Client.mockReturnValue({
      session: { create, prompt, command, interrupt },
      command: { list },
    });

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
    expect(interrupt).toHaveBeenCalledWith({
      sessionID: 'ses_cmd',
      continue: false,
    });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_cmd',
      command: 'review',
      arguments: 'src',
      model: { id: 'gpt-4.1', providerID: 'openai' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(list).toHaveBeenCalledWith({
      location: { directory: '/tmp/project-1' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(prompt).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('watchdog timeout during hanging small-model distill returns without waiting and blocks later goal stages', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    let resolveDistill;
    let distillStarted = false;
    const create = vi.fn(async () => ({ id: 'ses_distill' }));
    const interrupt = vi.fn(async () => undefined);
    const command = vi.fn(async () => {
      throw new Error('command must not run after hanging distill');
    });
    const list = vi.fn(async () => ({ data: [] }));
    const prompt = vi.fn(async () => {
      throw new Error('session.prompt must not run after hanging distill');
    });
    makeOpenCodeV2Client.mockReturnValue({
      session: { create, prompt, command, interrupt },
      command: { list },
    });

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
      expect(interrupt).toHaveBeenCalledWith({
        sessionID: 'ses_distill',
        continue: false,
      });
      expect(prompt).not.toHaveBeenCalled();
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

      // Release distill after finalize; abort gate must block goal write / prompt.
      resolveDistill?.();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(prompt).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      resolveDistill?.();
      vi.useRealTimers();
    }
  });

  it('goalEnabled writes the file-backed objective and does not PATCH session metadata', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ sessionID: 'ses_goal' });

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
    expect(writeObjective).toHaveBeenCalledWith('ses_goal', 'finish the migration');
    expect(client.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_goal',
      text: expect.stringContaining('Goal mode is active for this session'),
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.prompt.mock.calls[0][0].text).toContain('finish the migration');
    expect(client.interrupt).not.toHaveBeenCalled();
  });

  it('successful runs never call session.interrupt', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();

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
    expect(client.interrupt).not.toHaveBeenCalled();
  });
});
