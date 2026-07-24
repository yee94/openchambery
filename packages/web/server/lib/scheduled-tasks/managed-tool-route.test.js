import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { MANAGED_SCHEDULED_TASK_TOOL_PATH, MANAGED_SCHEDULED_TASK_TOKEN_HEADER } from './managed-tool-contract.js';
import { registerScheduledTaskToolRoute } from './managed-tool-route.js';

const session = { id: 'ses_1', directory: '/repo/packages/app' };
const messages = [
  { info: { id: 'usr_1', role: 'user', model: { providerID: 'anthropic', modelID: 'claude-test', variant: 'fast' }, agent: 'build' } },
  { info: { id: 'ast_1', role: 'assistant', parentID: 'usr_1' } },
];

const task = {
  id: 'task_1', name: 'Existing', enabled: true,
  schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
  execution: { prompt: 'existing prompt', providerID: 'openai', modelID: 'existing-model', agent: 'existing-agent' },
  state: { createdAt: 1, updatedAt: 2, lastStatus: 'idle' },
};

const body = (operation, input = {}, context = {}) => ({
  operation,
  context: { sessionID: 'ses_1', messageID: 'ast_1', directory: '/repo/packages/app', ...context },
  input,
});

const createApp = (overrides = {}) => {
  const app = express();
  const tasks = overrides.tasks || [task];
  const projectConfigRuntime = {
    listScheduledTasks: vi.fn(async () => tasks),
    upsertScheduledTask: vi.fn(async (_projectID, next) => {
      const saved = { ...next, id: next.id || 'task_created', state: next.state || { createdAt: 3, updatedAt: 3, lastStatus: 'idle' } };
      const index = tasks.findIndex((item) => item.id === saved.id);
      if (index >= 0) tasks[index] = saved;
      else tasks.push(saved);
      return { task: saved, created: index < 0 };
    }),
    deleteScheduledTask: vi.fn(async (_projectID, taskID) => {
      const index = tasks.findIndex((item) => item.id === taskID);
      if (index < 0) return { deleted: false, tasks };
      tasks.splice(index, 1);
      return { deleted: true, tasks };
    }),
    patchScheduledTask: vi.fn(async (_projectID, taskID, patch) => {
      const existing = tasks.find((item) => item.id === taskID);
      if (!existing) return { task: null, tasks };
      const saved = { ...existing, ...patch, schedule: { ...existing.schedule, ...patch.schedule }, execution: { ...existing.execution, ...patch.execution } };
      tasks[tasks.indexOf(existing)] = saved;
      return { task: saved, tasks };
    }),
    ...overrides.projectConfigRuntime,
  };
  const scheduledTasksRuntime = {
    syncProject: vi.fn(async () => {}),
    runNow: vi.fn(async () => ({ ok: true, task, sessionID: 'ses_run' })),
    ...overrides.scheduledTasksRuntime,
  };
  const fetchMock = vi.fn(async (url) => {
    const value = String(url);
    if (value.includes('/session/ses_1/message')) return Response.json(messages);
    return Response.json(session);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = overrides.fetch || fetchMock;
  const validateDirectoryPath = overrides.validateDirectoryPath || vi.fn(async (directory) => ({ ok: true, directory }));
  const logger = overrides.logger || { error: vi.fn(), warn: vi.fn() };
  const scheduleSyncRetry = overrides.scheduleSyncRetry || vi.fn();
  registerScheduledTaskToolRoute(app, {
    express,
    path: awaitablePath,
    validateDirectoryPath,
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer secret' }),
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'root', path: '/repo' }, { id: 'app', path: '/repo/packages/app' }] }),
    sanitizeProjects: (projects) => projects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    logger,
    scheduleSyncRetry,
    ...overrides.dependencies,
  });
  return { app, projectConfigRuntime, scheduledTasksRuntime, fetchMock, validateDirectoryPath, logger, scheduleSyncRetry, restore: () => { globalThis.fetch = originalFetch; } };
};

// The route receives Node's path module through dependency injection in production.
const awaitablePath = await import('node:path');

describe('managed scheduled task tool route', () => {
  it('uses the shared managed tool contract', () => {
    expect(MANAGED_SCHEDULED_TASK_TOOL_PATH).toBe('/api/internal/managed-opencode/scheduled-task');
    expect(MANAGED_SCHEDULED_TASK_TOKEN_HEADER).toBe('x-openchamber-scheduled-task-token');
  });

  it('uses authoritative message defaults and the deepest containing project for create', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('create', {
        name: 'Daily review', schedule: { kind: 'daily', time: '10:00', timezone: 'UTC' }, execution: { prompt: 'review changes' },
      }));
      expect(response.status).toBe(201);
      expect(response.body.projectId).toBe('app');
      expect(fixture.projectConfigRuntime.upsertScheduledTask).toHaveBeenCalledWith('app', expect.objectContaining({
        execution: expect.objectContaining({ providerID: 'anthropic', modelID: 'claude-test', agent: 'build', variant: 'fast' }),
      }));
      expect(fixture.scheduledTasksRuntime.syncProject).toHaveBeenCalledWith('app');
    } finally { fixture.restore(); }
  });

  it('passes only the requested partial fields to patchScheduledTask', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('update', {
        taskId: 'task_1', name: 'Renamed', execution: { modelID: 'explicit-model' }, schedule: { timezone: 'Europe/Paris' },
      }));
      expect(response.status).toBe(200);
      expect(fixture.projectConfigRuntime.patchScheduledTask).toHaveBeenCalledWith('app', 'task_1', {
        name: 'Renamed', execution: { modelID: 'explicit-model' }, schedule: { timezone: 'Europe/Paris' },
      });
      expect(fixture.projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
    } finally { fixture.restore(); }
  });

  it('accepts an explicit create model', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('create', {
        name: 'Explicit model', schedule: { kind: 'daily', time: '10:00', timezone: 'UTC' },
        execution: { prompt: 'review', providerID: 'openai', modelID: 'gpt-explicit' },
      }));
      expect(response.status).toBe(201);
      expect(fixture.projectConfigRuntime.upsertScheduledTask.mock.calls[0][1].execution).toMatchObject({
        providerID: 'openai', modelID: 'gpt-explicit',
      });
    } finally { fixture.restore(); }
  });

  it('rejects a forged directory before project mutation', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', {}, { directory: '/other' }));
      expect(response.status).toBe(400);
      expect(fixture.projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
    } finally { fixture.restore(); }
  });

  it('uses validated canonical directories and accepts an ancestor worktree', async () => {
    const validateDirectoryPath = vi.fn(async (directory) => ({
      ok: true,
      directory: directory === '/link/app' ? '/repo/packages/app' : directory,
    }));
    const fixture = createApp({ validateDirectoryPath });
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', {}, {
        directory: '/link/app', worktree: '/repo',
      }));
      expect(response.status).toBe(200);
      expect(validateDirectoryPath).toHaveBeenCalledWith('/link/app');
      expect(validateDirectoryPath).toHaveBeenCalledWith('/repo');
      expect(validateDirectoryPath).toHaveBeenCalledWith('/repo/packages/app');
    } finally { fixture.restore(); }
  });

  it('rejects missing or forged message IDs', async () => {
    const fixture = createApp();
    try {
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', {}, { messageID: 'missing' }))).status).toBe(400);
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', {}, { messageID: 'usr_1' }))).status).toBe(400);
    } finally { fixture.restore(); }
  });

  it('rejects a context agent that differs from the authoritative user agent', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', {}, { agent: 'forged-agent' }));
      expect(response.status).toBe(400);
    } finally { fixture.restore(); }
  });

  it('rejects non-boolean enabled input', async () => {
    const fixture = createApp();
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('create', {
        name: 'Bad enabled', enabled: 'true', schedule: { kind: 'daily', time: '10:00', timezone: 'UTC' }, execution: { prompt: 'run' },
      }));
      expect(response.status).toBe(400);
      expect(fixture.projectConfigRuntime.upsertScheduledTask).not.toHaveBeenCalled();
    } finally { fixture.restore(); }
  });

  it('ignores configured projects whose canonical validation fails', async () => {
    const fixture = createApp({
      validateDirectoryPath: vi.fn(async (directory) => directory === '/repo/missing'
        ? { ok: false, error: 'missing' }
        : { ok: true, directory }),
      dependencies: {
        readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'root', path: '/repo' }, { id: 'missing', path: '/repo/missing' }] }),
      },
    });
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list'));
      expect(response.status).toBe(200);
      expect(response.body.projectId).toBe('root');
    } finally { fixture.restore(); }
  });

  it('fails closed when an invalid configured project lexically contains the session', async () => {
    const fixture = createApp({
      validateDirectoryPath: vi.fn(async (directory) => directory === '/repo/packages'
        ? { ok: false, error: 'missing' }
        : { ok: true, directory }),
      dependencies: {
        readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'root', path: '/repo' }, { id: 'broken', path: '/repo/packages' }] }),
      },
    });
    try {
      const response = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list'));
      expect(response.status).toBe(409);
    } finally { fixture.restore(); }
  });

  it('returns successful mutations when scheduler sync fails and schedules a retry', async () => {
    const retry = vi.fn();
    const fixture = createApp({
      scheduledTasksRuntime: { syncProject: vi.fn().mockRejectedValue(new Error('scheduler down')) },
      scheduleSyncRetry: retry,
    });
    try {
      const created = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('create', {
        name: 'Retry task', schedule: { kind: 'daily', time: '10:00', timezone: 'UTC' }, execution: { prompt: 'run' },
      }));
      expect(created.status).toBe(201);
      expect(created.body.schedulerSynced).toBe(false);
      expect(retry).toHaveBeenCalledTimes(1);
      retry.mock.calls[0][0]();
      await Promise.resolve();
      expect(fixture.scheduledTasksRuntime.syncProject).toHaveBeenCalledTimes(2);

      const deleted = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('delete', { taskId: 'task_1' }));
      expect(deleted.status).toBe(200);
      expect(deleted.body.schedulerSynced).toBe(false);
    } finally { fixture.restore(); }
  });

  it('handles list, delete, and run result states', async () => {
    const fixture = createApp();
    try {
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list'))).status).toBe(200);
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('delete', { taskId: 'missing' }))).status).toBe(404);
      fixture.scheduledTasksRuntime.runNow.mockResolvedValueOnce({ ok: false, running: true });
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('run', { taskId: 'task_1' }))).status).toBe(409);
      fixture.scheduledTasksRuntime.runNow.mockResolvedValueOnce({ ok: false, skipped: true });
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('run', { taskId: 'task_1' }))).status).toBe(404);
      fixture.scheduledTasksRuntime.runNow.mockResolvedValueOnce({ ok: false, task });
      expect((await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('run', { taskId: 'task_1' }))).status).toBe(500);
    } finally { fixture.restore(); }
  });

  it('returns safe upstream failures and enforces the 64kb JSON limit', async () => {
    const fixture = createApp({ fetch: vi.fn(async () => new Response('down', { status: 500 })) });
    try {
      const upstream = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list'));
      expect(upstream.status).toBe(502);
      expect(upstream.body.error).toBe('Failed to manage schedule');
      const oversized = await request(fixture.app).post(MANAGED_SCHEDULED_TASK_TOOL_PATH).send(body('list', { padding: 'x'.repeat(70_000) }));
      expect(oversized.status).toBe(413);
    } finally { fixture.restore(); }
  });
});
