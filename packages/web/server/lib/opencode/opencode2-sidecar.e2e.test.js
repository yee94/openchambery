import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { readOpenCode2BinaryVersion } from './ensure-cli.js';
import { createOpenCodeEnvRuntime } from './env-runtime.js';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { createOpenCodeNetworkRuntime } from './network-runtime.js';
import {
  evaluateOpenCodeHealthBody,
  isAcceptableOpenCode2HealthVersion,
  isOpenCode1xVersion,
} from './opencode2-pin.js';
import { fetchV1MigrationGate } from './v1-migration-gate.js';

const E2E_PASSWORD = 'openchamber-opencode2-e2e';
const basicAuth = `Basic ${Buffer.from(`opencode:${E2E_PASSWORD}`, 'utf8').toString('base64')}`;
const OPENCODE2_HEALTH_VERSION = /^(?:v)?(?:0\.0\.0-(?:next|beta)(?:-\d+)?|2(?:\.\d+)*)/i;
const OPENCODE_1X_VERSION = /^v?1(?:\.|$)/;

/** Env keys that must not leak into the real user OpenCode install during e2e. */
const ISOLATION_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCHAMBER_DATA_DIR',
  'OPENCHAMBER_MANAGED_PROCESS_REGISTRY',
];

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

const jsonGet = async (url, pathname) => {
  const response = await fetch(`${url.replace(/\/+$/, '')}${pathname}`, {
    headers: {
      Accept: 'application/json',
      Authorization: basicAuth,
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const jsonPost = async (url, pathname, payload) => {
  const response = await fetch(`${url.replace(/\/+$/, '')}${pathname}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: basicAuth,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const snapshotEnv = (keys) => {
  /** @type {Record<string, string | undefined>} */
  const snap = {};
  for (const key of keys) snap[key] = process.env[key];
  return snap;
};

const restoreEnv = (snap) => {
  for (const [key, value] of Object.entries(snap)) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
};

/**
 * Point HOME + XDG + OpenChamber data at a fresh temp tree so managed opencode2
 * never reads/writes the developer's real ~/.config/opencode or
 * ~/.local/share/opencode (migration/auth/session DB).
 * Does not seed from the user install — empty isolation only.
 */
const installIsolatedOpenCodeHome = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-opencode2-e2e-'));
  const home = path.join(root, 'home');
  const xdgData = path.join(root, 'xdg-data');
  const xdgConfig = path.join(root, 'xdg-config');
  const xdgCache = path.join(root, 'xdg-cache');
  const xdgState = path.join(root, 'xdg-state');
  const openchamberData = path.join(root, 'openchamber-data');
  const opencodeConfig = path.join(xdgConfig, 'opencode');
  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(xdgData, { recursive: true }),
    fs.mkdir(xdgConfig, { recursive: true }),
    fs.mkdir(xdgCache, { recursive: true }),
    fs.mkdir(xdgState, { recursive: true }),
    fs.mkdir(openchamberData, { recursive: true }),
    fs.mkdir(opencodeConfig, { recursive: true }),
  ]);

  process.env.HOME = home;
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  process.env.XDG_DATA_HOME = xdgData;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_CACHE_HOME = xdgCache;
  process.env.XDG_STATE_HOME = xdgState;
  process.env.OPENCODE_CONFIG_DIR = opencodeConfig;
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCHAMBER_DATA_DIR = openchamberData;
  process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(openchamberData, 'managed-opencode');

  return root;
};

describe('opencode2 sidecar e2e', () => {
  let server = null;
  let isolationRoot = null;
  const previousBinary = process.env.OPENCODE_BINARY;
  const previousPassword = process.env.OPENCODE_PASSWORD;
  const previousIsolation = snapshotEnv(ISOLATION_ENV_KEYS);
  // Captured at suite load (before installIsolatedOpenCodeHome mutates HOME).
  const realUserHome = path.resolve(
    previousIsolation.HOME
    || previousIsolation.USERPROFILE
    || os.homedir(),
  );

  afterEach(async () => {
    if (server?.close) {
      await server.close().catch(() => {});
      server = null;
    }
    if (typeof previousBinary === 'string') {
      process.env.OPENCODE_BINARY = previousBinary;
    } else {
      delete process.env.OPENCODE_BINARY;
    }
    if (typeof previousPassword === 'string') {
      process.env.OPENCODE_PASSWORD = previousPassword;
    } else {
      delete process.env.OPENCODE_PASSWORD;
    }
    restoreEnv(previousIsolation);
    if (isolationRoot) {
      await fs.rm(isolationRoot, { recursive: true, force: true }).catch(() => {});
      isolationRoot = null;
    }
  });

  it('starts managed opencode2 and serves health, migration, session, and message projection', async () => {
    // Resolve the v2 binary against the real machine first (PATH + home fallbacks).
    // Isolation mutates HOME/XDG and would hide ~/.bun/bin and similar fallbacks.
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_BIN;

    const envRuntime = createOpenCodeEnvRuntime({
      state: {
        cachedLoginShellEnvSnapshot: null,
        resolvedOpencodeBinary: null,
        resolvedOpencodeBinarySource: null,
        useWslForOpencode: false,
        resolvedWslBinary: null,
        resolvedWslOpencodePath: null,
        resolvedWslDistro: null,
        resolvedNodeBinary: null,
        resolvedBunBinary: null,
        managedOpenCodeShellEnvSnapshot: null,
      },
      normalizeDirectoryPath: (value) => value,
      readSettingsFromDiskMigrated: async () => ({}),
    });

    const resolved = envRuntime.resolveOpencodeCliPath();
    expect(resolved).toBeTruthy();
    // Official v2 may install as `opencode` or legacy alias `opencode2`.
    // Contract is version admission, not basename.
    const binaryVersion = readOpenCode2BinaryVersion(resolved);
    expect(isAcceptableOpenCode2HealthVersion(binaryVersion)).toBe(true);
    expect(isOpenCode1xVersion(binaryVersion)).toBe(false);

    // Isolate HOME/XDG/OpenChamber data BEFORE spawn so migration/auth never
    // touch the developer's real OpenCode store. Absolute OPENCODE_BINARY keeps
    // the resolved CLI after HOME changes.
    isolationRoot = await installIsolatedOpenCodeHome();

    process.env.OPENCODE_BINARY = resolved;
    process.env.OPENCODE_PASSWORD = E2E_PASSWORD;

    const port = await freePort();
    const state = {
      openCodeWorkingDirectory: process.cwd(),
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
      resolvedWslBinary: null,
      resolvedWslOpencodePath: null,
      resolvedWslDistro: null,
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
        ENV_CONFIGURED_OPENCODE_PORT: port,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: port,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
      syncToHmrState: () => {},
      syncFromHmrState: () => {},
      getOpenCodeAuthHeaders,
      buildOpenCodeUrl: (route) => `http://127.0.0.1:${state.openCodePort || port}${route}`,
      waitForReady: network.waitForReady,
      normalizeApiPrefix: network.normalizeApiPrefix,
      applyOpencodeBinaryFromSettings: async () => resolved,
      ensureOpencodeCliEnv: () => {},
      ensureLocalOpenCodeServerPassword: async () => E2E_PASSWORD,
      resolveManagedOpenCodeLaunchSpec: envRuntime.resolveManagedOpenCodeLaunchSpec,
      setOpenCodePort: (nextPort) => {
        state.openCodePort = nextPort;
      },
      setDetectedOpenCodeApiPrefix: network.setDetectedOpenCodeApiPrefix,
      setupProxy: () => {},
      ensureOpenCodeApiPrefix: () => {},
      clearResolvedOpenCodeBinary: envRuntime.clearResolvedOpenCodeBinary,
      buildAugmentedPath: () => process.env.PATH,
      buildManagedOpenCodePath: () => process.env.PATH,
      getManagedOpenCodeShellEnvSnapshot: () => ({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        OPENCHAMBER_DATA_DIR: process.env.OPENCHAMBER_DATA_DIR,
        OPENCHAMBER_MANAGED_PROCESS_REGISTRY: process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY,
        OPENCODE_PASSWORD: E2E_PASSWORD,
        OPENCODE_SERVER_PASSWORD: E2E_PASSWORD,
      }),
    });

    server = await runtime.startOpenCode();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const launchedBinary = String(state.lastOpenCodeLaunchDiagnostics?.binary || '');
    expect(launchedBinary.length).toBeGreaterThan(0);
    // Launch path must still resolve to the same admitted v2 binary (name may be opencode).
    expect(isAcceptableOpenCode2HealthVersion(readOpenCode2BinaryVersion(launchedBinary))).toBe(true);

    const health = await jsonGet(server.url, '/api/info');
    expect(health.status).toBe(200);
    const healthGate = evaluateOpenCodeHealthBody(health.body);
    expect(healthGate.ok).toBe(true);
    expect(healthGate.version).toMatch(OPENCODE2_HEALTH_VERSION);
    expect(String(health.body?.version ?? '')).not.toMatch(OPENCODE_1X_VERSION);
    expect(health.body).toMatchObject({
      version: expect.stringMatching(OPENCODE2_HEALTH_VERSION),
    });

    const unauthenticated = await fetch(`${server.url}/api/info`);
    expect(unauthenticated.status).toBe(401);

    const gate = await fetchV1MigrationGate({
      url: `${server.url}/api/experimental/migration/v1`,
      headers: getOpenCodeAuthHeaders(),
    });
    expect(gate.admitTranscript).toBe(true);
    expect(['completed', 'absent']).toContain(gate.phase);

    // Safety: isolation root must stay under tmp and never equal real user home.
    expect(isolationRoot.startsWith(os.tmpdir())).toBe(true);
    expect(path.resolve(process.env.HOME)).not.toBe(path.resolve(realUserHome));
    // Real user OpenCode paths must remain untouched (no accidental migration write).
    const realConfigMarker = path.join(realUserHome, '.config', 'opencode');
    const isolatedConfig = process.env.OPENCODE_CONFIG_DIR;
    expect(path.resolve(isolatedConfig)).not.toBe(path.resolve(realConfigMarker));

    const created = await jsonPost(server.url, '/api/session', {});
    expect(created.status).toBe(200);
    const sessionID = created.body?.data?.id ?? created.body?.id;
    expect(sessionID).toMatch(/^ses_/);

    const messages = await jsonGet(
      server.url,
      `/api/session/${encodeURIComponent(sessionID)}/message?limit=20&order=desc`,
    );
    expect(messages.status).toBe(200);
    const page = messages.body?.data ?? messages.body;
    expect(Array.isArray(page)).toBe(true);
  }, 60_000);
});
