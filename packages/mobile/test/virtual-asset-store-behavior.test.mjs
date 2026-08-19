/**
 * Portable behavioral model of the native virtual-asset store.
 * Mirrors TTL / concurrency / byte ceilings / backpressure / cancel cleanup
 * so CI can validate the contract without a device or Xcode/Gradle toolchain.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

const TTL_MS = 120_000;
const MAX_CONCURRENT = 16;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const ASSET_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MIME_MAX = 128;

/** Mirrors Electron / native image-only MIME rules. */
function normalizeImageMime(mimeType) {
  if (typeof mimeType !== 'string') return null;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized.length > MIME_MAX) return null;
  if (normalized.includes('\n') || normalized.includes('\r') || normalized.includes('\0')) return null;
  if (!normalized.startsWith('image/')) return null;
  if (!/^image\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/i.test(normalized)) return null;
  return normalized;
}

function createStore() {
  /** @type {Map<string, any>} */
  const assets = new Map();
  let now = 0;

  function prune() {
    for (const [id, asset] of [...assets.entries()]) {
      if (now - asset.lastActivity <= TTL_MS) continue;
      asset.cancelled = true;
      asset.finished = true;
      asset.chunks = [];
      asset.queuedBytes = 0;
      if (asset.activeReaders === 0) assets.delete(id);
    }
  }

  return {
    setNow(ms) {
      now = ms;
    },
    create(assetId, mime) {
      if (!ASSET_ID.test(assetId)) throw new Error('A valid assetId is required.');
      const normalizedMime = normalizeImageMime(mime);
      if (!normalizedMime) throw new Error('A valid mime is required.');
      prune();
      if (assets.has(assetId)) throw new Error('assetId already exists.');
      if (assets.size >= MAX_CONCURRENT) throw new Error('Virtual asset concurrency limit reached.');
      assets.set(assetId, {
        mime: normalizedMime,
        chunks: [],
        queuedBytes: 0,
        totalBytes: 0,
        finished: false,
        cancelled: false,
        lastActivity: now,
        activeReaders: 0,
      });
      return `openchamber-asset://v/${assetId}`;
    },
    append(assetId, bytes) {
      prune();
      const asset = assets.get(assetId);
      if (!asset) throw new Error('Unknown assetId.');
      if (asset.cancelled) throw new Error('Asset was cancelled.');
      if (asset.finished) throw new Error('Asset already finished.');
      if (asset.totalBytes + bytes.length > MAX_ASSET_BYTES) throw new Error('Asset exceeds maximum size.');
      if (asset.queuedBytes + bytes.length > MAX_QUEUED_BYTES) throw new Error('Asset queue backpressure timeout.');
      asset.chunks.push(bytes);
      asset.queuedBytes += bytes.length;
      asset.totalBytes += bytes.length;
      asset.lastActivity = now;
    },
    finish(assetId) {
      const asset = assets.get(assetId);
      if (!asset) throw new Error('Unknown assetId.');
      asset.finished = true;
      asset.lastActivity = now;
    },
    cancel(assetId) {
      const asset = assets.get(assetId);
      if (!asset) return;
      asset.cancelled = true;
      asset.finished = true;
      asset.chunks = [];
      asset.queuedBytes = 0;
      if (asset.activeReaders === 0) assets.delete(assetId);
    },
    openStream(assetId) {
      prune();
      const asset = assets.get(assetId);
      if (!asset || asset.cancelled) throw new Error('Unknown or cancelled assetId.');
      // One consumer per asset — second open rejected (no shared-queue sharding).
      if (asset.activeReaders > 0) throw new Error('Asset already has an active reader.');
      asset.activeReaders += 1;
      asset.lastActivity = now;
      return {
        read() {
          if (asset.cancelled) return null;
          if (asset.chunks.length) {
            const chunk = asset.chunks.shift();
            asset.queuedBytes = Math.max(0, asset.queuedBytes - chunk.length);
            asset.lastActivity = now;
            return chunk;
          }
          if (asset.finished) return null;
          return undefined; // would block
        },
        close() {
          asset.activeReaders = Math.max(0, asset.activeReaders - 1);
          if ((asset.finished || asset.cancelled) && asset.activeReaders === 0) {
            assets.delete(assetId);
          }
        },
      };
    },
    size() {
      prune();
      return assets.size;
    },
  };
}

test('create returns opaque scheme URL without credentials', () => {
  const store = createStore();
  const url = store.create('asset-001', 'image/png');
  assert.equal(url, 'openchamber-asset://v/asset-001');
  assert.doesNotMatch(url, /@|password|token/i);
});

test('rejects invalid ids, duplicates, and concurrency ceiling', () => {
  const store = createStore();
  assert.throws(() => store.create('short', 'image/png'));
  store.create('asset-ok1', 'image/png');
  assert.throws(() => store.create('asset-ok1', 'image/png'));
  for (let i = 2; i <= MAX_CONCURRENT; i++) {
    store.create(`asset-ok${String(i).padStart(2, '0')}`, 'image/jpeg');
  }
  assert.equal(store.size(), MAX_CONCURRENT);
  assert.throws(() => store.create('asset-overflow', 'image/png'));
});

test('streams progressive chunks and cleans up after finish+close', () => {
  const store = createStore();
  store.create('stream-01', 'image/webp');
  store.append('stream-01', Buffer.from([1, 2]));
  store.append('stream-01', Buffer.from([3]));
  const stream = store.openStream('stream-01');
  assert.deepEqual([...stream.read()], [1, 2]);
  assert.deepEqual([...stream.read()], [3]);
  assert.equal(stream.read(), undefined);
  store.finish('stream-01');
  assert.equal(stream.read(), null);
  stream.close();
  assert.equal(store.size(), 0);
});

test('cancel drops queue and rejects further append', () => {
  const store = createStore();
  store.create('cancel-01', 'image/png');
  store.append('cancel-01', Buffer.from([9]));
  store.cancel('cancel-01');
  assert.equal(store.size(), 0);
  assert.throws(() => store.append('cancel-01', Buffer.from([1])));
});

test('byte ceiling and queue backpressure', () => {
  const store = createStore();
  store.create('limit-01', 'image/png');
  const huge = Buffer.alloc(MAX_QUEUED_BYTES + 1);
  assert.throws(() => store.append('limit-01', huge));
  store.append('limit-01', Buffer.alloc(MAX_QUEUED_BYTES));
  assert.throws(() => store.append('limit-01', Buffer.from([1])));
});

test('TTL expires idle assets', () => {
  const store = createStore();
  store.setNow(0);
  store.create('ttl-asset1', 'image/png');
  store.setNow(TTL_MS + 1);
  assert.equal(store.size(), 0);
  assert.throws(() => store.append('ttl-asset1', Buffer.from([1])));
});

test('normalizeImageMime accepts image types only (Electron-aligned)', () => {
  assert.equal(normalizeImageMime('image/png'), 'image/png');
  assert.equal(normalizeImageMime(' Image/JPEG '), 'image/jpeg');
  assert.equal(normalizeImageMime('image/svg+xml'), 'image/svg+xml');
  assert.equal(normalizeImageMime('text/plain'), null);
  assert.equal(normalizeImageMime('image/png\nX'), null);
  assert.equal(normalizeImageMime('image/png\rX'), null);
  assert.equal(normalizeImageMime('image/png\0X'), null);
  assert.equal(normalizeImageMime('application/octet-stream'), null);
  assert.equal(normalizeImageMime(''), null);
  assert.equal(normalizeImageMime('a'.repeat(MIME_MAX + 1)), null);
  assert.throws(() => createStore().create('mime-bad1', 'text/plain'));
  assert.throws(() => createStore().create('mime-bad2', 'image/png\nX'));
});

test('one reader per asset — second open is rejected', () => {
  const store = createStore();
  store.create('reader-01', 'image/png');
  store.append('reader-01', Buffer.from([1]));
  const first = store.openStream('reader-01');
  assert.deepEqual([...first.read()], [1]);
  assert.throws(() => store.openStream('reader-01'));
  store.finish('reader-01');
  first.close();
  assert.equal(store.size(), 0);
});
