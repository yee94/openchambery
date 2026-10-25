import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliEntryIfMain } from './cli-entry-runtime.js';

describe('cli-entry-runtime', () => {
  const previousRuntime = process.env.YURI_RUNTIME;

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.YURI_RUNTIME;
    else process.env.YURI_RUNTIME = previousRuntime;
  });

  it('forces YURI_RUNTIME=web on the direct node server path even if the parent shell leaked desktop', () => {
    process.env.YURI_RUNTIME = 'desktop';
    const startServer = vi.fn(async () => {});

    runCliEntryIfMain({
      process: { argv: ['node', '/tmp/server/index.js', '--port', '3001'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: () => ({ port: 3001, host: undefined, uiPassword: null, apiOnly: false }),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer,
    });

    expect(process.env.YURI_RUNTIME).toBe('web');
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('preserves YURI_RUNTIME=ssh-remote on the direct node server path', () => {
    process.env.YURI_RUNTIME = 'ssh-remote';
    const startServer = vi.fn(async () => {});

    runCliEntryIfMain({
      process: { argv: ['node', '/tmp/server/index.js', '--port', '3001'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: () => ({ port: 3001, host: undefined, uiPassword: null, apiOnly: false }),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer,
    });

    expect(process.env.YURI_RUNTIME).toBe('ssh-remote');
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite YURI_RUNTIME when imported as a library (Electron in-process)', () => {
    process.env.YURI_RUNTIME = 'desktop';

    runCliEntryIfMain({
      process: { argv: ['electron', '/tmp/electron/main.mjs'], env: process.env, exit: vi.fn() },
      currentFilename: '/tmp/server/index.js',
      parseServeCliOptions: vi.fn(),
      defaultPort: 3001,
      setExitOnShutdown: vi.fn(),
      startServer: vi.fn(),
    });

    expect(process.env.YURI_RUNTIME).toBe('desktop');
  });
});
