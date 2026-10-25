import { afterEach, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { registerFsRoutes } from './routes.js';
import { createImageFingerprintReader } from './image-fingerprint.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-image-fingerprint-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'a.png');
  await fs.writeFile(file, 'first');
  return { directory, file };
};

test('fingerprints are content hashes; unchanged files avoid rehash; same-size preserved-mtime writes invalidate', async () => {
  const { file, directory } = await fixture();
  let reads = 0;
  const reader = createImageFingerprintReader({ ...fs, open: (...args) => { reads++; return fs.open(...args); } });
  const first = await reader(file);
  expect(first).toBe(createHash('sha256').update('first').digest('hex'));
  expect(await reader(file)).toBe(first);
  expect(reads).toBe(1);
  const duplicate = path.join(directory, 'copy.png');
  await fs.copyFile(file, duplicate);
  expect(await reader(duplicate)).toBe(first);
  const stat = await fs.stat(file);
  await fs.writeFile(file, 'other');
  await fs.utimes(file, stat.atime, stat.mtime);
  expect(await reader(file)).toBe(createHash('sha256').update('other').digest('hex'));
});

test('real stat route returns authorized opt-in SHA-256 metadata without image body', async () => {
  const { file, directory } = await fixture();
  const app = express();
  registerFsRoutes({ get: (route, handler) => { if (route === '/api/fs/stat') app.get(route, handler); }, post() {}, put() {} }, {
    os, path, fsPromises: fs, spawn() {}, crypto: globalThis.crypto,
    normalizeDirectoryPath: value => value, resolveProjectDirectory: async () => ({ directory }),
    buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: directory,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/fs/stat?path=${encodeURIComponent(file)}`;
  expect((await (await fetch(url)).json()).sha256).toBeUndefined();
  const response = await fetch(`${url}&fingerprint=true`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).sha256).toBe(createHash('sha256').update('first').digest('hex'));
  expect((await fetch(`${url}-missing&fingerprint=true`)).status).toBe(404);
});
