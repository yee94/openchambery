import { afterEach, expect, test } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerFsRoutes } from './routes.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('HTML and relative assets retain URLs and privately revalidate after file authorization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-html-revalidate-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const html = '<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script><p>original</p>';
  await fs.writeFile(path.join(directory, 'index.html'), html);
  await fs.writeFile(path.join(directory, 'style.css'), 'p { color: red }');
  await fs.writeFile(path.join(directory, 'app.js'), 'window.relativeScriptLoaded = true');
  const app = express();
  registerFsRoutes({ get(route, handler) { if (route instanceof RegExp) app.get(route, handler); }, post() {}, put() {} }, {
    os, path, fsPromises: fs, spawn() {}, crypto: globalThis.crypto,
    normalizeDirectoryPath: value => value, resolveProjectDirectory: async () => ({ directory }),
    buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => 'git', yuriUserConfigRoot: directory,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/fs/serve${directory}/index.html`;
  const first = await fetch(url);
  expect(first.headers.get('cache-control')).toBe('private, no-cache');
  expect(first.headers.get('vary')).toContain('Authorization');
  expect(first.headers.get('vary')).toContain('Cookie');
  expect(await first.text()).toBe(html);
  const etag = first.headers.get('etag');
  const hit = await fetch(url, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
  expect(hit.status).toBe(304);
  expect(await hit.text()).toBe('');
  expect(await (await fetch(new URL('style.css', url))).text()).toBe('p { color: red }');
  expect(await (await fetch(new URL('app.js', url))).text()).toContain('relativeScriptLoaded');
  await fs.writeFile(path.join(directory, 'index.html'), html.replace('original', 'modified'));
  expect((await fetch(url, { headers: { 'If-None-Match': etag } })).status).toBe(200);
  await fs.unlink(path.join(directory, 'index.html'));
  expect((await fetch(url, { headers: { 'If-None-Match': etag } })).status).toBe(404);
});

test('raw video supports first-byte probing, tail seeking, HEAD and unsatisfiable ranges', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-video-range-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'clip.mov');
  await fs.writeFile(file, Buffer.from('0123456789'));
  const app = express();
  registerFsRoutes({ get: (route, handler) => { if (route === '/api/fs/raw') app.get(route, handler); }, post() {}, put() {} }, {
    os, path, fsPromises: fs, spawn() {}, crypto: globalThis.crypto,
    normalizeDirectoryPath: value => value, resolveProjectDirectory: async () => ({ directory }),
    buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => 'git', yuriUserConfigRoot: directory,
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
