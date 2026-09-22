import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, shutdownTimeoutMs = 1000, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
      closeAllConnections: vi.fn(),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('force closes remaining HTTP connections after initiating server close', async () => {
    vi.useFakeTimers();
    let closeCallback;
    const server = {
      close: vi.fn((callback) => {
        closeCallback = callback;
      }),
      closeAllConnections: vi.fn(() => {
        closeCallback();
      }),
    };

    const runtime = createRuntime(server, 10000);
    await runtime.gracefulShutdown({ exitProcess: false, forceCloseConnections: true });

    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(server.close.mock.invocationCallOrder[0]).toBeLessThan(server.closeAllConnections.mock.invocationCallOrder[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops scheduled tasks runtime without closing the process-lifetime run history store', async () => {
    const scheduledTasksRuntime = { stop: vi.fn() };
    const runHistoryStore = { close: vi.fn() };
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server, 1000, {
      scheduledTasksRuntime,
      runHistoryStore,
    });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(scheduledTasksRuntime.stop).toHaveBeenCalledOnce();
    expect(runHistoryStore.close).not.toHaveBeenCalled();
  });

  it('awaits managed OpenCode close with zero extra kill, then probes port release for 5s', async () => {
    const close = vi.fn(async () => undefined);
    const waitForPortRelease = vi.fn(async (_port, timeoutMs) => {
      expect(timeoutMs).toBe(5000);
      return true;
    });
    const setOpenCodeProcess = vi.fn();
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server, 1000, {
      shouldSkipOpenCodeStop: () => false,
      getOpenCodePort: () => 45678,
      getOpenCodeProcess: () => ({ close, pid: 99 }),
      setOpenCodeProcess,
      waitForPortRelease,
    });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(close).toHaveBeenCalledOnce();
    expect(setOpenCodeProcess).toHaveBeenCalledWith(null);
    expect(waitForPortRelease).toHaveBeenCalledWith(45678, 5000);
  });

  it('does not kill anything when OpenCode close already finished and a later server stage fails', async () => {
    const close = vi.fn(async () => undefined);
    const waitForPortRelease = vi.fn(async () => true);
    const server = {
      close: vi.fn(() => {
        throw new Error('server close blew up after opencode stop');
      }),
    };

    const runtime = createRuntime(server, 1000, {
      shouldSkipOpenCodeStop: () => false,
      getOpenCodePort: () => 45678,
      getOpenCodeProcess: () => ({ close, pid: 99 }),
      setOpenCodeProcess: vi.fn(),
      waitForPortRelease,
    });

    await expect(runtime.gracefulShutdown({ exitProcess: false })).rejects.toThrow(/server close blew up/);
    expect(close).toHaveBeenCalledOnce();
    expect(waitForPortRelease).toHaveBeenCalledWith(45678, 5000);
  });
});
