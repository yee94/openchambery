import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');
const { createOpenCodeNetworkRuntime } = await import('./network-runtime.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createRuntime = (overrides = {}, stateRef = null) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
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

  if (stateRef) {
    stateRef.current = state;
  }

  return createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const DEFAULT_V2_HEALTH = { version: '2.0.12', pid: 1, urls: [], paths: { tmp: '/tmp' } };

const stubOpenCodeFetch = (overrides = {}) => {
  const fetchMock = vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes('/api/experimental/migration/v1')) {
      const migration = overrides.migration;
      if (typeof migration === 'function') {
        return migration(url, init);
      }
      if (migration && typeof migration === 'object' && Number.isInteger(migration.httpStatus)) {
        return jsonResponse(migration.body ?? {}, migration.httpStatus);
      }
      return jsonResponse(migration ?? { status: 'completed' });
    }
    if (href.includes('/api/info') || href.includes('/global/health')) {
      if (overrides.reuseDefaultServe !== true && href.includes(':4096/')) {
        return new Response('not found', { status: 404 });
      }
      const health = overrides.health;
      if (typeof health === 'function') {
        return health(url, init);
      }
      return jsonResponse(health ?? DEFAULT_V2_HEALTH);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const startListeningChild = () => {
  const child = createMockChild();
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
    });
    return child;
  });
  return child;
};

describe('OpenCode lifecycle', () => {
  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('allows a polite SIGTERM close that finishes after 400ms without escalating early', async () => {
    vi.useFakeTimers();
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGTERM') {
        // Slow-but-healthy flush: exits after 800ms (>400ms), still under 2500ms grace.
        setTimeout(() => {
          child.signalCode = 'SIGTERM';
          child.emit('close', null, 'SIGTERM');
        }, 800);
      }
      return true;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    stubOpenCodeFetch();

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const closePromise = server.close();

    await vi.advanceTimersByTimeAsync(400);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(400);
    await closePromise;
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('escalates a hung managed child to SIGKILL only after the full 2500ms SIGTERM grace', async () => {
    vi.useFakeTimers();
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGKILL') {
        child.signalCode = 'SIGKILL';
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      }
      return true;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    stubOpenCodeFetch();

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const closePromise = server.close();

    await vi.advanceTimersByTimeAsync(2499);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    await closePromise;
    vi.useRealTimers();
  });

  it('killProcessOnPort only signals the owned pid and never mass-kills by port', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    stubOpenCodeFetch();

    const runtime = createRuntime();
    await runtime.startOpenCode();
    killSpy.mockClear();

    runtime.killProcessOnPort(45678);
    expect(killSpy).not.toHaveBeenCalled();

    runtime.killProcessOnPort(45678, 4242);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(killSpy.mock.calls.every(([target]) => target === -4242 || target === 4242)).toBe(true);

    killSpy.mockRestore();
  });

  it('parses a v2 server listening line without the opencode prefix', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(server.url).toBe('http://127.0.0.1:45678');

    await server.close();
  });

  it('probes /api/info with Basic auth after the managed server is listening', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/info')) {
        return new Response(JSON.stringify(DEFAULT_V2_HEALTH), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/api/experimental/migration/v1')) {
        return new Response(JSON.stringify({ status: 'completed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const authHeaders = { Authorization: 'Basic Zml4dHVyZQ==' };
    const network = createOpenCodeNetworkRuntime({
      state: {
        openCodePort: 45678,
        openCodeBaseUrl: null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: false,
        openCodeApiDetectionTimer: null,
      },
      getOpenCodeAuthHeaders: () => authHeaders,
    });
    const runtime = createRuntime({
      getOpenCodeAuthHeaders: () => authHeaders,
      waitForReady: network.waitForReady,
    });
    const server = await runtime.startOpenCode();
    const healthCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/info'));

    expect(healthCall).toBeDefined();
    expect(String(healthCall[0])).toContain('/api/info');
    expect(healthCall[1].headers.Authorization).toMatch(/^Basic /);

    await server.close();
  });

  it('prepares a fresh managed capability environment and records the spawned child pid', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const managedCapabilitiesRuntime = {
      prepareManagedChildEnv: vi.fn(async (env) => ({ ...env, OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN: 'rotated' })),
      recordManagedChildPid: vi.fn(),
      getCapabilityIdentity: vi.fn(() => ({ version: '1', origin: 'http://127.0.0.1:3000', token: 'a'.repeat(64), childPid: 12345 })),
    };
    const server = await createRuntime({ managedCapabilitiesRuntime }).startOpenCode();
    expect(managedCapabilitiesRuntime.prepareManagedChildEnv).toHaveBeenCalledTimes(1);
    expect(managedCapabilitiesRuntime.recordManagedChildPid).toHaveBeenCalledWith(12345);
    expect(spawnMock.mock.calls[0][2].env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN).toBe('rotated');
    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('terminates each managed child when its startup output cannot be parsed', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening without a url\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening without a url\n');
      });
      return secondChild;
    });

    await expect(createRuntime().startOpenCode()).rejects.toThrow('Failed to parse server url from output');

    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('prefers configured external OpenCode over an HMR managed child', async () => {
    const stateRef = {};
    const managedChild = { close: vi.fn(async () => {}) };
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://127.0.0.1:3001' },
        ENV_EFFECTIVE_PORT: 3001,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      syncFromHmrState: vi.fn(),
    }, stateRef);
    stateRef.current.openCodeProcess = managedChild;
    stateRef.current.openCodePort = 45678;
    stateRef.current.isExternalOpenCode = false;
    stubOpenCodeFetch();
    await runtime.bootstrapOpenCodeAtStartup();
    expect(managedChild.close).toHaveBeenCalledTimes(1);
    expect(stateRef.current.openCodeProcess).toBeNull();
    expect(stateRef.current.isExternalOpenCode).toBe(true);
    expect(stateRef.current.openCodePort).toBe(3001);
  });

  it('clears restored external ownership before starting a managed child', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    const stateRef = {};
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
    }, stateRef);
    stateRef.current.isExternalOpenCode = true;
    stateRef.current.openCodeBaseUrl = 'http://127.0.0.1:3001';
    stubOpenCodeFetch();

    await runtime.bootstrapOpenCodeAtStartup();

    expect(stateRef.current.isExternalOpenCode).toBe(false);
    expect(stateRef.current.openCodeBaseUrl).toBeNull();
    expect(stateRef.current.openCodeProcess?.pid).toBe(12345);
    await stateRef.current.openCodeProcess.close();
  });

  it('re-resolves and starts OpenCode after the initial bootstrap failed', async () => {
    delete process.env.OPENCODE_BINARY;
    let installed = false;
    const missingBinaryError = Object.assign(new Error('OpenCode CLI is missing'), {
      code: 'OPENCODE_BINARY_INVALID',
    });
    const applyOpencodeBinaryFromSettings = vi.fn(async (options = {}) => {
      if (options.strict === true && !installed) {
        throw missingBinaryError;
      }
      return null;
    });
    const ensureOpencodeCliEnv = vi.fn(() => {
      if (!installed) return null;
      process.env.OPENCODE_BINARY = '/mock/opencode';
      return process.env.OPENCODE_BINARY;
    });
    const clearResolvedOpenCodeBinary = vi.fn();
    const child = createMockChild();
    const stateRef = {};
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
      applyOpencodeBinaryFromSettings,
      ensureOpencodeCliEnv,
      clearResolvedOpenCodeBinary,
    }, stateRef);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubOpenCodeFetch();

    await runtime.bootstrapOpenCodeAtStartup();
    expect(spawnMock).not.toHaveBeenCalled();

    installed = true;
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    stubOpenCodeFetch();

    try {
      await runtime.retryOpenCodeStartup();
      expect(clearResolvedOpenCodeBinary).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toBe('/mock/opencode');
    } finally {
      errorLog.mockRestore();
      await stateRef.current.openCodeProcess?.close();
    }
  });

  it('does not mark OpenCode ready for messages while V1 migration is required', async () => {
    delete process.env.OPENCODE_BINARY;
    startListeningChild();
    const stateRef = {};
    stubOpenCodeFetch({ migration: { status: 'required' } });
    const runtime = createRuntime({}, stateRef);

    const server = await runtime.startOpenCode();

    expect(stateRef.current.isOpenCodeReady).toBe(false);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: false,
      phase: 'required',
    });

    await server.close();
  });

  it('keeps the ready gate closed while waitForOpenCodeReady sees required migration', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stubOpenCodeFetch({
      migration: { status: 'required' },
    });

    await expect(runtime.waitForOpenCodeReady(250, 40)).rejects.toThrow(/V1 migration is required/);
    expect(stateRef.current.isOpenCodeReady).toBe(false);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: false,
      phase: 'required',
    });
  });

  it('marks OpenCode ready for messages after V1 migration completed', async () => {
    delete process.env.OPENCODE_BINARY;
    startListeningChild();
    const stateRef = {};
    stubOpenCodeFetch({ migration: { status: 'completed' } });
    const runtime = createRuntime({}, stateRef);

    const server = await runtime.startOpenCode();

    expect(stateRef.current.isOpenCodeReady).toBe(true);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: true,
      phase: 'completed',
    });

    await server.close();
  });

  it('admits messages when V1 migration is absent', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stubOpenCodeFetch({
      migration: { httpStatus: 404, body: {} },
    });

    await runtime.waitForOpenCodeReady(1000, 40);

    expect(stateRef.current.isOpenCodeReady).toBe(true);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: true,
      phase: 'absent',
    });
  });

  it('retries V1 migration error and still blocks messages until completed', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    let migrationCalls = 0;
    const fetchMock = stubOpenCodeFetch({
      migration: () => {
        migrationCalls += 1;
        if (migrationCalls === 1) {
          return jsonResponse({ status: 'error', error: 'locked' });
        }
        return jsonResponse({ status: 'completed' });
      },
    });

    await runtime.waitForOpenCodeReady(2000, 40);

    expect(migrationCalls).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/experimental/migration/v1'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !call[1] || call[1].method !== 'POST')).toBe(true);
    expect(stateRef.current.isOpenCodeReady).toBe(true);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: true,
      phase: 'completed',
    });
  });

  it('publishes v1Migration on lifecycle state for health snapshot', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stubOpenCodeFetch({
      migration: {
        status: 'running',
        progress: { label: 'Sessions', numerator: 2, denominator: 8 },
      },
    });

    await expect(runtime.waitForOpenCodeReady(200, 40)).rejects.toThrow(/V1 migration is running/);
    expect(stateRef.current.isOpenCodeReady).toBe(false);
    expect(stateRef.current.v1Migration).toMatchObject({
      admitTranscript: false,
      phase: 'running',
      progress: { label: 'Sessions', numerator: 2, denominator: 8 },
    });
    expect(stateRef.current.v1Migration.userNotice).toContain('V1 subtasks do not appear in v2');
  });

  it('clears v1Migration when an external OpenCode restart probe fails', async () => {
    const stateRef = {};
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
    }, stateRef);
    stateRef.current.isExternalOpenCode = true;
    stateRef.current.openCodePort = 45678;
    stateRef.current.openCodeBaseUrl = 'http://127.0.0.1:45678';
    stateRef.current.v1Migration = { admitTranscript: true, phase: 'completed' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ healthy: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(runtime.restartOpenCode()).rejects.toThrow('External OpenCode server on port 45678 is not responding');
    expect(stateRef.current.isOpenCodeReady).toBe(false);
    expect(stateRef.current.v1Migration).toBeNull();
    // Read-only external mount: failed re-probe keeps port + ownership; never spawn.
    expect(stateRef.current.openCodePort).toBe(45678);
    expect(stateRef.current.isExternalOpenCode).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects healthy 1.x health bodies instead of admitting the process', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stubOpenCodeFetch({ health: { healthy: true, version: '1.15.0' } });

    await expect(runtime.waitForOpenCodeReady(300, 40)).rejects.toThrow(/unhealthy|Timed out|1\.|version/i);
    expect(stateRef.current.isOpenCodeReady).toBe(false);
  });

  it('rejects healthy responses with a missing version', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stubOpenCodeFetch({ health: { healthy: true } });

    await expect(runtime.waitForOpenCodeReady(300, 40)).rejects.toThrow();
    expect(stateRef.current.isOpenCodeReady).toBe(false);
  });

  it('health version + migration matrix: v2+completed admits, v2+running blocks, 1.x blocks', async () => {
    const cases = [
      { health: DEFAULT_V2_HEALTH, migration: { status: 'completed' }, admit: true },
      { health: DEFAULT_V2_HEALTH, migration: { status: 'running' }, admit: false },
      { health: DEFAULT_V2_HEALTH, migration: { status: 'required' }, admit: false },
      { health: DEFAULT_V2_HEALTH, migration: { status: 'error', error: 'disk' }, admit: false },
      { health: { healthy: true, version: '1.18.18' }, migration: { status: 'completed' }, admit: false },
    ];

    for (const entry of cases) {
      const stateRef = {};
      const runtime = createRuntime({}, stateRef);
      stateRef.current.openCodePort = 45678;
      stubOpenCodeFetch({ health: entry.health, migration: entry.migration });
      if (entry.admit) {
        await runtime.waitForOpenCodeReady(1000, 40);
        expect(stateRef.current.isOpenCodeReady).toBe(true);
      } else {
        await expect(runtime.waitForOpenCodeReady(250, 40)).rejects.toThrow();
        expect(stateRef.current.isOpenCodeReady).toBe(false);
      }
    }
  });

  it('aborts a hung migration probe with the same per-attempt signal after health', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    let migrationStarted = 0;
    let sawAbort = false;
    stubOpenCodeFetch({
      health: DEFAULT_V2_HEALTH,
      migration: (_url, init) => {
        migrationStarted += 1;
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('migration probe missing abort signal'));
            return;
          }
          if (signal.aborted) {
            sawAbort = true;
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });

    // Default per-attempt health timeout is 5s; outer deadline must exceed it once
    // so the hung migration is aborted by the attempt timer, not only the loop exit.
    const started = Date.now();
    await expect(runtime.waitForOpenCodeReady(6500, 50)).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(migrationStarted).toBeGreaterThan(0);
    expect(sawAbort).toBe(true);
    expect(elapsed).toBeLessThan(12_000);
    expect(stateRef.current.isOpenCodeReady).toBe(false);
  }, 15_000);

  it('revokes execution permit on restart and ignores stale async health for a new generation', async () => {
    const stateRef = {};
    const runtime = createRuntime({}, stateRef);
    stateRef.current.openCodePort = 45678;
    stateRef.current.runtimeContractGeneration = 1;
    stateRef.current.runtimeContract = {
      executionAllowed: true,
      phase: 'ready',
      serveVersion: '2.0.12',
      instanceGeneration: 1,
    };

    const genBefore = runtime.revokeRuntimeExecutionPermit('test-restart');
    expect(genBefore).toBe(2);
    expect(stateRef.current.runtimeContract.executionAllowed).toBe(false);
    expect(stateRef.current.runtimeContract.phase).toBe('pending');
    expect(stateRef.current.runtimeContract.instanceGeneration).toBe(2);

    // Stale probe from generation 1 must not re-open execution on generation 2.
    runtime.refreshRuntimeContractFromProbe(
      {
        ok: true,
        version: '2.0.12',
        authenticated: true,
        healthOk: true,
      },
      { admitTranscript: true, phase: 'done', error: null },
      1,
    );
    expect(stateRef.current.runtimeContract.executionAllowed).toBe(false);
    expect(stateRef.current.runtimeContract.instanceGeneration).toBe(2);

    // Matching generation publishes verified permit.
    runtime.refreshRuntimeContractFromProbe(
      {
        ok: true,
        version: '2.0.12',
        authenticated: true,
        healthOk: true,
      },
      { admitTranscript: true, phase: 'done', error: null },
      2,
    );
    expect(stateRef.current.runtimeContract.executionAllowed).toBe(true);
    expect(stateRef.current.runtimeContract.instanceGeneration).toBe(2);
    expect(stateRef.current.runtimeContract.serveVersion).toBe('2.0.12');
  });

  it('does not mark external skip-start ready before version and migration admit', async () => {
    const stateRef = {};
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://127.0.0.1:3001' },
        ENV_EFFECTIVE_PORT: 3001,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      syncFromHmrState: vi.fn(),
    }, stateRef);
    // Reject health so bootstrap's waitForOpenCodeReady fails quickly without a
    // 20s migration spin, while still proving skip-start never pre-admits ready.
    stubOpenCodeFetch({ health: { healthy: true, version: '1.15.0' } });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(stateRef.current.isExternalOpenCode).toBe(true);
    expect(stateRef.current.isOpenCodeReady).toBe(false);
    expect(stateRef.current.openCodePort).toBe(3001);
  }, 25_000);
});
