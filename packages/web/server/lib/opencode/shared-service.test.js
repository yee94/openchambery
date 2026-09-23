import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSharedServiceStartEnv,
  isSharedServiceEnabled,
  parseSharedServiceRegistration,
  readSharedServiceRegistration,
  resolveSharedServiceRegistrationPath,
  startSharedOpenCodeService,
} from './shared-service.js';

const fakeChild = () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('shared OpenCode service registration', () => {
  it('resolves the stable-channel registration under the XDG state root', () => {
    expect(resolveSharedServiceRegistrationPath({}, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'opencode', 'service.json'));
    expect(resolveSharedServiceRegistrationPath({ XDG_STATE_HOME: '/xdg' }, '/home/u')).toBe(path.join('/xdg', 'opencode', 'service.json'));
  });

  it('parses a registration and rejects malformed ones', () => {
    expect(parseSharedServiceRegistration(JSON.stringify({
      id: 'a', version: '2.0.12', url: 'http://127.0.0.1:49374', pid: 42, password: 'pw',
    }))).toEqual({ origin: 'http://127.0.0.1:49374', port: 49374, pid: 42, password: 'pw', version: '2.0.12' });
    expect(parseSharedServiceRegistration(JSON.stringify({ url: 'http://127.0.0.1:49374' }))?.password).toBeNull();
    expect(parseSharedServiceRegistration('not json')).toBeNull();
    expect(parseSharedServiceRegistration(JSON.stringify({ url: 'ftp://x:1' }))).toBeNull();
    expect(parseSharedServiceRegistration(JSON.stringify({ url: 'http://127.0.0.1' }))).toBeNull();
  });

  it('treats a missing registration file as absent, not as a service', async () => {
    const fsLike = { readFile: vi.fn(async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }) };
    await expect(readSharedServiceRegistration({ file: '/x/service.json', fsLike })).resolves.toBeNull();
  });

  it('is enabled by default and can be opted out', () => {
    expect(isSharedServiceEnabled({})).toBe(true);
    expect(isSharedServiceEnabled({ OPENCHAMBER_OPENCODE_SHARED_SERVICE: '0' })).toBe(false);
    expect(isSharedServiceEnabled({ OPENCHAMBER_OPENCODE_SHARED_SERVICE: 'false' })).toBe(false);
  });
});

describe('shared OpenCode service start', () => {
  it('never hands OpenChamber credentials to the long-lived service', () => {
    expect(buildSharedServiceStartEnv({
      PATH: '/bin',
      HOME: '/home/u',
      OPENCODE_SERVER_PASSWORD: 'managed',
      OPENCODE_PASSWORD: 'managed',
      OPENCHAMBER_UI_PASSWORD: 'ui',
      OPENCHAMBER_DATA_DIR: '/data',
    })).toEqual({ PATH: '/bin', HOME: '/home/u' });
  });

  it('runs `service start` and resolves on a clean exit', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    await startSharedOpenCodeService({ binary: '/bin/opencode', args: ['--x'], env: { PATH: '/bin' }, spawnImpl });
    expect(spawnImpl).toHaveBeenCalledWith('/bin/opencode', ['--x', 'service', 'start'], expect.objectContaining({ env: { PATH: '/bin' } }));
  });

  it('surfaces the CLI error when `service start` fails', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', 'Background service failed to start');
        child.emit('exit', 1);
      });
      return child;
    });
    await expect(startSharedOpenCodeService({ binary: 'opencode', env: {}, spawnImpl }))
      .rejects.toThrow(/exited with code 1: Background service failed to start/);
  });
});
