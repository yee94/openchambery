import { expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createOpenCodeUpdateDiscovery } from './update-discovery.js';
import { installPinnedOpenCode2Cli } from './ensure-cli.js';
import { createSharedOpenCodeService } from './shared-service.js';
import { registerOpenCodeRoutes } from './routes.js';

// Downloads real official binaries; never touches the user's shared service.
test.skipIf(process.env.OPENCHAMBER_TEST_REMOTE_UPGRADE !== '1')('remote discovery upgrades an isolated shared service and verifies its running version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-upgrade-'));
  const env = {
    PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_CONFIG_DIR: path.join(root, 'config', 'opencode'), OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  await fs.mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true });
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await fs.writeFile(path.join(env.OPENCODE_CONFIG_DIR, 'service.json'), JSON.stringify({ hostname: '127.0.0.1', port }));
  const service = createSharedOpenCodeService({ envLike: env, spawnImpl: (command, args, options) => spawn(command, args, { ...options, cwd: root }) });
  let binary;
  let registration;
  try {
    const target = await createOpenCodeUpdateDiscovery()();
    expect(target).not.toBe('2.0.16');
    binary = await installPinnedOpenCode2Cli({ version: '2.0.16', dataDir: root });
    await service.start({ binary, env });
    registration = await service.readRegistration();
    expect(registration.version).toBe('2.0.16');
    const app = express();
    app.use(express.json());
    registerOpenCodeRoutes(app, {
      getIsExternalOpenCode: () => true, getIsSharedOpenCodeService: () => true,
      getResolvedOpenCodeBinary: () => binary, getResolvedOpenCodeBinarySource: () => 'installed',
      readSettingsFromDiskMigrated: async () => ({}),
      getOpenCodeResolutionSnapshot: async () => ({ source: 'installed', resolved: binary }),
      buildOpenCodeUrl: (pathname) => `${registration.origin}${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` }),
      forceResolvedOpenCodeBinary: (value) => { binary = value; },
      restartOpenCode: async ({ binaryPath }) => {
        await service.start({ binary: binaryPath, env, replace: true });
        registration = await service.readRegistration();
      },
      openchamberDataDir: root,
    });
    const before = await request(app).get('/api/opencode/upgrade-status').expect(200);
    expect(before.body).toMatchObject({ available: true, targetVersion: target });
    const upgrade = await request(app).post('/api/opencode/upgrade').send({ target }).expect(200);
    expect(upgrade.body).toMatchObject({ success: true, restarted: true, version: target });
    const after = await request(app).get('/api/opencode/upgrade-status').expect(200);
    expect(after.body).toMatchObject({ available: false, serveVersion: target });
  } finally {
    if (binary) await promisify(execFile)(binary, ['service', 'stop'], { env, cwd: root, timeout: 20_000, windowsHide: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
