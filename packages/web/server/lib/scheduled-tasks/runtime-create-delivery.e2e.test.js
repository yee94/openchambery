/**
 * Real HTTP + scheduler timer + SQLite delivery contract.
 *
 * Proven-unsent connect (ECONNREFUSED / ENOTFOUND) may retry inside the same
 * run. A create that already reached upstream must not be posted again and
 * must not prompt. 503 / missing session id is not proof the session was
 * not created.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import {
  configureServerOpenCodeFetchGate,
  getRegisteredRuntimeContract,
  getRegisteredRuntimeContractGateOptions,
} from '../opencode/server-opencode-fetch.js';
import { createRevokedRuntimeContract, evaluateRuntimeContract } from '../opencode/runtime-contract.js';
import { createScheduledTaskRunHistoryStore } from './run-history-store.js';
import { createScheduledTasksRuntime } from './runtime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const allowedContract = () => evaluateRuntimeContract({
  serveVersion: '2.0.23',
  cliVersion: '2.0.23',
  reachable: true,
  authenticated: true,
  healthOk: true,
  migrationAdmitTranscript: true,
});

const cronLead = (leadSeconds) => {
  const target = new Date(Date.now() + leadSeconds * 1000);
  return `${target.getUTCSeconds()} * * * * *`;
};

const bind = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});

const bindPort = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(port);
  });
});

const reservedPort = async () => {
  const probe = http.createServer();
  const port = await bind(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

function createFaultServer() {
  const requests = [];
  const state = { mode: 'ok', holds: [] };
  const send = (res, status, body, contentType = 'application/json') => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ t: Date.now(), method: req.method, path: url.pathname, body });
    if (req.method === 'GET' && (url.pathname === '/global/health' || url.pathname === '/api/health')) {
      send(res, 200, { healthy: true, version: '2.0.23' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      if (state.mode === '503-after-create') {
        send(res, 503, {
          data: { id: 'ses_created_before_503' },
          message: 'proxy failed after create Bearer secret-token https://user:credential@example.test/x?token=abc',
          code: 'CREATED_THEN_503',
          status: 499,
          retryable: true,
        });
        return;
      }
      if (state.mode === 'drop-after-request') {
        req.socket.destroy();
        return;
      }
      if (state.mode === 'hang-body') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.flushHeaders();
        res.write('{"message":"partial');
        state.holds.push(res);
        return;
      }
      if (state.mode === 'redirect-307' || state.mode === 'redirect-308') {
        const status = state.mode === 'redirect-308' ? 308 : 307;
        res.writeHead(status, {
          location: state.redirectTo,
          'content-length': 0,
        });
        res.end();
        return;
      }
      if (state.mode === 'non-json') {
        send(res, 503, '<<<not-json', 'text/plain');
        return;
      }
      if (state.mode === 'oversize') {
        send(res, 503, { message: 'M'.repeat(80_000), code: 'HUGE', status: 503 });
        return;
      }
      if (state.mode === '401') {
        send(res, 401, {
          data: {
            message: `token expired ${'N'.repeat(2_500)} TAIL401`,
            code: 'AUTH_EXPIRED',
            status: 401,
          },
        });
        return;
      }
      if (state.mode === '403') {
        send(res, 403, {
          error: { message: 'scheduled caller is forbidden', code: 'FORBIDDEN_SCOPE', status: 403 },
        });
        return;
      }
      if (state.mode === '409') {
        send(res, 409, { message: 'create conflict', code: 'CREATE_CONFLICT', status: 409 });
        return;
      }
      if (state.mode === 'malformed-200') {
        send(res, 200, '{');
        return;
      }
      if (state.mode === 'success-without-id') {
        send(res, 200, { data: {} });
        return;
      }
      if (state.mode === 'split-503') {
        let title = '';
        try { title = JSON.parse(body).title || ''; } catch { title = ''; }
        const code = title.includes('Alpha') ? 'ALPHA_CODE' : 'BETA_CODE';
        send(res, 503, { data: { error: { message: `${code} nested`, code, status: 429 } } });
        return;
      }
      const index = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/session').length;
      send(res, 200, { data: { id: `ses_${index}` } });
      return;
    }
    if (req.method === 'POST' && /\/prompt$/.test(url.pathname)) {
      send(res, 200, { data: { id: 'msg_prompt' } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session/active') {
      send(res, 200, { data: {} });
      return;
    }
    if (req.method === 'GET' && /\/message$/.test(url.pathname)) {
      if (state.mode === 'assistant-secret') {
        send(res, 200, {
          data: [{
            id: 'msg_secret',
            type: 'assistant',
            finish: 'error',
            time: { created: 1, completed: 2 },
            error: {
              message: 'failed Bearer secret-value password:hunter2 {"token":"abc-token"}',
            },
          }],
        });
        return;
      }
      if (state.mode === 'assistant-nested') {
        send(res, 200, {
          data: [{
            id: 'msg_asst',
            type: 'assistant',
            finish: 'error',
            time: { created: 1, completed: 2 },
            error: {
              name: 'APIError',
              data: { error: { message: 'quota exceeded for model', code: 'insufficient_quota', status: 429 } },
            },
          }],
        });
        return;
      }
      send(res, 200, {
        data: [{ id: 'msg_ok', type: 'assistant', finish: 'stop', time: { created: 1, completed: 2 } }],
      });
      return;
    }
    send(res, 404, { message: 'missing' });
  });
  return {
    server,
    requests,
    state,
    creates: () => requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/session'),
    prompts: () => requests.filter((entry) => entry.method === 'POST' && /\/prompt$/.test(entry.path)),
    releaseHolds() {
      for (const held of state.holds) {
        try { held.destroy(); } catch { /* already closed */ }
      }
      state.holds.length = 0;
    },
  };
}

async function makeWorkspace(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sched-delivery-${name}-`));
  const projectsDir = path.join(dir, 'projects');
  const projectPath = path.join(dir, 'project');
  await fs.mkdir(projectsDir);
  await fs.mkdir(projectPath);
  return {
    dir,
    projectsDir,
    projectPath,
    dbPath: path.join(dir, 'runs.sqlite'),
    projectID: `delivery-${name}`.replace(/[^a-zA-Z0-9._:-]/g, ''),
  };
}

function wireRuntime(workspace, baseUrl, store, extras = {}) {
  const logs = [];
  const notifications = [];
  const projectConfigRuntime = createProjectConfigRuntime({
    fsPromises: fs,
    path,
    projectsDirPath: workspace.projectsDir,
  });
  resources.push({ workspace, store });
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime,
    listProjects: async () => [{ id: workspace.projectID, path: workspace.projectPath }],
    buildOpenCodeUrl: () => baseUrl,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer repro-not-secret' }),
    waitForOpenCodeReady: async () => {},
    persistSessionMetadata: async () => {},
    runHistoryStore: store,
    notifyTaskRun: async (event) => { notifications.push(event); },
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
    maxRunDurationMs: extras.maxRunDurationMs ?? 30_000,
    ...(extras.createPhaseDeadlineMs ? { createPhaseDeadlineMs: extras.createPhaseDeadlineMs } : {}),
  });
  return { projectConfigRuntime, runtime, logs, notifications };
}

async function waitForTerminal(store, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const terminal = store.listRuns({ limit: 5 }).runs.find((run) => run.status !== 'running');
    if (terminal) return terminal;
    await sleep(30);
  }
  return null;
}

async function armScheduled(workspace, runtime, projectConfigRuntime, task) {
  await projectConfigRuntime.upsertScheduledTask(workspace.projectID, task);
  await runtime.start();
}

let upstream;
let previousContract;
let previousGateOptions;
const stoppers = [];
const resources = [];

beforeAll(() => {
  previousContract = getRegisteredRuntimeContract();
  previousGateOptions = getRegisteredRuntimeContractGateOptions();
});

beforeEach(() => {
  configureServerOpenCodeFetchGate(() => allowedContract());
  upstream = createFaultServer();
  stoppers.length = 0;
});

afterEach(async () => {
  upstream?.releaseHolds();
  // Hung bodies are released by closing the socket, not by runtime.stop().
  // stop() only clears timers and does not abort an in-flight create.
  upstream?.server?.closeAllConnections?.();
  for (const stop of stoppers) stop();
  for (const item of resources) {
    try { item.store.close(); } catch { /* already closed */ }
    await fs.rm(item.workspace.dir, { recursive: true, force: true });
  }
  resources.length = 0;
  if (upstream?.server.listening) {
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

afterAll(() => {
  configureServerOpenCodeFetchGate(() => previousContract, previousGateOptions);
});

it('does not follow a 307/308 after create or treat the redirect failure as unsent', async () => {
  const closed = await reservedPort();
  const port = await bind(upstream.server);
  upstream.state.mode = 'redirect-307';
  upstream.state.redirectTo = `http://127.0.0.1:${closed}/api/session`;
  const workspace = await makeWorkspace('redir307');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    createPhaseDeadlineMs: 2_500,
  });
  stoppers.push(() => runtime.stop());
  const redirected = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-307',
    name: 'Redirect307',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(1);
  expect(upstream.prompts()).toHaveLength(0);
  expect(redirected.error).toContain('creation outcome unknown');
  expect(redirected.error).not.toContain('request not sent');

  upstream.state.mode = 'redirect-308';
  upstream.state.redirectTo = 'http://sched-create-fixture.invalid/api/session';
  upstream.requests.length = 0;
  const again = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-308',
    name: 'Redirect308',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(1);
  expect(again.error).toContain('creation outcome unknown');
  expect(again.error).not.toContain('request not sent');
}, 20_000);

it('redacts a bearer in an assistant message that has no code or status', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = 'assistant-secret';
  const workspace = await makeWorkspace('secret');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-secret',
    name: 'Secret',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(result.status).toBe('error');
  expect(result.error).not.toContain('secret-value');
  expect(result.error).not.toContain('hunter2');
  expect(result.error).not.toContain('abc-token');
  expect(result.error.startsWith('assistant HTTP')).toBe(false);
});

it('retries session.create after ECONNREFUSED once the same port opens', async () => {
  const port = await reservedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace = await makeWorkspace('refused');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, baseUrl, store);
  stoppers.push(() => runtime.stop());
  await armScheduled(workspace, runtime, projectConfigRuntime, {
    id: 'task-refused',
    name: 'Refused',
    enabled: true,
    schedule: { kind: 'cron', cron: cronLead(5), timezone: 'UTC' },
    execution: { prompt: 'repro refused', providerID: 'repro', modelID: 'repro-model' },
  });
  const runningDeadline = Date.now() + 12_000;
  while (Date.now() < runningDeadline && store.listRunningRuns({ limit: 1 }).runs.length === 0) {
    await sleep(20);
  }
  const running = store.listRunningRuns({ limit: 1 }).runs[0];
  expect(running?.status).toBe('running');
  // The first connect fails while nothing is listening. Open during the 1s backoff.
  await sleep(200);
  await bindPort(upstream.server, port);
  const terminal = await waitForTerminal(store, 12_000);
  expect(terminal).toMatchObject({ status: 'success', trigger: 'scheduled' });
  expect(terminal.finishedAt - terminal.startedAt).toBeGreaterThanOrEqual(800);
  expect(upstream.creates().length).toBeGreaterThanOrEqual(1);
  expect(upstream.prompts().length).toBe(1);
  expect(terminal.sessionId).toBeTruthy();
}, 30_000);

async function runManual(workspace, runtime, projectConfigRuntime, task) {
  await projectConfigRuntime.upsertScheduledTask(workspace.projectID, {
    ...task,
    schedule: task.schedule || { kind: 'cron', cron: cronLead(50), timezone: 'UTC' },
  });
  await runtime.syncProject(workspace.projectID);
  return runtime.runNow(workspace.projectID, task.id);
}

it('does not repost session.create or prompt after upstream 503 that follows a create', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = '503-after-create';
  const workspace = await makeWorkspace('created503');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime, logs, notifications } = wireRuntime(
    workspace,
    `http://127.0.0.1:${port}`,
    store,
  );
  stoppers.push(() => runtime.stop());
  await armScheduled(workspace, runtime, projectConfigRuntime, {
    id: 'task-503',
    name: 'Created503',
    enabled: true,
    schedule: { kind: 'cron', cron: cronLead(5), timezone: 'UTC' },
    execution: { prompt: 'repro 503', providerID: 'repro', modelID: 'repro-model' },
  });
  const terminal = await waitForTerminal(store, 15_000);
  expect(upstream.creates()).toHaveLength(1);
  expect(upstream.prompts()).toHaveLength(0);
  expect(terminal).toMatchObject({ status: 'error', trigger: 'scheduled', sessionId: null });
  const error = terminal.error || '';
  expect(error).toContain('creation outcome unknown');
  expect(error).toContain('HTTP 503');
  expect(error).toContain('code=CREATED_THEN_503');
  expect(error).toContain('retryable=false');
  expect(error).not.toContain('HTTP 499');
  expect(error).not.toContain('secret-token');
  expect(error).not.toContain('credential');
  expect(error).not.toMatch(/not created/i);
  expect(error.length).toBeLessThanOrEqual(300);
  expect(notifications.at(-1)?.errorMessage).toBe(error);
  expect(JSON.stringify(logs)).toContain(error);
  expect(JSON.stringify(logs)).not.toContain('secret-token');
}, 25_000);

it('does not repost after the proxy drops the create response', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = 'drop-after-request';
  const workspace = await makeWorkspace('dropped');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-drop',
    name: 'Dropped',
    enabled: true,
    execution: { prompt: 'repro drop', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(1);
  expect(upstream.prompts()).toHaveLength(0);
  expect(result.status).toBe('error');
  expect(result.error).toContain('creation outcome unknown');
  expect(result.error).toContain('retryable=false');
  expect(store.listRuns({ limit: 5 }).runs).toHaveLength(1);
});

it.each([
  ['401', 'HTTP 401', 'code=AUTH_EXPIRED', 'TAIL401'],
  ['403', 'HTTP 403', 'code=FORBIDDEN_SCOPE', null],
  ['409', 'HTTP 409', 'code=CREATE_CONFLICT', null],
])('does not retry session.create on %s', async (mode, statusText, codeText, absent) => {
  const port = await bind(upstream.server);
  upstream.state.mode = mode;
  const workspace = await makeWorkspace(mode);
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: `task-${mode}`,
    name: `Auth${mode}`,
    enabled: true,
    execution: { prompt: 'repro auth', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(1);
  expect(upstream.prompts()).toHaveLength(0);
  expect(result.error).toContain(statusText);
  expect(result.error).toContain(codeText);
  expect(result.error).toContain('retryable=false');
  expect(result.error.length).toBeLessThanOrEqual(300);
  if (absent) expect(result.error).not.toContain(absent);
});

it('does not bypass the runtime-contract gate or retry a local 409', async () => {
  const port = await bind(upstream.server);
  configureServerOpenCodeFetchGate(() => createRevokedRuntimeContract('instance-revoked'));
  const workspace = await makeWorkspace('gate409');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-gate',
    name: 'Gate',
    enabled: true,
    execution: { prompt: 'repro gate', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(0);
  expect(result.error).toContain('HTTP 409');
  expect(result.error).toContain('retryable=false');
  expect(result.error).toContain('creation outcome unknown');
});

it('does not retry a decode failure or a success body without an id', async () => {
  const port = await bind(upstream.server);
  const workspace = await makeWorkspace('decode');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  upstream.state.mode = 'malformed-200';
  const decoded = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-decode',
    name: 'Decode',
    enabled: true,
    execution: { prompt: 'repro decode', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(1);
  expect(decoded.error).toContain('creation outcome unknown');
  upstream.state.mode = 'success-without-id';
  const missing = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-noid',
    name: 'NoId',
    enabled: true,
    execution: { prompt: 'repro noid', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(upstream.creates()).toHaveLength(2);
  expect(missing.error).toContain('creation outcome unknown');
  expect(missing.error).toContain('failed to create session');
});

it('bounds oversized, hung, and non-JSON create failures without masking the HTTP status', async () => {
  const port = await bind(upstream.server);
  const workspace = await makeWorkspace('bounds');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    maxRunDurationMs: 8_000,
  });
  stoppers.push(() => runtime.stop());
  upstream.state.mode = 'oversize';
  const huge = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-huge',
    name: 'Huge',
    enabled: true,
    execution: { prompt: 'repro huge', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(huge.error.length).toBeLessThanOrEqual(300);
  expect(huge.error).toContain('HTTP 503');
  expect(huge.error).toContain('creation outcome unknown');
  expect(huge.error).not.toContain('MMMMMMMM');
  upstream.state.mode = 'non-json';
  const text = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-text',
    name: 'Text',
    enabled: true,
    execution: { prompt: 'repro text', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(text.error).toContain('HTTP 503');
  expect(text.error).not.toContain('SyntaxError');
  expect(text.error).not.toContain('<<<not-json');
  expect(upstream.creates()).toHaveLength(2);
  expect(upstream.prompts()).toHaveLength(0);
}, 20_000);

it('aborts a hung create body at the create deadline and does not repost', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = 'hang-body';
  const workspace = await makeWorkspace('hang');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    createPhaseDeadlineMs: 1_000,
    maxRunDurationMs: 30_000,
  });
  stoppers.push(() => runtime.stop());
  const started = Date.now();
  const hung = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-hang',
    name: 'Hang',
    enabled: true,
    execution: { prompt: 'repro hang', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(upstream.creates()).toHaveLength(1);
  expect(upstream.prompts()).toHaveLength(0);
  expect(hung.error).toContain('creation outcome unknown');
  expect(hung.error).toContain('retryable=false');
  expect(hung.error).not.toContain('request not sent');
});

it('does not cross-wire concurrent create diagnostics', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = 'split-503';
  const workspace = await makeWorkspace('split');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  await projectConfigRuntime.upsertScheduledTask(workspace.projectID, {
    id: 'task-alpha',
    name: 'Alpha',
    enabled: true,
    schedule: { kind: 'cron', cron: cronLead(50), timezone: 'UTC' },
    execution: { prompt: 'alpha', providerID: 'repro', modelID: 'repro-model' },
  });
  await projectConfigRuntime.upsertScheduledTask(workspace.projectID, {
    id: 'task-beta',
    name: 'Beta',
    enabled: true,
    schedule: { kind: 'cron', cron: cronLead(50), timezone: 'UTC' },
    execution: { prompt: 'beta', providerID: 'repro', modelID: 'repro-model' },
  });
  await runtime.syncProject(workspace.projectID);
  const [alpha, beta] = await Promise.all([
    runtime.runNow(workspace.projectID, 'task-alpha'),
    runtime.runNow(workspace.projectID, 'task-beta'),
  ]);
  expect(alpha.error).toContain('ALPHA_CODE');
  expect(alpha.error).not.toContain('BETA_CODE');
  expect(beta.error).toContain('BETA_CODE');
  expect(beta.error).not.toContain('ALPHA_CODE');
  expect(upstream.creates()).toHaveLength(2);
});

it('does not post after the watchdog aborts, even if the port opens across the retry window', async () => {
  const port = await reservedPort();
  const workspace = await makeWorkspace('watchdog');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    maxRunDurationMs: 700,
  });
  stoppers.push(() => runtime.stop());
  const started = Date.now();
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-watch',
    name: 'Watch',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.error).toBe('schedule run timed out');
  await bindPort(upstream.server, port);
  // 1s + 4s + 10s retry budget. A late retry would POST once the port is open.
  await sleep(15_500);
  expect(upstream.creates()).toHaveLength(0);
  expect(upstream.prompts()).toHaveLength(0);
}, 25_000);

it('exhausts exactly the 1s/4s/10s unsent retry budget', async () => {
  const port = await reservedPort();
  const workspace = await makeWorkspace('budget');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    maxRunDurationMs: 30_000,
  });
  stoppers.push(() => runtime.stop());
  const started = Date.now();
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-budget',
    name: 'Budget',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(15_000);
  expect(elapsed).toBeLessThan(20_000);
  expect(result.error).toContain('request not sent');
  expect(result.error).toContain('code=ECONNREFUSED');
}, 25_000);

it('classifies a fixture .invalid host as ENOTFOUND without leaving the deadline', async () => {
  const workspace = await makeWorkspace('enotfound');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(
    workspace,
    'http://sched-create-redirect.invalid',
    store,
    { createPhaseDeadlineMs: 2_000, maxRunDurationMs: 30_000 },
  );
  stoppers.push(() => runtime.stop());
  const started = Date.now();
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-dns',
    name: 'Dns',
    enabled: true,
    execution: { prompt: 'fixture', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.error).toContain('code=ENOTFOUND');
  expect(result.error).toContain('request not sent');
  expect(result.error).not.toContain('hunter2');
});

it('stops unsent retries at the create-phase deadline', async () => {
  const port = await reservedPort();
  const workspace = await makeWorkspace('deadline');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store, {
    createPhaseDeadlineMs: 400,
    maxRunDurationMs: 30_000,
  });
  stoppers.push(() => runtime.stop());
  const started = Date.now();
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-deadline',
    name: 'Deadline',
    enabled: true,
    execution: { prompt: 'repro deadline', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(result.error).toContain('request not sent');
  expect(result.error).toContain('code=ECONNREFUSED');
  expect(result.error).not.toContain('creation outcome unknown');
});

it('keeps nested assistant message, code, and status in the shared summary', async () => {
  const port = await bind(upstream.server);
  upstream.state.mode = 'assistant-nested';
  const workspace = await makeWorkspace('assistant');
  const store = createScheduledTaskRunHistoryStore({ dbPath: workspace.dbPath });
  const { projectConfigRuntime, runtime } = wireRuntime(workspace, `http://127.0.0.1:${port}`, store);
  stoppers.push(() => runtime.stop());
  const result = await runManual(workspace, runtime, projectConfigRuntime, {
    id: 'task-assistant',
    name: 'Assistant',
    enabled: true,
    execution: { prompt: 'repro assistant', providerID: 'repro', modelID: 'repro-model' },
  });
  expect(result.status).toBe('error');
  expect(result.error).toContain('quota exceeded for model');
  expect(result.error).toContain('code=insufficient_quota');
  expect(result.error).toContain('HTTP 429');
  expect(result.error).not.toBe('APIError');
  expect(result.error.length).toBeLessThanOrEqual(300);
});
