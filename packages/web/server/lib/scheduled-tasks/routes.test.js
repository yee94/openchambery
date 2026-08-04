import { describe, expect, it, vi } from 'vitest';

import { registerScheduledTaskRoutes } from './routes.js';

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

const registerMutationRoutes = ({ projectConfigRuntime, scheduledTasksRuntime, scheduleSyncRetry }) => {
  const { app, getRoute } = createRouteRegistry();
  registerScheduledTaskRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-a' }] }),
    sanitizeProjects: (projects) => projects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    scheduleSyncRetry,
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
      listScheduledTasks: vi.fn(),
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
    expect(projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();

    retry.mock.calls[0][0]();
    await Promise.resolve();
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalledTimes(4);
  });
});
