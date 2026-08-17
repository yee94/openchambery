import { afterEach, describe, expect, it } from 'bun:test';
import net from 'node:net';
import path from 'node:path';

import { createOpenCodeEnvRuntime } from './env-runtime.js';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { createOpenCodeNetworkRuntime } from './network-runtime.js';
import { fetchV1MigrationGate } from './v1-migration-gate.js';

const E2E_PASSWORD = 'openchamber-opencode2-e2e';
const basicAuth = `Basic ${Buffer.from(`opencode:${E2E_PASSWORD}`, 'utf8').toString('base64')}`;
const OPENCODE2_HEALTH_VERSION = /^(?:v)?(?:0\.0\.0-(?:next|beta)(?:-\d+)?|2(?:\.\d+)*)/i;
const OPENCODE_1X_VERSION = /^v?1(?:\.|$)/;

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

describe('opencode2 sidecar e2e', () => {
  let server = null;
  const previousBinary = process.env.OPENCODE_BINARY;
  const previousPassword = process.env.OPENCODE_PASSWORD;

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
  });

  it('starts managed opencode2 and serves health, migration, session, and message projection', async () => {
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
    expect(path.basename(resolved).replace(/\.exe$/i, '')).toBe('opencode2');

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
        OPENCODE_PASSWORD: E2E_PASSWORD,
        OPENCODE_SERVER_PASSWORD: E2E_PASSWORD,
      }),
    });

    server = await runtime.startOpenCode();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(String(state.lastOpenCodeLaunchDiagnostics?.binary || '')).toContain('opencode2');

    const health = await jsonGet(server.url, '/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      healthy: true,
      version: expect.stringMatching(OPENCODE2_HEALTH_VERSION),
    });
    expect(String(health.body?.version ?? '')).not.toMatch(OPENCODE_1X_VERSION);

    const unauthenticated = await fetch(`${server.url}/api/health`);
    expect(unauthenticated.status).toBe(401);

    const gate = await fetchV1MigrationGate({
      url: `${server.url}/api/experimental/migration/v1`,
      headers: getOpenCodeAuthHeaders(),
    });
    expect(gate.admitTranscript).toBe(true);
    expect(['completed', 'absent']).toContain(gate.phase);

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
