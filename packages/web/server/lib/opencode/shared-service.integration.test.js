import { expect, test } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSharedOpenCodeService, isProcessAlive } from './shared-service.js';

// Opt-in real service, with isolated registration, config and database. No model calls.
test.skipIf(!process.env.OPENCHAMBER_TEST_OPENCODE_BINARY)('shared service survives its launcher, is reused, and can be replaced explicitly', async () => {
  const temporary = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'shared-service-'));
  const config = path.join(root, 'config', 'opencode');
  await fs.mkdir(config, { recursive: true });
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await fs.writeFile(path.join(config, 'service.json'), JSON.stringify({ hostname: '127.0.0.1', port }));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: os.tmpdir(),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  const binary = process.env.OPENCHAMBER_TEST_OPENCODE_BINARY;
  const service = createSharedOpenCodeService({
    envLike: env,
    spawnImpl: (command, args, options) => spawn(command, args, { ...options, cwd: root }),
  });
  const probe = async (registration) => {
    const response = await fetch(`${registration.origin}/api/info`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  try {
    await service.start({ binary, env });
    const first = await service.readRegistration();
    expect(first?.pid).toBeGreaterThan(0);
    expect(isProcessAlive(first.pid)).toBe(true);
    expect((await probe(first)).version).toBe(first.version);

    await service.start({ binary, env });
    const reused = await service.readRegistration();
    expect(reused.pid).toBe(first.pid);

    await service.start({ binary, env, replace: true });
    const replacement = await service.readRegistration();
    expect(replacement.pid).not.toBe(first.pid);
    expect(isProcessAlive(first.pid)).toBe(false);
    expect((await probe(replacement)).version).toBe(replacement.version);
  } finally {
    await promisify(execFile)(binary, ['service', 'stop'], { env, cwd: root, timeout: 20_000, windowsHide: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
