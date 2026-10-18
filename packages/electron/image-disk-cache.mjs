import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { normalizeImageMimeType } from './virtual-asset-protocol.mjs';

const KEY = /^[a-f0-9]{64}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Disk owns bytes; leases and active protocol readers pin entries against LRU eviction. */
export function createImageDiskCache({ directory, maxBytes = 256 * 1024 * 1024, maxEntries = 128 }) {
  const entries = new Map();
  const leases = new Map();
  let tail = Promise.resolve();
  const file = (key, suffix) => path.join(directory, `${key}.${suffix}`);
  const remove = async (entry) => {
    entries.delete(entry.key);
    await Promise.all(['part', 'bin', 'json', 'tmp'].map((suffix) => fs.rm(file(entry.key, suffix), { force: true })));
  };
  const evict = async (reserveBytes = 0, reserveCount = 0) => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    const idle = [...entries.values()].filter((entry) => entry.ready && !entry.refs && !entry.readers)
      .sort((a, b) => a.used - b.used);
    for (const entry of idle) {
      if (bytes + reserveBytes <= maxBytes && entries.size + reserveCount <= maxEntries) break;
      await remove(entry);
      bytes -= entry.size;
    }
    if (bytes + reserveBytes > maxBytes || entries.size + reserveCount > maxEntries) {
      throw new Error('Image cache capacity is pinned by active images');
    }
  };
  const ready = (async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const names = await fs.readdir(directory);
    for (const name of names) {
      const [key, suffix] = name.split('.');
      if (!KEY.test(key)) continue;
      if (suffix === 'part' || suffix === 'tmp') {
        await fs.rm(path.join(directory, name), { force: true });
      }
      if (suffix !== 'json') continue;
      try {
        const meta = JSON.parse(await fs.readFile(file(key, 'json'), 'utf8'));
        const stat = await fs.stat(file(key, 'bin'));
        if (!normalizeImageMimeType(meta.mime) || !Number.isSafeInteger(meta.size)
          || meta.size <= 0 || meta.size > MAX_IMAGE_BYTES || stat.size !== meta.size) throw new Error('Invalid cached image');
        entries.set(key, { key, id: randomUUID(), mime: meta.mime, size: meta.size,
          used: stat.mtimeMs, ready: true, refs: 0, readers: 0 });
      } catch {
        await Promise.all(['bin', 'json'].map((ext) => fs.rm(file(key, ext), { force: true })));
      }
    }
    for (const name of names) {
      const [key, suffix] = name.split('.');
      if (KEY.test(key) && suffix === 'bin' && !entries.has(key)) await fs.rm(file(key, 'bin'), { force: true });
    }
    await evict();
  })();
  const serial = (run) => {
    const result = tail.then(() => ready).then(run);
    tail = result.catch(() => {});
    return result;
  };
  // Initialization errors remain observable through operations, not unhandled at startup.
  void ready.catch(() => {});
  const owned = (owner, leaseId) => {
    const lease = leases.get(leaseId);
    if (!lease || lease.owner !== owner) throw new Error('Unknown image lease');
    return lease.entry;
  };
  const releaseLease = async (leaseId) => {
    const lease = leases.get(leaseId);
    if (!lease) return;
    leases.delete(leaseId);
    lease.entry.refs -= 1;
    lease.entry.used = Date.now();
    if (!lease.entry.ready && lease.entry.refs === 0) await remove(lease.entry);
    else if (lease.entry.ready) await fs.utimes(file(lease.entry.key, 'bin'), new Date(), new Date()).catch(() => {});
  };
  return {
    acquire: (owner, { key, size }) => serial(async () => {
      if (!KEY.test(key) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) throw new Error('Invalid image descriptor');
      let entry = entries.get(key);
      if (entry && !entry.ready) throw new Error('Image cache upload already in progress');
      if (entry && entry.size !== size) throw new Error('Cached image descriptor mismatch');
      if (entry) {
        const exists = await fs.stat(file(key, 'bin')).catch(() => null);
        if (!exists || exists.size !== entry.size) {
          if (entry.refs || entry.readers) throw new Error('Cached image is unavailable');
          await remove(entry);
          entry = undefined;
        }
      }
      const hit = Boolean(entry);
      if (!entry) {
        await evict(size, 1);
        await fs.writeFile(file(key, 'part'), new Uint8Array(), { mode: 0o600, flag: 'wx' });
        entry = { key, id: randomUUID(), size, written: 0, ready: false, refs: 0, readers: 0, used: Date.now() };
        entries.set(key, entry);
      }
      entry.refs += 1;
      entry.used = Date.now();
      const leaseId = randomUUID();
      leases.set(leaseId, { owner, entry });
      return { leaseId, url: `openchamber-asset://cache/${entry.id}`, hit };
    }),
    append: (owner, leaseId, chunk) => serial(async () => {
      const entry = owned(owner, leaseId);
      if (entry.ready || !(chunk instanceof Uint8Array) || chunk.byteLength > 512 * 1024
        || entry.written + chunk.byteLength > entry.size) throw new Error('Invalid image cache chunk');
      await fs.appendFile(file(entry.key, 'part'), chunk);
      entry.written += chunk.byteLength;
    }),
    commit: (owner, leaseId, mime) => serial(async () => {
      const entry = owned(owner, leaseId);
      const normalized = normalizeImageMimeType(mime);
      if (entry.ready || !normalized || entry.written !== entry.size) throw new Error('Incomplete or invalid image');
      await fs.writeFile(file(entry.key, 'tmp'), JSON.stringify({ mime: normalized, size: entry.size }), { mode: 0o600 });
      await fs.rename(file(entry.key, 'part'), file(entry.key, 'bin'));
      await fs.rename(file(entry.key, 'tmp'), file(entry.key, 'json'));
      entry.mime = normalized;
      entry.ready = true;
    }),
    release: (owner, leaseId) => serial(async () => {
      if (!leases.has(leaseId)) return;
      owned(owner, leaseId);
      await releaseLease(leaseId);
    }),
    releaseOwner: (owner) => serial(async () => {
      for (const [id, lease] of leases) if (lease.owner === owner) await releaseLease(id);
    }),
    handleRequest: async (request) => {
      await ready;
      const url = new URL(request.url);
      if (url.protocol !== 'openchamber-asset:' || url.hostname !== 'cache' || url.search || url.hash
        || url.username || url.password || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      const entry = [...entries.values()].find((item) => item.id === url.pathname.slice(1) && item.ready && item.refs > 0);
      if (!entry) return new Response(null, { status: 404 });
      entry.readers += 1;
      entry.used = Date.now();
      const headers = { 'Content-Type': entry.mime, 'Content-Length': String(entry.size),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (request.method === 'HEAD') { entry.readers -= 1; return new Response(null, { headers }); }
      const stream = createReadStream(file(entry.key, 'bin'), { highWaterMark: 64 * 1024 });
      const abort = () => stream.destroy();
      stream.once('close', () => { entry.readers -= 1; request.signal?.removeEventListener('abort', abort); });
      if (request.signal?.aborted) stream.destroy();
      else request.signal?.addEventListener('abort', abort, { once: true });
      return new Response(Readable.toWeb(stream), { headers });
    },
    stats: () => serial(() => ({ entries: entries.size, bytes: [...entries.values()].reduce((sum, entry) => sum + entry.size, 0), leases: leases.size })),
  };
}
