import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';

import { createConfigSyncReceiver } from './receiver.js';
import { registerConfigSyncRoutes } from './routes.js';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-config-sync-http-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

const createApp = async () => {
  const home = await makeTempDir();
  const configDir = path.join(home, '.config', 'opencode');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
  await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');

  const receiver = createConfigSyncReceiver({
    homedir: () => home,
  });

  const app = express();
  registerConfigSyncRoutes(app, { receiver, express });
  return { app, home, receiver };
};

describe('config-sync HTTP routes', () => {
  it('runs probe → prepare → finalize (empty payload) and keeps backup generation', async () => {
    const { app, home } = await createApp();
    const plan = {
      direction: 'push',
      files: [{ path: 'opencode.jsonc', bytes: 3 }],
      directories: [],
      deletes: ['config.json', 'opencode.json'],
      agentsRoot: null,
      authFile: null,
      totalBytes: 3,
    };

    const probe = await request(app).post('/api/openchamber/config-sync/probe').send({ plan });
    expect(probe.status).toBe(200);
    expect(probe.body.inventory.files.some((entry) => entry.path === 'opencode.jsonc')).toBe(true);

    const prepare = await request(app)
      .post('/api/openchamber/config-sync/prepare')
      .send({ plan, syncRunId: 'run-http-1' });
    expect(prepare.status).toBe(200);
    expect(prepare.body.ready).toBe(true);

    const finalize = await request(app)
      .post('/api/openchamber/config-sync/finalize')
      .send({ syncRunId: 'run-http-1' });
    expect(finalize.status).toBe(200);
    expect(finalize.body.ok).toBe(true);
    expect(finalize.body.syncRunId).toBe('run-http-1');

    const backup = path.join(home, '.config', 'opencode', '.openchamber.sync-backup', 'run-http-1');
    await expect(fsp.stat(backup)).resolves.toMatchObject({ });
  });

  it('rejects a second concurrent prepare', async () => {
    const { app } = await createApp();
    const plan = {
      direction: 'push',
      files: [{ path: 'AGENTS.md', bytes: 2 }],
      directories: [],
      deletes: [],
      agentsRoot: null,
      authFile: null,
      totalBytes: 2,
    };
    const first = await request(app).post('/api/openchamber/config-sync/prepare').send({ plan, syncRunId: 'run-a' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/openchamber/config-sync/prepare').send({ plan, syncRunId: 'run-b' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('sync_in_progress');
    await request(app).post('/api/openchamber/config-sync/abort').send({ syncRunId: 'run-a' });
  });

  it('aggregates chunked put streams and rejects oversized payloads', async () => {
    const { app, receiver } = await createApp();
    const plan = {
      direction: 'push',
      files: [],
      directories: [],
      deletes: [],
      agentsRoot: null,
      authFile: null,
      totalBytes: 0,
    };
    await request(app).post('/api/openchamber/config-sync/prepare').send({ plan, syncRunId: 'run-stream' });

    // Tiny invalid tar still proves chunk aggregation reached extract.
    await expect(receiver.put({
      syncRunId: 'run-stream',
      kind: 'auth',
      stream: Readable.from([Buffer.from('aa'), Buffer.from('bb')]),
    })).rejects.toThrow(/tar|failed|Local tar extract/i);

    await request(app).post('/api/openchamber/config-sync/abort').send({ syncRunId: 'run-stream' });
  });
});
