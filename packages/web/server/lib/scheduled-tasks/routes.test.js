import { describe, expect, it, vi } from 'vitest';

import { SCHEDULE_CONFLICT_CODE } from '../projects/project-config.js';
import { SCHEDULED_TASK_BODY_EXPECTED, registerScheduledTaskRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const registerListRoute = ({ projects, listScheduledTasks, settings = { projects } }) => {
  const { app, getRoute } = createRouteRegistry();
  registerScheduledTaskRoutes(app, {
    readSettingsFromDiskMigrated: async () => settings,
    sanitizeProjects: vi.fn((value) => value),
    projectConfigRuntime: { listScheduledTasks },
  });
  return getRoute('GET', '/api/openchamber/scheduled-tasks');
};

const registerMutationRoutes = ({
  projectConfigRuntime,
  scheduledTasksRuntime,
  scheduleSyncRetry,
  loadCatalog,
  projects = [{ id: 'project-a', path: '/tmp/project-a' }],
}) => {
  const { app, getRoute } = createRouteRegistry();
  registerScheduledTaskRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects }),
    sanitizeProjects: (value) => value,
    projectConfigRuntime,
    scheduledTasksRuntime,
    scheduleSyncRetry,
    buildOpenCodeUrl: () => 'http://127.0.0.1:9',
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic dGVzdA==' }),
    loadCatalog: loadCatalog || (async (_client, options) => ({
      directory: options?.directory,
      models: [{ providerID: 'openai', modelID: 'gpt' }, { providerID: 'p', modelID: 'good' }],
    })),
  });
  return {
    put: getRoute('PUT', '/api/projects/:projectId/scheduled-tasks'),
    delete: getRoute('DELETE', '/api/projects/:projectId/scheduled-tasks/:taskId'),
  };
};

describe('global scheduled task list route', () => {
  it('returns an empty aggregate when settings are unavailable', async () => {
    const listScheduledTasks = vi.fn();
    const handler = registerListRoute({ settings: null, listScheduledTasks });
    const response = createResponse();

    await handler({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ tasks: [], failedProjectIds: [] });
    expect(listScheduledTasks).not.toHaveBeenCalled();
  });

  it('aggregates tasks from every configured project with project ownership', async () => {
    const listScheduledTasks = vi.fn(async (projectId) => (
      projectId === 'project-a' ? [{ id: 'daily' }] : [{ id: 'weekly' }]
    ));
    const handler = registerListRoute({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
      listScheduledTasks,
    });
    const response = createResponse();

    await handler({}, response);

    expect(listScheduledTasks).toHaveBeenCalledWith('project-a');
    expect(listScheduledTasks).toHaveBeenCalledWith('project-b');
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      tasks: [
        { projectId: 'project-a', task: { id: 'daily' } },
        { projectId: 'project-b', task: { id: 'weekly' } },
      ],
      failedProjectIds: [],
    });
  });

  it('retains separate ownership for matching task ids', async () => {
    const handler = registerListRoute({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
      listScheduledTasks: async () => [{ id: 'shared-task' }],
    });
    const response = createResponse();

    await handler({}, response);

    expect(response.body.tasks).toEqual([
      { projectId: 'project-a', task: { id: 'shared-task' } },
      { projectId: 'project-b', task: { id: 'shared-task' } },
    ]);
  });

  it('returns completed project tasks when one project fails', async () => {
    const handler = registerListRoute({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
      listScheduledTasks: async (projectId) => {
        if (projectId === 'project-a') {
          throw new Error('disk failure');
        }
        return [{ id: 'weekly' }];
      },
    });
    const response = createResponse();

    await handler({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      tasks: [{ projectId: 'project-b', task: { id: 'weekly' } }],
      failedProjectIds: ['project-a'],
    });
  });
});

describe('scheduled task run history route', () => {
  const registerHistoryRoute = (runHistoryStore) => {
    const { app, getRoute } = createRouteRegistry();
    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated: async () => ({ projects: [] }),
      sanitizeProjects: (projects) => projects,
      projectConfigRuntime: { listScheduledTasks: vi.fn(async () => []) },
      scheduledTasksRuntime: { syncProject: vi.fn(), runNow: vi.fn() },
      runHistoryStore,
    });
    return getRoute('GET', '/api/openchamber/scheduled-task-runs');
  };

  it('returns paginated runs from the history store', async () => {
    const listRuns = vi.fn(() => ({
      runs: [
        {
          id: 'run-1',
          projectId: 'p1',
          taskId: 't1',
          taskName: 'Nightly',
          trigger: 'scheduled',
          status: 'success',
          sessionId: 'ses_1',
          directory: '/repo',
          error: null,
          startedAt: 100,
          finishedAt: 120,
          durationMs: 20,
        },
      ],
      nextCursor: 'cursor-abc',
      complete: false,
    }));
    const handler = registerHistoryRoute({ listRuns });
    const response = createResponse();

    await handler({
      query: { before: 'cursor-prev', limit: '10', projectId: 'p1', taskId: 't1' },
    }, response);

    expect(listRuns).toHaveBeenCalledWith({
      before: 'cursor-prev',
      limit: 10,
      projectID: 'p1',
      taskID: 't1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      runs: [
        {
          id: 'run-1',
          projectId: 'p1',
          taskId: 't1',
          taskName: 'Nightly',
          trigger: 'scheduled',
          status: 'success',
          sessionId: 'ses_1',
          directory: '/repo',
          error: null,
          startedAt: 100,
          finishedAt: 120,
          durationMs: 20,
        },
      ],
      nextCursor: 'cursor-abc',
      complete: false,
    });
  });

  it('returns empty success when no runs exist', async () => {
    const handler = registerHistoryRoute({
      listRuns: vi.fn(() => ({ runs: [], nextCursor: null, complete: true })),
    });
    const response = createResponse();
    await handler({ query: {} }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ runs: [], nextCursor: null, complete: true });
  });

  it('returns 400 for invalid cursor or limit', async () => {
    const listRuns = vi.fn(({ before, limit }) => {
      if (before === 'bad') {
        throw new Error('Invalid cursor');
      }
      if (limit === 0) {
        throw new Error('Invalid limit');
      }
      return { runs: [], nextCursor: null, complete: true };
    });
    const handler = registerHistoryRoute({ listRuns });

    const badCursor = createResponse();
    await handler({ query: { before: 'bad' } }, badCursor);
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.body.error).toMatch(/cursor/i);

    const badLimit = createResponse();
    await handler({ query: { limit: '0' } }, badLimit);
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.body.error).toMatch(/limit/i);

    const fractionalLimit = createResponse();
    await handler({ query: { limit: '1.5' } }, fractionalLimit);
    expect(fractionalLimit.statusCode).toBe(400);
    expect(fractionalLimit.body.error).toMatch(/limit/i);
    expect(listRuns).not.toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it('returns 500 when the store fails and does not masquerade as empty success', async () => {
    const handler = registerHistoryRoute({
      listRuns: vi.fn(() => {
        throw new Error('disk failure');
      }),
    });
    const response = createResponse();
    await handler({ query: {} }, response);
    expect(response.statusCode).toBe(500);
    expect(response.body.error).toBeTruthy();
    expect(response.body.runs).toBeUndefined();
  });

  it('returns 500 when the store returns a malformed page instead of empty success', async () => {
    const cases = [
      { runs: null, nextCursor: null, complete: true },
      { runs: {}, nextCursor: null, complete: true },
      { runs: [], nextCursor: undefined, complete: true },
      { runs: [], nextCursor: 12, complete: true },
      { runs: [], nextCursor: null, complete: undefined },
      { runs: [], nextCursor: null, complete: 'yes' },
      { runs: [], nextCursor: null, complete: false },
      { runs: [], nextCursor: '', complete: false },
      { runs: [], nextCursor: 'unexpected', complete: true },
      null,
      undefined,
    ];

    for (const page of cases) {
      const handler = registerHistoryRoute({
        listRuns: vi.fn(() => page),
      });
      const response = createResponse();
      await handler({ query: {} }, response);
      expect(response.statusCode).toBe(500);
      expect(response.body.error).toBeTruthy();
      expect(response.body.runs).toBeUndefined();
      expect(response.body.complete).toBeUndefined();
    }
  });
});

describe('scheduled task mutation routes', () => {
  it('returns the committed snapshot after scheduler sync succeeds', async () => {
    const savedTask = { id: 'created-task', name: 'Created' };
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async () => ({ task: savedTask, tasks: [savedTask], created: true })),
      deleteScheduledTask: vi.fn(),
      listScheduledTasks: vi.fn().mockRejectedValue(new Error('secondary read failed')),
    };
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn(async () => {}) },
      scheduleSyncRetry: vi.fn(),
    });

    const response = createResponse();
    await routes.put({ params: { projectId: 'project-a' }, body: { task: { name: 'Created' } } }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ tasks: [savedTask], task: savedTask, created: true, schedulerSynced: true });
    expect(projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
  });

  it('returns committed create, update, and delete responses when scheduler sync fails', async () => {
    const createdTask = { id: 'created-task', name: 'Created' };
    const updatedTask = { id: 'existing-task', name: 'Updated' };
    const retry = vi.fn();
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async (_projectID, task) => {
        const savedTask = task.id === 'existing-task' ? updatedTask : createdTask;
        return { task: savedTask, tasks: [savedTask], created: task.id !== 'existing-task' };
      }),
      deleteScheduledTask: vi.fn(async () => ({ deleted: true, tasks: [] })),
      listScheduledTasks: vi.fn(async () => []),
    };
    const scheduledTasksRuntime = {
      syncProject: vi.fn().mockRejectedValue(new Error('scheduler unavailable')),
    };
    const routes = registerMutationRoutes({ projectConfigRuntime, scheduledTasksRuntime, scheduleSyncRetry: retry });

    const created = createResponse();
    await routes.put({ params: { projectId: 'project-a' }, body: { task: { name: 'Created' } } }, created);
    expect(created.statusCode).toBe(200);
    expect(created.body).toEqual({ tasks: [createdTask], task: createdTask, created: true, schedulerSynced: false });
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledTimes(1);

    const updated = createResponse();
    await routes.put({ params: { projectId: 'project-a' }, body: { task: { id: 'existing-task', name: 'Updated' } } }, updated);
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toEqual({ tasks: [updatedTask], task: updatedTask, created: false, schedulerSynced: false });

    const deleted = createResponse();
    await routes.delete({ params: { projectId: 'project-a', taskId: 'existing-task' } }, deleted);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ tasks: [], schedulerSynced: false });
    expect(retry).toHaveBeenCalledTimes(3);
    expect(projectConfigRuntime.listScheduledTasks).toHaveBeenCalledTimes(1);

    retry.mock.calls[0][0]();
    await Promise.resolve();
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalledTimes(4);
  });

  it('allows create/edit with goalEnabled when Host goal state is supported', async () => {
    const savedTask = {
      id: 'goal-task',
      name: 'Goal task',
      execution: { prompt: 'do the work', goalEnabled: true },
    };
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async () => ({ task: savedTask, tasks: [savedTask], created: true })),
      deleteScheduledTask: vi.fn(),
      listScheduledTasks: vi.fn(async () => []),
    };
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn(async () => {}) },
      scheduleSyncRetry: vi.fn(),
    });

    const created = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          name: 'Goal task',
          execution: {
            prompt: 'do the work',
            providerID: 'openai',
            modelID: 'gpt',
            goalEnabled: true,
          },
        },
      },
    }, created);

    expect(created.statusCode).toBe(200);
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledTimes(1);
    expect(projectConfigRuntime.upsertScheduledTask.mock.calls[0][1]).toMatchObject({
      execution: expect.objectContaining({ goalEnabled: true }),
    });

    const updatedTask = { ...savedTask, id: 'existing', name: 'Existing' };
    projectConfigRuntime.upsertScheduledTask.mockResolvedValueOnce({
      task: updatedTask,
      tasks: [updatedTask],
      created: false,
    });
    const updated = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          id: 'existing',
          name: 'Existing',
          execution: {
            prompt: 'do the work',
            providerID: 'openai',
            modelID: 'gpt',
            goalEnabled: true,
          },
        },
      },
    }, updated);

    expect(updated.statusCode).toBe(200);
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledTimes(2);
  });

  it('allows ordinary non-goal task create when goal is unsupported', async () => {
    const savedTask = { id: 'plain', name: 'Plain' };
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async () => ({ task: savedTask, tasks: [savedTask], created: true })),
      deleteScheduledTask: vi.fn(),
      listScheduledTasks: vi.fn(async () => []),
    };
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn(async () => {}) },
      scheduleSyncRetry: vi.fn(),
    });

    const response = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          name: 'Plain',
          execution: { prompt: 'hello', providerID: 'openai', modelID: 'gpt' },
        },
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing task envelope with the expected shape and does not write', async () => {
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(),
      listScheduledTasks: vi.fn(),
    };
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn() },
      scheduleSyncRetry: vi.fn(),
    });
    for (const body of [{ name: 'bare' }, { tasks: [] }, { task: [] }]) {
      const response = createResponse();
      await routes.put({ params: { projectId: 'project-a' }, body }, response);
      expect(response.statusCode).toBe(400);
      expect(response.body.error).toBe('task payload is required');
      expect(response.body.expected).toEqual(SCHEDULED_TASK_BODY_EXPECTED);
    }
    expect(projectConfigRuntime.upsertScheduledTask).not.toHaveBeenCalled();
    expect(projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
  });

  it('rejects an unconnected model and a catalog failure before writing', async () => {
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(),
      listScheduledTasks: vi.fn(async () => []),
    };
    const syncProject = vi.fn();
    const missing = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject },
      scheduleSyncRetry: vi.fn(),
      loadCatalog: async () => ({ models: [{ providerID: 'p', modelID: 'good' }] }),
    });
    const missingResponse = createResponse();
    await missing.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          name: 'missing',
          enabled: false,
          execution: { prompt: 'x', providerID: 'p', modelID: 'nonexistent' },
        },
      },
    }, missingResponse);
    expect(missingResponse.statusCode).toBe(400);
    expect(missingResponse.body.error).toContain('p/nonexistent');

    const down = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject },
      scheduleSyncRetry: vi.fn(),
      loadCatalog: async () => { throw new Error('upstream 503'); },
    });
    const downResponse = createResponse();
    await down.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          name: 'down',
          enabled: false,
          execution: { prompt: 'x', providerID: 'p', modelID: 'good' },
        },
      },
    }, downResponse);
    expect(downResponse.statusCode).toBe(503);
    expect(downResponse.body.error).toBe('Connected catalog is unavailable');
    expect(projectConfigRuntime.upsertScheduledTask).not.toHaveBeenCalled();
    expect(syncProject).not.toHaveBeenCalled();
  });

  it('allows rename and disable when the catalog is down, and rejects enable', async () => {
    const existing = {
      id: 'task-1',
      name: 'Old',
      enabled: false,
      execution: { providerID: 'p', modelID: 'good', prompt: 'x' },
    };
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async () => ({ task: existing, tasks: [existing], created: false })),
      listScheduledTasks: vi.fn(async () => [existing]),
    };
    const loadCatalog = vi.fn(async () => { throw new Error('upstream 503'); });
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn(async () => {}) },
      scheduleSyncRetry: vi.fn(),
      loadCatalog,
    });
    const task = {
      id: 'task-1',
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      execution: { prompt: 'x', providerID: ' p ', modelID: 'good' },
    };

    const renamed = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: { task: { ...task, name: 'Renamed', enabled: false } },
    }, renamed);
    expect(renamed.statusCode).toBe(200);
    expect(loadCatalog).not.toHaveBeenCalled();

    const disabled = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: { task: { ...task, name: 'Old', enabled: false } },
    }, disabled);
    expect(disabled.statusCode).toBe(200);

    const enabled = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: { task: { ...task, name: 'Old', enabled: true } },
    }, enabled);
    expect(enabled.statusCode).toBe(503);
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledTimes(2);
    expect(projectConfigRuntime.upsertScheduledTask.mock.calls[0][2]).toEqual({
      expected: { exists: true, providerID: 'p', modelID: 'good', enabled: false },
    });
  });

  it('disables an enabled task without a catalog request when the catalog is down', async () => {
    const existing = {
      id: 'task-armed',
      name: 'Armed',
      enabled: true,
      execution: { providerID: 'p', modelID: 'good', prompt: 'x' },
    };
    const projectConfigRuntime = {
      upsertScheduledTask: vi.fn(async (_projectID, input) => ({
        task: { ...existing, name: input.name, enabled: input.enabled },
        tasks: [{ ...existing, enabled: input.enabled }],
        created: false,
      })),
      listScheduledTasks: vi.fn(async () => [existing]),
    };
    const loadCatalog = vi.fn(async () => { throw new Error('upstream 503'); });
    const routes = registerMutationRoutes({
      projectConfigRuntime,
      scheduledTasksRuntime: { syncProject: vi.fn(async () => {}) },
      scheduleSyncRetry: vi.fn(),
      loadCatalog,
    });

    const response = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          id: 'task-armed',
          name: 'Armed',
          enabled: false,
          schedule: { kind: 'once', date: '2099-01-01', time: '00:00', timezone: 'UTC' },
          execution: { prompt: 'x', providerID: 'p', modelID: 'good' },
        },
      },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.task.enabled).toBe(false);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledWith('project-a', expect.objectContaining({
      enabled: false,
    }), {
      expected: { exists: true, providerID: 'p', modelID: 'good', enabled: true },
    });
  });

  it('maps a lock conflict to 409 and does not sync', async () => {
    const conflict = new Error('scheduled task changed before save');
    conflict.statusCode = 409;
    conflict.code = SCHEDULE_CONFLICT_CODE;
    const syncProject = vi.fn();
    const routes = registerMutationRoutes({
      projectConfigRuntime: {
        upsertScheduledTask: vi.fn(async () => { throw conflict; }),
        listScheduledTasks: vi.fn(async () => []),
      },
      scheduledTasksRuntime: { syncProject },
      scheduleSyncRetry: vi.fn(),
    });
    const response = createResponse();
    await routes.put({
      params: { projectId: 'project-a' },
      body: {
        task: {
          name: 'Create',
          execution: { prompt: 'x', providerID: 'p', modelID: 'good' },
        },
      },
    }, response);
    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe(SCHEDULE_CONFLICT_CODE);
    expect(syncProject).not.toHaveBeenCalled();
  });
});
