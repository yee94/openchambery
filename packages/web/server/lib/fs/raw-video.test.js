import { afterEach, expect, test } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerFsRoutes } from './routes.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('raw video supports first-byte probing, tail seeking, HEAD and unsatisfiable ranges', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-video-range-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'clip.mov');
  await fs.writeFile(file, Buffer.from('0123456789'));
  const app = express();
  registerFsRoutes({ get: (route, handler) => { if (route === '/api/fs/raw') app.get(route, handler); }, post() {}, put() {} }, {
    os, path, fsPromises: fs, spawn() {}, crypto: globalThis.crypto,
    normalizeDirectoryPath: value => value, resolveProjectDirectory: async () => ({ directory }),
    buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: directory,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/fs/raw?path=${encodeURIComponent(file)}`;
  for (const [range, expected, contentRange] of [['bytes=0-1', '01', 'bytes 0-1/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
    const response = await fetch(url, { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/quicktime');
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe(expected);
  }
  const head = await fetch(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe('10');
  expect(await head.text()).toBe('');
  const invalid = await fetch(url, { headers: { Range: 'bytes=20-' } });
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get('content-range')).toBe('bytes */10');
});
