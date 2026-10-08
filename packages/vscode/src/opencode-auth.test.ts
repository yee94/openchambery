import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { EventEmitter } from 'node:events';

const fixture = vi.hoisted(() => ({ apiUrl: 'http://127.0.0.1:45678', registration: '', spawn: vi.fn() }));
vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key: string) => key === 'apiUrl' ? fixture.apiUrl : '/fixture/opencode' }) },
  window: { showErrorMessage: vi.fn(async () => undefined), createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
}));
vi.mock('fs', () => ({ readFileSync: () => fixture.registration, statSync: () => ({ isFile: () => true }), accessSync: vi.fn(), mkdirSync: vi.fn(), constants: { X_OK: 1 } }));
vi.mock('child_process', () => ({ spawn: fixture.spawn, spawnSync: vi.fn(), execSync: vi.fn() }));
vi.mock('./opencodeProcessRegistry', () => ({ registerManagedProcess: vi.fn(), unregisterManagedProcess: vi.fn(), reapOrphanedProcesses: async () => ({ reaped: 0 }) }));

import { createOpenCodeManager } from './opencode';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); fixture.spawn.mockReset(); fixture.apiUrl = 'http://127.0.0.1:45678'; });
const context = { globalStorageUri: { fsPath: '/fixture/storage' } } as ExtensionContext;
const headerFor = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

describe('VS Code external auth ownership', () => {
  it('does not leak private auth into a registered service without a password', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'private-fixture');
    fixture.registration = JSON.stringify({ url: fixture.apiUrl, password: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.23', status: 'completed', pid: 42, urls: [], paths: {} }))));
    const manager = createOpenCodeManager(context);
    await manager.start();
    expect(manager.getOpenCodeAuthHeaders()).toEqual({});
    expect(manager.getDebugInfo().authSource).toBe('shared-service');
    await manager.stop();
  });

  it('pins both private child env names to the health/header password across restart', async () => {
    fixture.apiUrl = '';
    fixture.registration = '{}';
    vi.stubEnv('OPENCODE_PASSWORD', 'preferred-fixture');
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'legacy-fixture');
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'opencode');
    vi.stubEnv('OPENCODE_BINARY', '/fixture/opencode');
    vi.stubEnv('PATH', process.env.PATH);
    vi.spyOn(process, 'chdir').mockImplementation(() => {});
    let childPassword = '';
    fixture.spawn.mockImplementation((_binary, _args, options) => {
      childPassword = options.env.OPENCODE_PASSWORD;
      expect(childPassword === options.env.OPENCODE_SERVER_PASSWORD).toBe(true);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 12345, kill: vi.fn() });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:45678\n')));
      return child;
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify(String(_url).includes('migration') ? { status: 'completed' } : { version: '2.0.23', pid: 42, urls: [], paths: {} }), { status: init.headers.Authorization === headerFor(childPassword) ? 200 : 401 })));
    const manager = createOpenCodeManager(context);
    await manager.start();
    expect(manager.getStatus()).toBe('connected');
    expect(childPassword === 'preferred-fixture').toBe(true);
    await manager.restart();
    expect(manager.getStatus()).toBe('connected');
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('attaches using registered service auth, re-reads on restart, and never owns its process', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'private-fixture');
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'legacy-fixture');
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'private-user');
    let password = 'registered-fixture';
    fixture.registration = JSON.stringify({ url: fixture.apiUrl, password });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const authenticated = init.headers.Authorization === headerFor(password);
      return new Response(JSON.stringify(String(_url).includes('migration') ? { status: 'completed' } : { version: '2.0.23', pid: 42, urls: [], paths: {} }), { status: authenticated ? 200 : 401 });
    }));
    const manager = createOpenCodeManager(context);
    await manager.start();
    expect(manager.getStatus()).toBe('connected');
    expect(manager.getOpenCodeAuthHeaders().Authorization === headerFor(password)).toBe(true);
    password = 'rotated-registration-fixture';
    fixture.registration = JSON.stringify({ url: fixture.apiUrl, password });
    await manager.restart();
    expect(manager.getStatus()).toBe('connected');
    expect(manager.getOpenCodeAuthHeaders().Authorization === headerFor(password)).toBe(true);
    await manager.stop();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('never sends registered credentials to a different origin and prefers explicit v2 env', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'explicit-fixture');
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'legacy-fixture');
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'opencode');
    fixture.registration = JSON.stringify({ url: 'http://127.0.0.1:45679', password: 'registered-fixture' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.23', status: 'completed', pid: 42, urls: [], paths: {} }))));
    const manager = createOpenCodeManager(context);
    await manager.start();
    expect(manager.getOpenCodeAuthHeaders().Authorization === headerFor('explicit-fixture')).toBe(true);
    expect(manager.getStatus()).toBe('connected');
    await manager.stop();
  });

  it('keeps a rejected external connection unavailable without launching a private fallback', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENCODE_PASSWORD', 'wrong-fixture');
    fixture.registration = '{}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const manager = createOpenCodeManager(context);
    const start = manager.start();
    await vi.runAllTimersAsync();
    await start;
    expect(manager.getStatus()).toBe('error');
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});
