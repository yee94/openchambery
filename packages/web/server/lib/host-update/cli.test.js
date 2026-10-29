import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { createCliUpdateAdapter } from './cli.js';

const fixture = vi.hoisted(() => ({ fork: vi.fn(), inspect: vi.fn(), reject: false, children: [] }));
vi.mock('node:child_process', () => ({ fork: (...args) => fixture.fork(...args) }));
vi.mock('node:fs', () => ({ existsSync: () => false }));
vi.mock('./releases.js', () => ({ discoverCliRelease: (...args) => fixture.inspect(...args) }));

beforeEach(() => {
  fixture.reject = false; fixture.children = []; fixture.inspect.mockReset(); fixture.fork.mockReset();
  fixture.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      connected: true, unref: vi.fn(), kill: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
    });
    child.send.mockImplementation((message) => {
      if (message.mode !== 'drain') queueMicrotask(() => child.emit('message', fixture.reject ? { error: 'preflight rejected' } : { ready: true }));
    });
    fixture.children.push(child);
    return child;
  });
});
const adapter = (shutdown) => createCliUpdateAdapter({ packageRoot: '/installation/node_modules/@yuriai/web', dataDir: '/data', getPort: () => 3000, currentVersion: '2.0.0', shutdown, env: {} });

it('checks install ownership outside the serving process and preserves beta discovery', async () => {
  const host = adapter(vi.fn());
  await host.assertReady();
  expect(fixture.fork.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  expect(fixture.children[0].send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'probe', port: 3000, pid: process.pid }));
  await host.inspect('beta');
  expect(fixture.inspect).toHaveBeenCalledWith('beta', '2.0.0');
});

it('hands the exact accepted task to a detached helper before graceful shutdown', async () => {
  const shutdown = vi.fn(async () => {
    expect(fixture.children[0].send).toHaveBeenCalledWith({ mode: 'drain' });
  });
  const release = { version: '2.1.0-beta.3', kind: 'cli-package', integrity: 'sha512-test' };
  const report = vi.fn();
  await adapter(shutdown).execute({ release, stateFile: '/data/task.json', state: { operation: { id: 'op' } }, report });
  expect(fixture.fork.mock.calls[0][2].detached).toBe(true);
  expect(fixture.children[0].send.mock.calls[0][0]).toMatchObject({ mode: 'update', release, stateFile: '/data/task.json' });
  expect(report).toHaveBeenCalledWith({ status: 'installing' });
  expect(shutdown).toHaveBeenCalledOnce();
});

it('leaves the current Host running when helper preflight fails', async () => {
  fixture.reject = true;
  const shutdown = vi.fn();
  await expect(adapter(shutdown).execute({ release: { version: '2.0.1' }, state: {}, stateFile: '/data/task.json', report: vi.fn() })).rejects.toThrow('preflight');
  expect(shutdown).not.toHaveBeenCalled();
  expect(fixture.children[0].send).not.toHaveBeenCalledWith({ mode: 'drain' });
});

it('advertises development and externally supervised installations as unsupported', () => {
  const host = createCliUpdateAdapter({ packageRoot: '/source/web', dataDir: '/data', env: {} });
  expect(host.supported).toBe(false);
  expect(fixture.fork).not.toHaveBeenCalled();
});
