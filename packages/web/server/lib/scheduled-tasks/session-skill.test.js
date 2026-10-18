import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { OpenCode } from '@opencode/client';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { registerScheduledTaskRoutes } from './routes.js';
import { registerScheduledTaskSessionSkill } from './session-skill.js';
import { authorizeScheduledTaskSkillRequest, SCHEDULED_TASK_SKILL_PATH } from './session-skill-contract.js';

describe('built-in session skill with authenticated Host', () => {
  let root, server, origin, ui, sessions, entries, store, password, auth, registrationFile, sdk, sync, failInstructions, failCleanup;
  const upstreamOrigin = 'http://127.0.0.1:4096';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skill-'));
    vi.stubEnv('OPENCHAMBER_DATA_DIR', root);
    await fs.mkdir(path.join(root, 'project-a'));
    await fs.mkdir(path.join(root, 'project-b'));
    const projects = ['a', 'b'].map((id) => ({ id, path: path.join(root, `project-${id}`) }));
    password = randomUUID();
    auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    registrationFile = path.join(root, 'service.json');
    await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password }), { mode: 0o600 });
    sessions = new Map(); entries = new Map(); failInstructions = false; failCleanup = false;
    sdk = {
      session: {
        create: vi.fn(async (input) => {
          const session = { ...input, id: input.id ?? `ses_${randomUUID()}`, model: { providerID: 'test', id: 'model', variant: 'high' }, agent: 'build' };
          sessions.set(session.id, session);
          return session;
        }),
        get: vi.fn(async ({ sessionID }) => {
          if (!sessions.has(sessionID)) throw new Error('Not found');
          return sessions.get(sessionID);
        }),
        remove: vi.fn(async ({ sessionID }) => {
          if (failCleanup) throw new Error('Unavailable');
          sessions.delete(sessionID); entries.delete(sessionID);
        }),
        instructions: { entry: { put: vi.fn(async ({ sessionID, value }) => {
          if (failInstructions) throw new Error('Instructions unavailable');
          entries.set(sessionID, value);
        }) } },
      },
    };
    const app = express();
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: { classifyRequestScope: () => 'local' },
      uiAuthController: createUiAuth({
        password: randomUUID(),
        clientAuthController: { authenticateBearerToken: async (token) => token === 'test-browser-client' ? { ok: true, clientId: 'browser' } : null },
      }),
      getScheduledTaskSkillAuthHeaders: () => auth,
    });
    store = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'projects') });
    sync = vi.fn(async () => {});
    const common = {
      readSettingsFromDiskMigrated: async () => ({ projects }), sanitizeProjects: (projects) => projects,
      buildOpenCodeUrl: () => upstreamOrigin, getOpenCodeAuthHeaders: () => auth,
    };
    const router = express.Router();
    registerScheduledTaskRoutes(router, {
      ...common, projectConfigRuntime: store, scheduledTasksRuntime: { syncProject: sync },
      loadCatalog: async () => ({ models: [{ providerID: 'test', modelID: 'model' }] }),
    });
    registerScheduledTaskSessionSkill(app, {
      ...common, express, openchamberDataDir: root, registrationFile,
      getIsSharedOpenCodeService: () => true, waitForOpenCodeReady: async () => {},
      createClient: () => sdk, scheduledTaskRouter: router,
      validateDirectoryPath: async (directory) => {
        try { return { ok: true, directory: await fs.realpath(directory) }; } catch { return { ok: false }; }
      },
    });
    app.use(router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    ui = OpenCode.make({ baseUrl: origin, headers: { Authorization: 'Bearer test-browser-client' } });
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const create = (project = 'a') => ui.session.create({ location: { directory: path.join(root, `project-${project}`) }, title: 'User session', metadata: { existing: true } });
  const run = (command, input) => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve({ code, stdout, stderr, value: JSON.parse(code === 0 ? stdout : stderr) }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
  const commands = async (session) => {
    const describe = entries.get(session.id).split('\n')[1];
    const result = await run(describe);
    expect(result.code).toBe(0);
    return { describe, ...result.value.commands };
  };
  const task = { name: 'Daily review', enabled: false, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Review the project and produce a report.' } };

  it('adds a small on-demand entry to new sessions in different projects, without credentials', async () => {
    for (const project of ['a', 'b']) {
      const session = await create(project);
      expect(session.metadata.existing).toBe(true);
      expect(entries.get(session.id)).not.toContain(password);
      expect(entries.get(session.id)).not.toContain(auth.Authorization);
      expect(entries.get(session.id)).not.toContain('IANA');
      const described = await run((await commands(session)).describe);
      expect(described.code).toBe(0);
      expect(described.value.project.id).toBe(project);
      expect(described.value.skill).toContain('IANA');
    }
  });

  it('creates and reads back through the exact advertised commands with password auth enabled', async () => {
    const anonymous = await fetch(`${origin}/api/projects/a/scheduled-tasks`);
    expect(anonymous.status).toBe(401);
    const session = await create();
    const cmd = await commands(session);
    const result = await run(cmd.create, task);
    expect(result.code).toBe(0);
    expect(result.value.schedulerSynced).toBe(true);
    const saved = (await store.listScheduledTasks('a'))[0];
    expect(saved.execution).toMatchObject({ ...task.execution, providerID: 'test', modelID: 'model', agent: 'build', variant: 'high' });
    expect(saved.id).toBe(result.value.task.id);
    expect(await store.listScheduledTasks('b')).toEqual([]);
    const listed = await run(cmd.list);
    expect(listed.value.tasks[0].id).toBe(saved.id);
    expect(result.stdout + listed.stdout).not.toContain(password);
    expect(result.stdout + listed.stdout).not.toContain(task.execution.prompt);
    const duplicate = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ sessionID: session.id, operation: 'create', taskID: saved.id, input: { ...task, name: 'Overwrite' } }),
    });
    expect(duplicate.status).toBe(409);
    expect((await store.listScheduledTasks('a'))[0].name).toBe(task.name);
  });

  it('does not accept UI credentials, anonymous calls or browser origins on the bridge', async () => {
    const session = await create();
    for (const headers of [{}, { Authorization: 'Bearer test-browser-client' }, { ...auth, Origin: origin }]) {
      const response = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ operation: 'check', sessionID: session.id }) });
      expect(response.status).toBe(403);
    }
    expect(authorizeScheduledTaskSkillRequest({ method: 'POST', headers: { authorization: auth.Authorization }, socket: { remoteAddress: '192.0.2.1' } }, auth)).toBe(false);
  });

  it('rejects sessions created outside this Host', async () => {
    const session = await sdk.session.create({ location: { directory: root } });
    const response = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ operation: 'check', sessionID: session.id }) });
    expect(response.status).toBe(403);
    expect(entries.has(session.id)).toBe(false);
  });

  it('fails initialization before advertising a broken credential and leaves existing sessions intact', async () => {
    const existing = await create();
    await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password: randomUUID() }));
    await expect(create('b')).rejects.toThrow();
    expect(sessions.size).toBe(1);
    expect(sessions.has(existing.id)).toBe(true);
    expect(sdk.session.create).toHaveBeenCalledTimes(1);
  });

  it('rolls back only its newly created session if instruction installation fails', async () => {
    const existing = await create();
    failInstructions = true;
    await expect(create('b')).rejects.toThrow();
    expect(sessions.size).toBe(1);
    expect(sessions.has(existing.id)).toBe(true);
  });

  it('rolls back when the actual helper cannot authenticate during preflight', async () => {
    const createImpl = sdk.session.create.getMockImplementation();
    sdk.session.create.mockImplementationOnce(async (input) => {
      const session = await createImpl(input);
      await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password: randomUUID() }));
      return session;
    });
    await expect(create()).rejects.toThrow();
    expect(sessions.size).toBe(0);
    expect(entries.size).toBe(0);
    expect(sdk.session.remove).toHaveBeenCalledTimes(1);
  });

  it('reports the retained session when rollback fails', async () => {
    failInstructions = true; failCleanup = true;
    const response = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Authorization: 'Bearer test-browser-client', 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: root } }) });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(sessions.has(body.sessionID)).toBe(true);
  });

  it('does not treat scheduler sync failure as permission failure or retry the committed write', async () => {
    const session = await create();
    sync.mockRejectedValue(new Error('Scheduler unavailable'));
    const result = await run((await commands(session)).create, task);
    expect(result.code).toBe(0);
    expect(result.value.schedulerSynced).toBe(false);
    expect(await store.listScheduledTasks('a')).toHaveLength(1);
  });
});
