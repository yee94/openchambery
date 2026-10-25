import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createImageDiskCache } from './image-disk-cache.mjs';

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-image-cache-'));
  dirs.push(directory);
  return { directory, cache: createImageDiskCache({ directory, ...options }) };
}
async function write(cache, key, owner = 1) {
  const lease = await cache.acquire(owner, { key, size: 3 });
  if (!lease.hit) { await cache.append(owner, lease.leaseId, new Uint8Array([1, 2, 3])); await cache.commit(owner, lease.leaseId, 'image/png'); }
  return lease;
}
test('ten revisits and concurrent preview readers reuse one disk image, including restart', async () => {
  const { cache, directory } = await setup();
  const first = await write(cache, 'a'.repeat(64));
  await cache.release(1, first.leaseId);
  for (let i = 0; i < 10; i++) {
    const lease = await cache.acquire(1, { key: 'a'.repeat(64), size: 3 });
    expect(lease.hit).toBe(true);
    expect(lease.url).toBe(first.url);
    const images = await Promise.all([1, 2].map(async () => new Uint8Array(await (await cache.handleRequest(new Request(lease.url))).arrayBuffer())));
    expect(images).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])]);
    await cache.release(1, lease.leaseId);
  }
  const reopened = createImageDiskCache({ directory });
  const restart = await reopened.acquire(2, { key: 'a'.repeat(64), size: 3 });
  expect(restart.hit).toBe(true);
  expect(new Uint8Array(await (await reopened.handleRequest(new Request(restart.url))).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  await reopened.releaseOwner(2);
  expect((await reopened.handleRequest(new Request(restart.url))).status).toBe(404);
});
test('evicts only idle entries and cleans partial writes on owner teardown', async () => {
  const { cache } = await setup({ maxBytes: 6 });
  const first = await write(cache, 'a'.repeat(64));
  const second = await write(cache, 'b'.repeat(64));
  await expect(write(cache, 'c'.repeat(64))).rejects.toThrow('pinned');
  await cache.release(1, first.leaseId);
  const third = await write(cache, 'c'.repeat(64));
  expect((await cache.handleRequest(new Request(second.url, { method: 'HEAD' }))).status).toBe(200);
  await cache.release(1, third.leaseId);
  await cache.acquire(2, { key: 'd'.repeat(64), size: 3 });
  await cache.releaseOwner(2);
  expect(await cache.stats()).toEqual({ entries: 1, bytes: 3, leases: 1 });
});
test('rejects foreign leases, invalid keys, oversized chunks and incomplete commits', async () => {
  const { cache } = await setup();
  await expect(cache.acquire(1, { key: '../file', size: 3 })).rejects.toThrow();
  const lease = await cache.acquire(1, { key: 'a'.repeat(64), size: 3 });
  await expect(cache.release(2, lease.leaseId)).rejects.toThrow('Unknown');
  await expect(cache.append(1, lease.leaseId, new Uint8Array(4))).rejects.toThrow();
  await expect(cache.commit(1, lease.leaseId, 'image/png')).rejects.toThrow();
  await cache.release(1, lease.leaseId);
  expect(await cache.stats()).toEqual({ entries: 0, bytes: 0, leases: 0 });
});

test('auth purge removes complete and incomplete entries across restart', async () => {
  const { cache, directory } = await setup();
  const image = await write(cache, 'a'.repeat(64));
  await cache.acquire(1, { key: 'b'.repeat(64), size: 3 });
  await cache.clear();
  expect(await cache.stats()).toEqual({ entries: 0, bytes: 0, leases: 0 });
  expect((await cache.handleRequest(new Request(image.url))).status).toBe(404);
  const restarted = createImageDiskCache({ directory });
  expect((await restarted.acquire(1, { key: 'a'.repeat(64), size: 3 })).hit).toBe(false);
  await restarted.releaseOwner(1);
});

test('generic MIME survives restart and cached protocol implements seek, suffix, HEAD and 416', async () => {
  const { cache, directory } = await setup();
  const key = 'd'.repeat(64);
  const lease = await cache.acquire(1, { key, size: 10 });
  await cache.append(1, lease.leaseId, new TextEncoder().encode('0123456789'));
  await cache.commit(1, lease.leaseId, 'video/mp4');
  await cache.releaseOwner(1);
  const restarted = createImageDiskCache({ directory });
  const hit = await restarted.lookup(2, { key, size: 10 });
  expect(hit.hit).toBe(true);
  for (const [range, body, contentRange] of [['bytes=0-1', '01', 'bytes 0-1/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
    const response = await restarted.handleRequest(new Request(hit.url, { headers: { Range: range } }));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(await response.text()).toBe(body);
  }
  const head = await restarted.handleRequest(new Request(hit.url, { method: 'HEAD' }));
  expect(head.headers.get('content-length')).toBe('10');
  expect(await head.text()).toBe('');
  expect((await restarted.handleRequest(new Request(hit.url, { headers: { Range: 'bytes=20-' } }))).status).toBe(416);
  await restarted.releaseOwner(2);
});
