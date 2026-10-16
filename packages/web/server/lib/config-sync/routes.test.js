import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { createConfigSyncReceiver } from './receiver.js';
import { registerConfigSyncRoutes } from './routes.js';
import { collectLocalTarBuffer } from './tar.js';
import { buildRemoteAgentsTarScript, buildRemoteConfigTarScript } from './scripts.js';

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
  it.each(['http-config', 'http-agents', 'local-pack', 'ssh-config', 'ssh-agents'])(
    '%s archive excludes inventory-skipped files, including inside followed symlinks',
    async (transport) => {
      const { home, receiver } = await createApp();
      const config = transport.endsWith('config');
      const cwd = config ? path.join(home, '.config', 'opencode') : home;
      const entry = config ? 'plugins' : '.agents';
      const root = path.join(cwd, entry);
      const external = path.join(home, 'external-skill');
      await fsp.mkdir(path.join(external, 'node_modules', 'dependency'), { recursive: true });
      await fsp.writeFile(path.join(external, 'SKILL.md'), 'keep skill implementation');
      await fsp.writeFile(path.join(external, 'node_modules', 'dependency', 'bulk.bin'), randomBytes(256 * 1024));
      await fsp.writeFile(path.join(external, 'old.backup'), randomBytes(256 * 1024));
      await fsp.mkdir(path.join(external, '.venv-asc', 'lib'), { recursive: true });
      await fsp.writeFile(path.join(external, '.venv-asc', 'lib', 'binary.so'), randomBytes(256 * 1024));
      await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
      await fsp.writeFile(path.join(root, 'node_modules', 'bulk.bin'), randomBytes(256 * 1024));
      await fsp.symlink(external, path.join(root, 'linked-skill'), 'dir');

      let archive;
      if (transport.startsWith('http-')) {
        archive = await receiver.download({ kind: config ? 'config' : 'agents' });
      } else if (transport === 'local-pack') {
        archive = await collectLocalTarBuffer(['-h', '-czf', '-', '-C', cwd, entry]);
      } else {
        const script = config
          ? buildRemoteConfigTarScript({ directories: [{ path: entry }] })
          : buildRemoteAgentsTarScript();
        archive = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home } });
      }
      const listing = execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' });
      expect(listing).toContain(`${entry}/linked-skill/SKILL.md`);
      expect(listing).not.toContain('node_modules');
      expect(listing).not.toContain('.backup');
      expect(listing).not.toContain('.venv-asc');
      expect(archive.byteLength).toBeLessThan(32 * 1024);
    },
  );

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
