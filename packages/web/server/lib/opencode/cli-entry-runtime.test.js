import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliEntryIfMain } from './cli-entry-runtime.js';

describe('cli-entry-runtime', () => {
  const previousRuntime = process.env.OPENCHAMBER_RUNTIME;

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.OPENCHAMBER_RUNTIME;
    else process.env.OPENCHAMBER_RUNTIME = previousRuntime;
  });

  it('forces OPENCHAMBER_RUNTIME=web on the direct node server path even if the parent shell leaked desktop', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    const startServer = vi.fn(async () => {});

    runCliEntryIfMain({
      process: { argv: ['node', '/tmp/server/index.js', '--port', '3001'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: () => ({ port: 3001, host: undefined, uiPassword: null, apiOnly: false }),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer,
    });

    expect(process.env.OPENCHAMBER_RUNTIME).toBe('web');
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('preserves OPENCHAMBER_RUNTIME=ssh-remote on the direct node server path', () => {
    process.env.OPENCHAMBER_RUNTIME = 'ssh-remote';
    const startServer = vi.fn(async () => {});

    runCliEntryIfMain({
      process: { argv: ['node', '/tmp/server/index.js', '--port', '3001'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: () => ({ port: 3001, host: undefined, uiPassword: null, apiOnly: false }),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer,
    });

    expect(process.env.OPENCHAMBER_RUNTIME).toBe('ssh-remote');
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite OPENCHAMBER_RUNTIME when imported as a library (Electron in-process)', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';

    runCliEntryIfMain({
      process: { argv: ['electron', '/tmp/electron/main.mjs'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: vi.fn(),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer: vi.fn(),
    });

    expect(process.env.OPENCHAMBER_RUNTIME).toBe('desktop');
  });
});
