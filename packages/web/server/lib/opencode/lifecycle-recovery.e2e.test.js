/**
 * Real-child lifecycle recovery. Isolated HOME/XDG/registry/workdir and a
 * loopback fixture. Never resolves or signals the user OpenCode binary.
 * Identity mismatch does not kill. Only the current owned handle is closed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const FAKE_PASSWORD = 'fixture-not-a-real-credential';
const basicAuth = `Basic ${Buffer.from(`opencode:${FAKE_PASSWORD}`, 'utf8').toString('base64')}`;
const ISOLATION_KEYS = [
  'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  'OPENCHAMBER_DATA_DIR', 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY',
  'OPENCODE_BINARY', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD',
  'FIXTURE_CONTROL_FILE', 'FIXTURE_LOG_FILE',
];

const FIXTURE_SOURCE = `#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.0.23\\n'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
const hostname = args[args.indexOf('--hostname') + 1];
if (hostname !== '127.0.0.1' || !Number.isInteger(port) || port <= 0 || port === 4096) process.exit(1);
const readControl = () => {
  try { return JSON.parse(fs.readFileSync(process.env.FIXTURE_CONTROL_FILE, 'utf8')); } catch { return {}; }
};
const log = (event) => {
  if (!process.env.FIXTURE_LOG_FILE) return;
  fs.appendFileSync(process.env.FIXTURE_LOG_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\\n');
};
const control = readControl();
log({ event: 'spawn', failStart: control.failStart === true });
if (control.failStart === true) process.exit(1);
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const expected = password ? 'Basic ' + Buffer.from('opencode:' + password).toString('base64') : '';
const server = http.createServer((req, res) => {
  const current = readControl();
  if (current.exitNow === 0) { res.end(); process.exit(0); }
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const authorized = !expected || req.headers.authorization === expected;
  const poisoned = Number(current.poisonPid) === process.pid;
  let status = 200;
  let body = { version: '2.0.23', pid: process.pid };
  if (!authorized) { status = 401; body = { error: 'unauthorized' }; }
  else if ((pathname === '/api/info' || pathname === '/global/health') && poisoned) { status = 500; body = { error: 'poisoned' }; }
  else if (pathname === '/global/health') body = { healthy: true, version: '2.0.23', pid: process.pid };
  else if (pathname === '/api/experimental/migration/v1') body = { status: 'completed' };
  else if (pathname === '/api/config/providers' || pathname === '/api/provider') { status = 500; body = { error: 'business' }; }
  else if (pathname === '/api/agent' || pathname === '/api/skill') { status = 503; body = { error: 'business' }; }
  else if (pathname !== '/api/info') { status = 404; body = { error: 'not-found' }; }
  const send = () => {
    log({ event: 'http', path: pathname, status });
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  };
  if (current.holdHealth && (pathname === '/api/info' || pathname === '/global/health')) {
    const timer = setInterval(() => {
      if (!readControl().holdHealth) { clearInterval(timer); send(); }
    }, 20);
    setTimeout(() => clearInterval(timer), 8000).unref?.();
    return;
  }
  send();
});
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => { if (readControl().exitNow === 0) process.exit(0); }, 30).unref();
server.listen(port, '127.0.0.1', () => {
  log({ event: 'listen', port });
  process.stdout.write('server listening on http://127.0.0.1:' + port + '\\n');
});
`;

const snapshotEnv = () => Object.fromEntries(ISOLATION_KEYS.map((key) => [key, process.env[key]]));
const restoreEnv = (snap) => {
  for (const [key, value] of Object.entries(snap)) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
});
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
const processCommand = (pid) => {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
  return (result.stdout || '').trim();
};

const previousEnv = snapshotEnv();
const realHome = path.resolve(previousEnv.HOME || previousEnv.USERPROFILE || os.homedir());
let isolationRoot = null;
let fixturePath = null;
let logFile = null;
let controlFile = null;
let currentHandle = null;
let activeCount = 0;

const assertFixtureIdentity = (pid) => {
  const command = processCommand(pid);
  if (!fixturePath || !command.includes(fixturePath)) {
    throw new Error('refusing non-fixture process; not signaled');
  }
  return command;
};

const closeOwnedHandle = async (handle) => {
  if (!handle) return;
  if (typeof handle.close === 'function') {
    await Promise.race([handle.close().catch(() => {}), sleep(4000)]);
    return;
  }
  if (typeof handle.kill !== 'function') return;
  if (handle.exitCode != null || handle.signalCode != null) return;
  handle.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    handle.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const readLog = () => {
  try {
    return fsSync.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const spawnCount = () => readLog().filter((entry) => entry.event === 'spawn').length;
const writeControl = (value) => fsSync.writeFileSync(controlFile, JSON.stringify(value));

async function installIsolation() {
  isolationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-lifecycle-recovery-'));
  const home = path.join(isolationRoot, 'home');
  const registry = path.join(isolationRoot, 'registry');
  const workdir = path.join(isolationRoot, 'workdir');
  await Promise.all([home, registry, workdir].map((dir) => fs.mkdir(dir, { recursive: true })));
  fixturePath = path.join(isolationRoot, 'fixture.mjs');
  await fs.writeFile(fixturePath, FIXTURE_SOURCE);
  await fs.chmod(fixturePath, 0o755);
  controlFile = path.join(isolationRoot, 'control.json');
  logFile = path.join(isolationRoot, 'requests.jsonl');
  writeControl({ failStart: false, poisonPid: null, exitNow: null });
  await fs.writeFile(logFile, '');
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = path.join(isolationRoot, 'xdg-data');
  process.env.XDG_CONFIG_HOME = path.join(isolationRoot, 'xdg-config');
  process.env.XDG_CACHE_HOME = path.join(isolationRoot, 'xdg-cache');
  process.env.XDG_STATE_HOME = path.join(isolationRoot, 'xdg-state');
  process.env.OPENCODE_CONFIG_DIR = path.join(isolationRoot, 'opencode-config');
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCHAMBER_DATA_DIR = path.join(isolationRoot, 'data');
  process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
  process.env.OPENCODE_BINARY = fixturePath;
  process.env.OPENCODE_PASSWORD = FAKE_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = FAKE_PASSWORD;
  process.env.FIXTURE_CONTROL_FILE = controlFile;
  process.env.FIXTURE_LOG_FILE = logFile;
  await Promise.all([
    process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME,
    process.env.XDG_STATE_HOME, process.env.OPENCODE_CONFIG_DIR, process.env.OPENCHAMBER_DATA_DIR,
  ].map((dir) => fs.mkdir(dir, { recursive: true })));
  if (path.resolve(process.env.HOME) === realHome) throw new Error('HOME is not isolated');
  return workdir;
}

function createRuntime(workdir, port, extras = {}) {
  const state = {
    openCodeWorkingDirectory: workdir,
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    isOpenCodeReady: false,
    v1Migration: null,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    runtimeContractGeneration: 0,
  };
  const getOpenCodeAuthHeaders = () => ({ Authorization: basicAuth });
  const network = createOpenCodeNetworkRuntime({
    state,
    getOpenCodeAuthHeaders,
    configuredOpenCodeHostname: '127.0.0.1',
  });
  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: extras.configuredPort === undefined ? port : extras.configuredPort,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: extras.effectivePort === undefined ? port : extras.effectivePort,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: () => {},
    syncFromHmrState: () => {},
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl: network.buildOpenCodeUrl,
    waitForReady: network.waitForReady,
    normalizeApiPrefix: network.normalizeApiPrefix,
    applyOpencodeBinaryFromSettings: async () => {
      process.env.OPENCODE_BINARY = fixturePath;
      return fixturePath;
    },
    ensureOpencodeCliEnv: () => fixturePath,
    ensureLocalOpenCodeServerPassword: async () => FAKE_PASSWORD,
    resolveManagedOpenCodeLaunchSpec: (binary) => ({ binary, args: [], wrapperType: null }),
    setOpenCodePort: (next) => { state.openCodePort = next; },
    setDetectedOpenCodeApiPrefix: network.setDetectedOpenCodeApiPrefix,
    setupProxy: () => {},
    ensureOpenCodeApiPrefix: () => {},
    clearResolvedOpenCodeBinary: () => {},
    buildAugmentedPath: () => process.env.PATH,
    buildManagedOpenCodePath: () => process.env.PATH,
    getManagedOpenCodeShellEnvSnapshot: () => ({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FIXTURE_CONTROL_FILE: controlFile,
      FIXTURE_LOG_FILE: logFile,
    }),
    getActiveSessionCount: () => activeCount,
    sharedService: extras.sharedService ?? null,
    managedCapabilitiesRuntime: extras.managedCapabilitiesRuntime ?? null,
  });
  return { state, runtime };
}

async function startOwned(workdir, port) {
  const { state, runtime } = createRuntime(workdir, port);
  const handle = await runtime.startOpenCode();
  if (state.lastOpenCodeLaunchDiagnostics?.binary !== fixturePath) {
    throw new Error('lifecycle launched a non-fixture binary');
  }
  assertFixtureIdentity(handle.pid);
  state.openCodeProcess = handle;
  currentHandle = handle;
  return { state, runtime, handle };
}

describe('lifecycle private recovery e2e', () => {
  afterEach(async () => {
    await closeOwnedHandle(currentHandle);
    currentHandle = null;
    activeCount = 0;
    if (isolationRoot) await fs.rm(isolationRoot, { recursive: true, force: true }).catch(() => {});
    isolationRoot = null;
    restoreEnv(previousEnv);
  });

  it('does not swap a live pid on the first health failure, even when busy', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    activeCount = 1;
    writeControl({ failStart: false, poisonPid: handle.pid, exitNow: null });
    const before = spawnCount();

    await runtime.triggerHealthCheck();

    expect(state.openCodeProcess.pid).toBe(handle.pid);
    expect(isAlive(handle.pid)).toBe(true);
    expect(spawnCount()).toBe(before);
  }, 30_000);

  it('does not swap when the failure threshold is reached while a session is busy', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    activeCount = 1;
    writeControl({ failStart: false, poisonPid: handle.pid, exitNow: null });

    for (let i = 0; i < 20; i += 1) await runtime.triggerHealthCheck();

    expect(state.openCodeProcess.pid).toBe(handle.pid);
    expect(isAlive(handle.pid)).toBe(true);
  }, 30_000);

  it('recovers a signal exit onto a new pid', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    const first = handle.pid;
    process.kill(first, 'SIGTERM');
    for (let i = 0; i < 40 && isAlive(first); i += 1) await sleep(25);
    expect(isAlive(first)).toBe(false);

    await runtime.triggerHealthCheck();
    currentHandle = state.openCodeProcess;
    const second = currentHandle?.pid;
    assertFixtureIdentity(second);
    expect(second).not.toBe(first);
    expect(isAlive(second)).toBe(true);
  }, 30_000);

  it('recovers a normal exit onto a new pid', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    const first = handle.pid;
    writeControl({ failStart: false, poisonPid: null, exitNow: 0 });
    for (let i = 0; i < 40 && isAlive(first); i += 1) await sleep(25);
    expect(isAlive(first)).toBe(false);
    writeControl({ failStart: false, poisonPid: null, exitNow: null });

    await runtime.triggerHealthCheck();
    currentHandle = state.openCodeProcess;
    const second = currentHandle?.pid;
    assertFixtureIdentity(second);
    expect(second).not.toBe(first);
    expect(isAlive(second)).toBe(true);
  }, 30_000);

  it('recovers a lifted spawn failure only after cooldown, and bounds the failure rate', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    writeControl({ failStart: true, poisonPid: null, exitNow: null });
    process.kill(handle.pid, 'SIGKILL');
    for (let i = 0; i < 20 && isAlive(handle.pid); i += 1) await sleep(25);

    await runtime.triggerHealthCheck();
    const failedSpawns = spawnCount();
    expect(state.openCodeProcess).toBeNull();
    expect(String(state.lastOpenCodeError || '')).not.toMatch(/[/\\]/);
    expect(String(state.lastOpenCodeError || '')).not.toContain('stderr');
    currentHandle = null;

    for (let i = 0; i < 8; i += 1) await runtime.triggerHealthCheck();
    expect(spawnCount()).toBe(failedSpawns);
    await expect(runtime.retryOpenCodeStartup()).rejects.toMatchObject({ code: 'opencode_recovery_backoff' });
    expect(spawnCount()).toBe(failedSpawns);

    writeControl({ failStart: false, poisonPid: null, exitNow: null });
    await sleep(5600);
    await runtime.triggerHealthCheck();
    currentHandle = state.openCodeProcess;
    expect(currentHandle?.pid).toBeGreaterThan(0);
    assertFixtureIdentity(currentHandle.pid);
    expect(isAlive(state.openCodeProcess.pid)).toBe(true);
    expect(spawnCount()).toBeGreaterThan(failedSpawns);
  }, 30_000);

  it('does not spawn without private intent, after shutdown, or for external/shared', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const bare = createRuntime(workdir, port);
    await bare.runtime.triggerHealthCheck();
    expect(spawnCount()).toBe(0);

    const { state, runtime, handle } = await startOwned(workdir, port);
    state.isShuttingDown = true;
    process.kill(handle.pid, 'SIGKILL');
    await runtime.triggerHealthCheck();
    state.isShuttingDown = false;
    state.openCodeProcess = null;
    currentHandle = null;
    const afterShutdown = spawnCount();
    await runtime.triggerHealthCheck();
    expect(spawnCount()).toBe(afterShutdown);

    const external = await startOwned(workdir, await freePort());
    external.state.isExternalOpenCode = true;
    writeControl({ failStart: false, poisonPid: external.handle.pid, exitNow: null });
    const externalSpawns = spawnCount();
    await external.runtime.triggerHealthCheck();
    await expect(external.runtime.retryOpenCodeStartup()).rejects.toMatchObject({ code: 'opencode_not_ready' });
    expect(external.state.openCodeProcess.pid).toBe(external.handle.pid);
    expect(isAlive(external.handle.pid)).toBe(true);
    expect(spawnCount()).toBe(externalSpawns);
    await closeOwnedHandle(external.handle);
    currentHandle = null;
  }, 30_000);

  it('does not fall back to a private spawn when the shared service is unhealthy', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { spawn } = await import('node:child_process');
    const live = spawn(process.execPath, [fixturePath, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FIXTURE_CONTROL_FILE: controlFile, FIXTURE_LOG_FILE: logFile, OPENCODE_SERVER_PASSWORD: FAKE_PASSWORD },
    });
    currentHandle = live;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('shared fixture did not listen')), 4000);
      live.stdout.on('data', (chunk) => {
        if (String(chunk).includes('server listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      live.once('exit', () => { clearTimeout(timer); reject(new Error('shared fixture exited')); });
    });
    assertFixtureIdentity(live.pid);
    const before = spawnCount();
    const sharedService = {
      registrationFile: path.join(isolationRoot, 'service.json'),
      buildStartEnv: (env) => env,
      start: async () => {},
      readRegistration: async () => ({
        origin: `http://127.0.0.1:${port}`,
        port,
        pid: live.pid,
        password: FAKE_PASSWORD,
        version: '2.0.23',
      }),
    };
    const { state, runtime } = createRuntime(workdir, port, {
      configuredPort: null,
      effectivePort: null,
      sharedService,
    });
    await runtime.bootstrapOpenCodeAtStartup();
    expect(runtime.isSharedOpenCodeService()).toBe(true);
    writeControl({ failStart: false, poisonPid: live.pid, exitNow: null });
    await runtime.triggerHealthCheck();
    expect(isAlive(live.pid)).toBe(true);
    expect(spawnCount()).toBe(before);
    expect(state.openCodeProcess).toBeNull();
  }, 30_000);

  it('restarts once and finishes when a healthy fixture child has a stale capability identity', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const started = await startOwned(workdir, port);
    const before = spawnCount();
    const runtime = createRuntime(workdir, port, {
      managedCapabilitiesRuntime: {
        hasValidIdentity: () => false,
        prepareManagedChildEnv: async (env) => env,
        recordManagedChildPid: () => {},
        getCapabilityIdentity: () => null,
      },
    });
    runtime.state.openCodeProcess = started.handle;
    runtime.state.openCodePort = port;
    currentHandle = started.handle;
    const outcome = await Promise.race([
      runtime.runtime.bootstrapOpenCodeAtStartup().then(() => 'done'),
      sleep(2500).then(() => 'timeout'),
    ]);
    if (runtime.state.openCodeProcess && runtime.state.openCodeProcess !== started.handle) {
      currentHandle = runtime.state.openCodeProcess;
    }
    expect(outcome).toBe('done');
    expect(spawnCount()).toBe(before + 1);
  }, 20_000);

  it('does not spawn a real child when shutdown lands while prepareManagedChildEnv is pending', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    let releasePrepare;
    const barrier = new Promise((resolve) => { releasePrepare = resolve; });
    let prepared = false;
    const { state, runtime } = createRuntime(workdir, port, {
      managedCapabilitiesRuntime: {
        hasValidIdentity: () => true,
        prepareManagedChildEnv: async (env) => {
          prepared = true;
          await barrier;
          return env;
        },
        recordManagedChildPid: () => {},
        getCapabilityIdentity: () => null,
      },
    });
    const pending = runtime.startOpenCode();
    for (let i = 0; i < 50 && !prepared; i += 1) await sleep(20);
    expect(prepared).toBe(true);
    state.isShuttingDown = true;
    releasePrepare();
    await expect(pending).rejects.toMatchObject({ code: 'opencode_shutting_down' });
    expect(spawnCount()).toBe(0);
    expect(state.openCodeProcess).toBeNull();
  }, 20_000);

  it('does not publish a child when shutdown lands during the first HTTP retry start', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    writeControl({ failStart: false, poisonPid: null, exitNow: null, holdHealth: true });
    const { state, runtime } = createRuntime(workdir, port);
    const { createRequire } = await import('node:module');
    const express = createRequire(import.meta.url)('express');
    const { registerSettingsUtilityRoutes } = await import('./core-routes.js');
    const app = express();
    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk: async () => [],
      refreshOpenCodeAfterConfigChange: async () => ({ reloaded: false, external: false }),
      retryOpenCodeStartup: runtime.retryOpenCodeStartup,
      clientReloadDelayMs: 0,
    });
    const httpServer = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const retryPort = httpServer.address().port;
    const pending = fetch(`http://127.0.0.1:${retryPort}/api/opencode/retry`, { method: 'POST' });
    for (let i = 0; i < 50 && !readLog().some((entry) => entry.event === 'listen'); i += 1) await sleep(40);
    state.isShuttingDown = true;
    writeControl({ failStart: false, poisonPid: null, exitNow: null, holdHealth: false });
    const response = await pending;
    const body = await response.json().catch(() => null);
    await new Promise((resolve) => httpServer.close(resolve));
    expect(response.status).not.toBe(200);
    expect(body?.success).not.toBe(true);
    expect(state.openCodeProcess).toBeNull();
    const listened = readLog().find((entry) => entry.event === 'listen');
    if (listened?.pid) expect(isAlive(listened.pid)).toBe(false);
  }, 20_000);

  it('reports explicit retry as process-ready and does not kill a live process for business 503s', async () => {
    const workdir = await installIsolation();
    const port = await freePort();
    const { state, runtime, handle } = await startOwned(workdir, port);
    const business = await fetch(`http://127.0.0.1:${port}/api/agent`, {
      headers: { Authorization: basicAuth },
    });
    expect(business.status).toBe(503);

    const result = await runtime.retryOpenCodeStartup();

    expect(result).toEqual({ success: true, scope: 'process-ready' });
    expect(state.openCodeProcess.pid).toBe(handle.pid);
    expect(isAlive(handle.pid)).toBe(true);
    expect(state.isOpenCodeReady).toBe(true);
  }, 30_000);
});
