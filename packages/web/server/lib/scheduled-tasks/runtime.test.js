import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { createScheduledTaskRunHistoryStore } = await import('./run-history-store.js');
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
  persistSessionMetadata: vi.fn(async () => ({})),
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
  it('notifies the notification runtime when a run settles, without blocking its result', async () => {
    const updateScheduledTaskState = vi.fn(async () => ({ task: scheduledTask }));
    const notifyTaskRun = vi.fn(async () => {
      throw new Error('notification fanout failed');
    });
    const runtime = createRuntime(updateScheduledTaskState, { notifyTaskRun });
    await runtime.syncProject('project-1');

    const result = await runtime.runNow('project-1', 'task-1');

    // waitForOpenCodeReady throws in this fixture → the run settles as error.
    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(notifyTaskRun).toHaveBeenCalledTimes(1);
    expect(notifyTaskRun.mock.calls[0][0]).toMatchObject({
      projectID: 'project-1',
      taskID: 'task-1',
      taskName: 'Task',
      status: 'error',
      reason: 'manual',
    });
    // A failing notification callback must not mark the run failed.
    expect(runtime.getStatus().hasRunningScheduledTasks).toBe(false);
  });

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
    expect(source).not.toContain('session.status({');
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
          time: { created: Date.now(), completed: Date.now() },
          finish: 'stop',
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

  const completedAssistant = (id = 'msg_ok') => ({
    id,
    type: 'assistant',
    time: { created: 1_000, completed: 1_100 },
    finish: 'stop',
  });

  const erroredAssistant = (id = 'msg_err') => ({
    id,
    type: 'assistant',
    time: { created: 2_000, completed: 2_100 },
    error: { name: 'ProviderError', message: 'upstream failed' },
  });

  it('creates session with Scheduled title and location, attaches history, then prompts via session.prompt', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const persistSessionMetadata = vi.fn(async () => ({}));
    const onSystemSessionPersisted = vi.fn();

    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      persistSessionMetadata,
      onSystemSessionPersisted,
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
      metadata: {
        openchamber: {
          scheduledTask: expect.objectContaining({
            projectID: 'project-1',
            taskID: 'task-1',
            runID: started.id,
            name: 'Task',
          }),
        },
      },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.create.mock.calls[0][0].directory).toBeUndefined();
    expect(persistSessionMetadata).toHaveBeenCalledWith('ses_1', {
      openchamber: {
        scheduledTask: expect.objectContaining({
          projectID: 'project-1',
          taskID: 'task-1',
          runID: started.id,
          name: 'Task',
        }),
      },
    });
    expect(onSystemSessionPersisted).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/tmp/project-1',
      metadata: expect.objectContaining({
        openchamber: expect.objectContaining({
          scheduledTask: expect.objectContaining({ taskID: 'task-1' }),
        }),
      }),
    });
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

  it('refuses before session create when Host metadata persist is not configured', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      persistSessionMetadata: null,
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/session metadata persist is not configured/);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it('fails the run before prompt when Host metadata persist throws', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient();
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      persistSessionMetadata: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
      waitForOpenCodeReady: vi.fn(async () => {}),
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/store unavailable/);
    expect(client.create).toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
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
      persistSessionMetadata: vi.fn(async () => ({})),
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

  it('goalEnabled without persist refuses before OpenCode ready / distill / session create (no side effects)', async () => {
    const history = createHistoryStore();
    const create = vi.fn(async () => ({ id: 'ses_distill' }));
    const interrupt = vi.fn(async () => undefined);
    const prompt = vi.fn(async () => {
      throw new Error('session.prompt must not run without goal persist');
    });
    makeOpenCodeV2Client.mockReturnValue({
      session: { create, prompt, command: vi.fn(), interrupt },
      command: { list: vi.fn(async () => ({ data: [] })) },
    });

    const generateSmallModelText = vi.fn(async () => ({ text: 'should not distill' }));
    const getSmallModelService = vi.fn(async () => ({ generateSmallModelText }));
    const waitForOpenCodeReady = vi.fn(async () => {});

    // Oversized prompt would force distill if goal were admitted — it must not.
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
      waitForOpenCodeReady,
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
      // intentionally no persistSessionGoal
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/session goal persist is not configured/);
    expect(waitForOpenCodeReady).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(generateSmallModelText).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(writeObjective).not.toHaveBeenCalled();
    expect(history.attachSession).not.toHaveBeenCalled();
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'error',
        error: expect.stringMatching(/session goal persist is not configured/),
      }),
    );
  });

  it('goalEnabled without persist refuses before session create / objective write', async () => {
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
      // intentionally no persistSessionGoal
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    // Missing persist is an explicit run failure before any side effects.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/session goal persist is not configured/);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(writeObjective).not.toHaveBeenCalled();
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'error',
        error: expect.stringMatching(/session goal persist is not configured/),
      }),
    );
    // Task config is preserved (goalEnabled stays on the task); only this run fails.
    const finalPatch = updateScheduledTaskState.mock.calls.at(-1)[2];
    expect(finalPatch.lastStatus).toBe('error');
    expect(Object.hasOwn(finalPatch, 'lastSessionId')).toBe(false);
  });

  it('goalEnabled with persist writes objective + active goal then prompts', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ sessionID: 'ses_goal_ok' });
    const persistSessionGoal = vi.fn(async (_sessionId, _directory, goal) => ({
      openchamber: { goal },
    }));
    const onGoalPersisted = vi.fn();

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
      persistSessionMetadata: vi.fn(async () => ({})),
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
      persistSessionGoal,
      onGoalPersisted,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(true);
    expect(client.create).toHaveBeenCalled();
    expect(writeObjective).toHaveBeenCalledWith('ses_goal_ok', 'finish the migration');
    expect(persistSessionGoal).toHaveBeenCalledTimes(1);
    expect(persistSessionGoal.mock.calls[0][0]).toBe('ses_goal_ok');
    expect(persistSessionGoal.mock.calls[0][1]).toBe('/tmp/project-1');
    expect(persistSessionGoal.mock.calls[0][2]).toMatchObject({
      status: 'active',
      objectiveFile: true,
      objective: '',
      tokenBudget: 12_000,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: '',
    });
    expect(typeof persistSessionGoal.mock.calls[0][2].id).toBe('string');
    expect(persistSessionGoal.mock.calls[0][2].id.length).toBeGreaterThan(0);
    expect(onGoalPersisted).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_goal_ok',
      directory: '/tmp/project-1',
      metadata: expect.objectContaining({
        openchamber: expect.objectContaining({
          goal: expect.objectContaining({ status: 'active' }),
        }),
      }),
    }));
    expect(client.prompt).toHaveBeenCalled();
  });

  it('goalEnabled persist failure aborts before prompt', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ sessionID: 'ses_goal_fail' });
    const persistSessionGoal = vi.fn(async () => {
      throw new Error('store unavailable');
    });

    const goalTask = {
      ...scheduledTask,
      execution: {
        ...scheduledTask.execution,
        prompt: 'finish the migration',
        goalEnabled: true,
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
      persistSessionMetadata: vi.fn(async () => ({})),
      logger: { info: vi.fn(), warn: vi.fn() },
      runHistoryStore: history,
      persistSessionGoal,
    });
    await runtime.syncProject('project-1');
    const result = await runtime.runNow('project-1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/store unavailable/);
    expect(writeObjective).toHaveBeenCalled();
    expect(persistSessionGoal).toHaveBeenCalled();
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it('ordinary non-goal runs still create a session and settle on the assistant tail', async () => {
    const history = createHistoryStore();
    const client = createSuccessfulClient({ sessionID: 'ses_plain' });
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
    expect(client.create).toHaveBeenCalled();
    expect(client.prompt).toHaveBeenCalled();
    expect(writeObjective).not.toHaveBeenCalled();
  });

  it('settles from the latest-side page: >50 older completed + newest error → error', async () => {
    const history = createHistoryStore();
    // order=desc page: newest first. Older completed assistants must not win.
    const latestPage = [
      erroredAssistant('msg_latest'),
      ...Array.from({ length: 49 }, (_, index) => completedAssistant(`msg_old_${index}`)),
    ];
    createSuccessfulClient({
      messageListImpl: async () => ({ data: latestPage }),
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
    expect(result.error).toBe('ProviderError');
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error', error: 'ProviderError' }),
    );
  });

  it('settles from the latest-side page: >50 older errors + newest completed → success', async () => {
    const history = createHistoryStore();
    const latestPage = [
      completedAssistant('msg_latest'),
      ...Array.from({ length: 49 }, (_, index) => erroredAssistant(`msg_old_${index}`)),
    ];
    createSuccessfulClient({
      messageListImpl: async () => ({ data: latestPage }),
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

    expect(result.ok).toBe(true);
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('does not succeed when the latest message is model-switched', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({
      messageListImpl: async () => ({
        data: [{
          id: 'msg_switch',
          type: 'model-switched',
          time: { created: Date.now() },
          model: { providerID: 'openai', id: 'gpt-4.1' },
        }],
      }),
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
    expect(result.error).toBe('schedule run timed out');
    vi.useRealTimers();
  });

  it('does not succeed when the assistant finish is tool-calls', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({
      messageListImpl: async () => ({
        data: [{
          id: 'msg_tools',
          type: 'assistant',
          time: { created: 1, completed: 2 },
          finish: 'tool-calls',
        }],
      }),
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
    expect(result.error).toBe('schedule run timed out');
    vi.useRealTimers();
  });

  it('does not succeed after two incomplete assistant idle probes', async () => {
    vi.useFakeTimers();
    const history = createHistoryStore();
    createSuccessfulClient({
      messageListImpl: async () => ({
        data: [{
          id: 'msg_incomplete',
          type: 'assistant',
          time: { created: 1 },
          // no time.completed, no finish
        }],
      }),
    });
    const updateScheduledTaskState = vi.fn(async (_projectID, _taskID, state) => ({
      task: { ...scheduledTask, state: { ...scheduledTask.state, ...state } },
    }));
    const runtime = createRuntime(updateScheduledTaskState, {
      runHistoryStore: history,
      waitForOpenCodeReady: vi.fn(async () => {}),
      maxRunDurationMs: 3_500,
    });
    await runtime.syncProject('project-1');

    const runPromise = runtime.runNow('project-1', 'task-1');
    // Two idle polls with incomplete assistant must not finalize as success.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(history.finishRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('schedule run timed out');
    expect(history.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'error', error: 'schedule run timed out' }),
    );
    vi.useRealTimers();
  });

  it('lists settlement messages with order=desc (latest-side page)', async () => {
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
    await runtime.runNow('project-1', 'task-1');

    expect(client.messageList).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'ses_1',
        limit: 50,
        order: 'desc',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

    client.messageList.mockImplementation(async () => ({
      data: [completedAssistant('msg_ok')],
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

    client.messageList.mockImplementation(async () => ({
      data: [completedAssistant('msg_ok')],
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

    client.messageList.mockImplementation(async () => ({
      data: [completedAssistant('msg_ok')],
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

describe('scheduled-tasks cross-process slot occupancy', () => {
  it('lets only one runtime occupy a scheduled slot when two schedulers share a history store', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 9, 29, 54));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-slot-'));
    const store = createScheduledTaskRunHistoryStore({
      dbPath: path.join(dir, 'scheduled-task-runs.sqlite'),
    });
    const first = { stop() {} };
    const second = { stop() {} };
    try {
      const dueTask = {
        ...scheduledTask,
        schedule: {
          kind: 'daily',
          times: ['09:30'],
          timezone: 'UTC',
        },
      };
      const stateWrites = [];
      const notifyTaskRun = vi.fn(async () => {});
      const createSharedRuntime = () => createScheduledTasksRuntime({
        projectConfigRuntime: {
          listScheduledTasks: vi.fn(async () => [dueTask]),
          updateScheduledTaskState: vi.fn(async (_projectID, _taskID, state) => {
            stateWrites.push(state);
            return { task: { ...dueTask, state: { ...dueTask.state, ...state } } };
          }),
          upsertScheduledTask: vi.fn(async (_projectID, task) => ({ task })),
        },
        listProjects: vi.fn(async () => [{ id: 'project-1', path: '/tmp/project-1' }]),
        buildOpenCodeUrl: vi.fn(() => 'http://127.0.0.1:4096'),
        getOpenCodeAuthHeaders: vi.fn(() => ({})),
        waitForOpenCodeReady: vi.fn(async () => {
          throw new Error('OpenCode unavailable');
        }),
        persistSessionMetadata: vi.fn(async () => ({})),
        logger: { info: vi.fn(), warn: vi.fn() },
        runHistoryStore: store,
        notifyTaskRun,
      });

      Object.assign(first, createSharedRuntime());
      Object.assign(second, createSharedRuntime());
      await first.start();
      await second.start();
      await vi.advanceTimersByTimeAsync(6_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.listRuns({}).runs).toHaveLength(1);
      expect(notifyTaskRun).toHaveBeenCalledTimes(1);
      expect(stateWrites.filter((state) => state.lastStatus === 'running')).toHaveLength(1);
      expect(stateWrites.filter((state) => state.lastStatus === 'error')).toHaveLength(1);
    } finally {
      first.stop();
      second.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
