/**
 * Real Host + HTTP fixture + disk proof for scheduled-task PUT catalog checks.
 * Spawned with an isolated HOME before the server module loads. Not a unit mock.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '../../../../..');

const readJson = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { _unparsed: text.slice(0, 400) };
  }
};

const catalogBody = (url) => {
  const directory = url.searchParams.get('location[directory]') || '';
  const location = { directory };
  if (url.pathname === '/api/provider') {
    return { location, data: [{ id: 'p', name: 'P', activation: 'enabled', package: 'fixture' }] };
  }
  if (url.pathname === '/api/model') {
    return {
      location,
      data: ['good', 'also-good', 'other-good'].map((id) => ({
        id,
        modelID: 'internal-not-external',
        providerID: 'p',
        name: id,
        status: 'active',
        enabled: true,
      })),
    };
  }
  return { location, data: null };
};

if (process.env.REPRO_CHILD !== '1') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-sched-put-catalog-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data-dir');
  const workspace = path.join(root, 'workspace');
  const xdg = path.join(root, 'xdg');
  for (const dir of [home, dataDir, workspace, xdg, path.join(root, 'tmp'), path.join(xdg, 'config')]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const opencodeConfig = path.join(root, 'opencode-config');
  await fsp.mkdir(opencodeConfig, { recursive: true });
  await fsp.writeFile(path.join(opencodeConfig, 'opencode.jsonc'), '{}\n');

  let catalogMode = 'ok';
  let hold = null;
  const hits = [];
  const fixture = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const json = (status, body) => {
      hits.push({
        method: req.method,
        path: url.pathname,
        status,
        directory: url.searchParams.get('location[directory]') || '',
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/info') return json(200, { version: '2.0.23', pid: process.pid });
    if (url.pathname === '/api/experimental/migration/v1') return json(200, { status: 'completed' });
    if (url.pathname === '/api/provider' || url.pathname === '/api/model' || url.pathname === '/api/model/default') {
      if (catalogMode === 'down') return json(503, { error: 'fixture catalog unavailable' });
      if (hold && hold.remaining > 0) {
        hold.remaining -= 1;
        hold.held += 1;
        await hold.promise;
      }
      return json(200, catalogBody(url));
    }
    hits.push({ method: req.method, path: url.pathname, status: 404 });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = fixture.address().port;

  const control = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/mode/down') {
      catalogMode = 'down';
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/mode/ok') {
      catalogMode = 'ok';
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/hold') {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      hold = { remaining: 2, held: 0, promise, release };
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/hold') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ remaining: hold?.remaining ?? null, held: hold?.held ?? 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/hold/release') {
      hold?.release?.();
      hold = null;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hits));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));

  const waitForClose = (target, timeoutMs) => new Promise((resolve) => {
    if (target.exitCode !== null || target.signalCode !== null) {
      resolve({ code: target.exitCode, signal: target.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    target.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const stopOwnedChild = async (target) => {
    if (!target || target.exitCode !== null || target.signalCode !== null) {
      return { code: target?.exitCode ?? null, signal: target?.signalCode ?? null };
    }
    target.kill('SIGTERM');
    const exited = await waitForClose(target, 5_000);
    if (exited) return exited;
    target.kill('SIGKILL');
    return await waitForClose(target, 5_000) || { code: null, signal: 'SIGKILL' };
  };
  const closeServer = (server) => new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  const child = spawn(process.execPath, [SCRIPT], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USER: process.env.USER || 'repro',
      LOGNAME: process.env.LOGNAME || process.env.USER || 'repro',
      SHELL: process.env.SHELL || '/bin/sh',
      TMPDIR: path.join(root, 'tmp'),
      LANG: process.env.LANG || 'C',
      REPRO_CHILD: '1',
      REPRO_ROOT: root,
      REPRO_WORKSPACE: workspace,
      OPENCHAMBER_DATA_DIR: dataDir,
      OPENCHAMBER_RUNTIME: 'web',
      OPENCHAMBER_API_ONLY: 'true',
      OPENCHAMBER_SKIP_OPENCODE_START: 'true',
      OPENCODE_SKIP_START: 'true',
      OPENCODE_HOST: `http://127.0.0.1:${fixturePort}`,
      OPENCODE_CONFIG_DIR: opencodeConfig,
      OPENCODE_CONFIG: path.join(opencodeConfig, 'opencode.jsonc'),
      XDG_CONFIG_HOME: path.join(xdg, 'config'),
      XDG_DATA_HOME: path.join(xdg, 'data'),
      XDG_STATE_HOME: path.join(xdg, 'state'),
      XDG_CACHE_HOME: path.join(xdg, 'cache'),
      FIXTURE_CONTROL_PORT: String(control.address().port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let cleaning = false;
  const cleanup = async (exitCode) => {
    if (cleaning) return;
    cleaning = true;
    const ownedExit = await stopOwnedChild(child);
    await closeServer(fixture);
    await closeServer(control);
    let report = null;
    try {
      report = JSON.parse(await fsp.readFile(path.join(root, 'report.json'), 'utf8'));
    } catch {
      report = { ok: false, error: 'child report missing', stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) };
    }
    console.log(JSON.stringify({
      exit: ownedExit,
      hits: hits.filter((entry) => entry.path === '/api/provider' || entry.path === '/api/model'),
      report,
    }));
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    process.exit(exitCode);
  };
  process.once('SIGTERM', () => { void cleanup(1); });
  process.once('SIGINT', () => { void cleanup(1); });
  const exit = await waitForClose(child, 90_000);
  await cleanup(exit?.code === 0 ? 0 : 1);
}

const home = process.env.HOME;
if (os.homedir() !== home) {
  console.log(JSON.stringify({ error: 'HOME isolation failed', homedir: os.homedir(), home }));
  process.exit(1);
}

const { startWebUiServer } = await import(pathToFileURL(path.join(REPO, 'packages/web/server/index.js')).href);
const control = `http://127.0.0.1:${process.env.FIXTURE_CONTROL_PORT}`;
let controller = null;
let stoppingHost = false;
const stopHost = async () => {
  if (stoppingHost) return;
  stoppingHost = true;
  if (controller) {
    await Promise.race([
      controller.stop({ exitProcess: false, forceCloseConnections: true }),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
};
process.once('SIGTERM', () => { void stopHost().finally(() => process.exit(1)); });
process.once('SIGINT', () => { void stopHost().finally(() => process.exit(1)); });
const report = { isolation: { home, dataDir: process.env.OPENCHAMBER_DATA_DIR } };

const fail = (message, extra) => {
  const error = new Error(message);
  error.extra = extra;
  throw error;
};

try {
  controller = await startWebUiServer({
    host: '127.0.0.1',
    port: 0,
    attachSignals: false,
    exitOnShutdown: false,
    apiOnly: true,
  });
  if (controller.getOpenCodeProcessInfo?.().managed) fail('managed OpenCode was spawned');
  const deadline = Date.now() + 25_000;
  while (!controller.isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!controller.isReady()) fail('OpenCode fixture was not admitted');
  const base = `http://127.0.0.1:${controller.getPort()}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await readJson(response) };
  };
  const registered = await call('POST', '/api/opencode/directory', { path: process.env.REPRO_WORKSPACE });
  if (registered.status !== 200) fail('project register failed', registered);
  const project = registered.body.settings.projects.find((entry) => entry.path === registered.body.path);
  const projectID = project.id;
  const directory = registered.body.path;
  const putPath = `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`;
  const configPath = path.join(home, '.config', 'openchamber', 'projects', `${projectID}.json`);
  const readDisk = async () => {
    try {
      return JSON.parse(await fsp.readFile(configPath, 'utf8')).scheduledTasks || [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };
  const task = (name, modelID, extra = {}) => ({
    name,
    enabled: false,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'repro only; do not run', providerID: 'p', modelID },
    ...extra,
  });

  const catalog = await call('GET', `/api/config/catalog/providers?directory=${encodeURIComponent(directory)}`);
  const modelIDs = Object.keys(catalog.body?.providers?.find((entry) => entry.id === 'p')?.models || {});
  if (catalog.status !== 200 || !modelIDs.includes('good') || modelIDs.includes('internal-not-external')) {
    fail('catalog did not project ModelInfo.id', { status: catalog.status, modelIDs });
  }

  const beforeMissing = await readDisk();
  const missing = await call('PUT', putPath, { task: task('missing-model', 'nonexistent') });
  if (missing.status !== 400 || (await readDisk()).length !== beforeMissing.length) {
    fail('H1 unconnected model was saved', missing);
  }
  const internal = await call('PUT', putPath, { task: task('internal-id', 'internal-not-external') });
  if (internal.status !== 400) fail('internal modelID was accepted', internal);

  for (const body of [task('bare', 'good'), { tasks: [] }, { task: [] }]) {
    const response = await call('PUT', putPath, body);
    if (response.status !== 400 || !response.body?.expected?.task) {
      fail('envelope did not explain expected', { body, response });
    }
  }
  if ((await readDisk()).length !== 0) fail('rejected envelope wrote a task');

  const created = await call('PUT', putPath, { task: task('wrapped-good', 'good') });
  if (created.status !== 200 || created.body?.task?.execution?.modelID !== 'good' || created.body?.task?.enabled !== false) {
    fail('valid disabled model was not saved', created);
  }
  const createdID = created.body.task.id;
  const saved = (await readDisk()).find((entry) => entry.id === createdID);
  if (!saved || saved.execution.modelID !== 'good') fail('valid model did not persist', saved);

  const farSchedule = { kind: 'once', date: '2099-01-01', time: '00:00', timezone: 'UTC' };
  const armed = await call('PUT', putPath, {
    task: {
      name: 'armed-far',
      enabled: true,
      schedule: farSchedule,
      execution: { prompt: 'repro only; do not run', providerID: 'p', modelID: 'good' },
    },
  });
  const armedID = armed.body?.task?.id;
  const armedDisk = (await readDisk()).find((entry) => entry.id === armedID);
  if (armed.status !== 200 || armed.body?.task?.enabled !== true || armedDisk?.enabled !== true) {
    fail('enabled far-future task was not saved while catalog was healthy', { armed, armedDisk });
  }

  await fetch(`${control}/mode/down`, { method: 'POST' });
  const catalogDown = await call('GET', `/api/config/catalog/providers?directory=${encodeURIComponent(directory)}`);
  if (catalogDown.status !== 502) fail('GET catalog status changed', catalogDown);
  const beforeDown = await readDisk();
  const saveDown = await call('PUT', putPath, { task: task('saved-while-down', 'nonexistent') });
  const afterDownSave = await readDisk();
  if (saveDown.status !== 503 || JSON.stringify(afterDownSave) !== JSON.stringify(beforeDown)) {
    fail('catalog failure still saved', { saveDown, afterDownSave });
  }
  const renamed = await call('PUT', putPath, {
    task: { ...task('renamed-while-down', 'good', { id: createdID, enabled: false }) },
  });
  if (renamed.status !== 200 || renamed.body?.task?.name !== 'renamed-while-down') {
    fail('rename during catalog failure failed', renamed);
  }
  const disabled = await call('PUT', putPath, {
    task: task('renamed-while-down', 'good', { id: createdID, enabled: false }),
  });
  if (disabled.status !== 200 || disabled.body?.task?.enabled !== false) fail('disable during catalog failure failed', disabled);
  const catalogHits = (list) => (Array.isArray(list) ? list : []).filter((entry) => (
    entry.path === '/api/provider' || entry.path === '/api/model'
  ));
  const hitsBeforeDisable = catalogHits(await readJson(await fetch(`${control}/hits`)));
  const turnedOff = await call('PUT', putPath, {
    task: {
      id: armedID,
      name: 'armed-far',
      enabled: false,
      schedule: farSchedule,
      execution: { prompt: 'repro only; do not run', providerID: 'p', modelID: 'good' },
    },
  });
  const hitsAfterDisable = catalogHits(await readJson(await fetch(`${control}/hits`)));
  const armedAfter = (await readDisk()).find((entry) => entry.id === armedID);
  if (
    turnedOff.status !== 200
    || turnedOff.body?.task?.enabled !== false
    || armedAfter?.enabled !== false
    || hitsAfterDisable.length !== hitsBeforeDisable.length
  ) {
    fail('enabled task was not disabled without a catalog request', {
      turnedOff,
      armedAfter,
      before: hitsBeforeDisable.length,
      after: hitsAfterDisable.length,
    });
  }
  if (!hitsAfterDisable.some((entry) => entry.directory === directory)) {
    fail('fixture catalog requests omitted the project directory', hitsAfterDisable.slice(0, 4));
  }

  const enableDown = await call('PUT', putPath, {
    task: task('renamed-while-down', 'good', { id: createdID, enabled: true }),
  });
  const afterEnable = (await readDisk()).find((entry) => entry.id === createdID);
  if (enableDown.status !== 503 || afterEnable?.enabled !== false) {
    fail('enable during catalog failure persisted', { enableDown, afterEnable });
  }
  await fetch(`${control}/mode/ok`, { method: 'POST' });

  const waitHeld = async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const status = await readJson(await fetch(`${control}/hold`));
      if (status.held >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fail('catalog hold was not reached');
  };

  await fetch(`${control}/hold`, { method: 'POST' });
  const enableRace = call('PUT', putPath, {
    task: task('enable-race', 'good', { id: createdID, enabled: true }),
  });
  await waitHeld();
  const deleted = await call('DELETE', `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(createdID)}`);
  await fetch(`${control}/hold/release`, { method: 'POST' });
  const enableResult = await enableRace;
  if (deleted.status !== 200 || enableResult.status !== 409 || (await readDisk()).some((entry) => entry.id === createdID)) {
    fail('delete race did not 409', { deleted, enableResult, disk: await readDisk() });
  }

  const again = await call('PUT', putPath, { task: task('model-race', 'good') });
  if (again.status !== 200) fail('recreate failed', again);
  const raceID = again.body.task.id;
  await fetch(`${control}/hold`, { method: 'POST' });
  const staleModel = call('PUT', putPath, {
    task: task('stale-model', 'also-good', { id: raceID, enabled: false }),
  });
  await waitHeld();
  const winner = await call('PUT', putPath, {
    task: task('winner-model', 'other-good', { id: raceID, enabled: false }),
  });
  await fetch(`${control}/hold/release`, { method: 'POST' });
  const staleResult = await staleModel;
  const finalTask = (await readDisk()).find((entry) => entry.id === raceID);
  if (winner.status !== 200 || staleResult.status !== 409 || finalTask?.execution?.modelID !== 'other-good' || finalTask?.name !== 'winner-model') {
    fail('model race did not 409', { winner, staleResult, finalTask });
  }

  report.ok = true;
  report.projectID = projectID;
  report.directory = directory;
  report.disabledFromEnabled = true;
  report.configPath = configPath;
  report.underDataDir = configPath.startsWith(process.env.OPENCHAMBER_DATA_DIR);
  await fsp.writeFile(path.join(process.env.REPRO_ROOT, 'report.json'), JSON.stringify(report));
} catch (error) {
  await fsp.writeFile(path.join(process.env.REPRO_ROOT, 'report.json'), JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    extra: error?.extra || null,
    report,
  }));
  process.exitCode = 1;
} finally {
  await stopHost();
  process.exit(process.exitCode || 0);
}
