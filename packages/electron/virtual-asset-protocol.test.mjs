import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ASSET_HOST,
  ASSET_PROTOCOL,
  ASSET_SCHEME_PRIVILEGES,
  buildVirtualAssetUrl,
  coerceChunkBytes,
  createVirtualAssetRegistry,
  normalizeImageMimeType,
  parseVirtualAssetId,
} from './virtual-asset-protocol.mjs';

test('scheme privileges include stream and secure defaults', () => {
  assert.equal(ASSET_SCHEME_PRIVILEGES.standard, true);
  assert.equal(ASSET_SCHEME_PRIVILEGES.secure, true);
  assert.equal(ASSET_SCHEME_PRIVILEGES.supportFetchAPI, true);
  assert.equal(ASSET_SCHEME_PRIVILEGES.corsEnabled, true);
  assert.equal(ASSET_SCHEME_PRIVILEGES.stream, true);
});

test('buildVirtualAssetUrl never embeds host paths or credentials', () => {
  const url = buildVirtualAssetUrl('abc-123');
  assert.equal(url, `${ASSET_PROTOCOL}://${ASSET_HOST}/abc-123`);
  const parsed = new URL(url);
  assert.equal(parsed.username, '');
  assert.equal(parsed.password, '');
  assert.equal(parsed.hostname, ASSET_HOST);
  assert.equal(parsed.pathname, '/abc-123');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
});

test('parseVirtualAssetId accepts only opaque stream ids', () => {
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://${ASSET_HOST}/id-1`), 'id-1');
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://other/id-1`), null);
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://${ASSET_HOST}/a/b`), null);
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://user:pass@${ASSET_HOST}/id-1`), null);
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://${ASSET_HOST}/id-1?x=1`), null);
  assert.equal(parseVirtualAssetId(`${ASSET_PROTOCOL}://${ASSET_HOST}/id-1#frag`), null);
  assert.equal(parseVirtualAssetId('openchamber-ui://app/index.html'), null);
  assert.equal(parseVirtualAssetId('file:///Users/secret/photo.png'), null);
});

test('normalizeImageMimeType accepts image types only', () => {
  assert.equal(normalizeImageMimeType('image/png'), 'image/png');
  assert.equal(normalizeImageMimeType(' Image/JPEG '), 'image/jpeg');
  assert.equal(normalizeImageMimeType('image/svg+xml'), 'image/svg+xml');
  assert.equal(normalizeImageMimeType('text/plain'), null);
  assert.equal(normalizeImageMimeType('image/png\nX'), null);
  assert.equal(normalizeImageMimeType('application/octet-stream'), null);
  assert.equal(normalizeImageMimeType(''), null);
});

test('coerceChunkBytes accepts ArrayBuffer and TypedArray views', () => {
  const buffer = new Uint8Array([1, 2, 3]).buffer;
  assert.deepEqual([...coerceChunkBytes(buffer)], [1, 2, 3]);
  assert.deepEqual([...coerceChunkBytes(new Uint8Array([4, 5]))], [4, 5]);
  assert.throws(() => coerceChunkBytes('nope'), /ArrayBuffer or TypedArray/);
});

test('create returns opaque assetId and secure protocol URL', () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'fixed-id',
  });
  const created = registry.create({ mimeType: 'image/png' });
  assert.equal(created.assetId, 'fixed-id');
  assert.equal(created.mimeType, 'image/png');
  assert.equal(created.url, `${ASSET_PROTOCOL}://${ASSET_HOST}/fixed-id`);
  assert.equal(created.url.includes('/Users/'), false);
  assert.equal(created.url.includes('token'), false);
  registry.dispose();
});

test('rejects non-image mime and concurrent overflow', () => {
  const registry = createVirtualAssetRegistry({
    limits: { maxConcurrent: 1 },
    idFactory: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
  assert.throws(() => registry.create({ mimeType: 'text/html' }), /image\/\*/);
  registry.create({ mimeType: 'image/webp' });
  assert.throws(() => registry.create({ mimeType: 'image/png' }), /concurrency/);
  registry.dispose();
});

test('streams pushed chunks to a single protocol consumer then finishes', async () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'stream-1',
  });
  const { assetId, url } = registry.create({ mimeType: 'image/gif' });
  assert.equal(parseVirtualAssetId(url), assetId);

  const responsePromise = Promise.resolve(registry.handleRequest(new Request(url)));
  await registry.push(assetId, new Uint8Array([10, 20]));
  await registry.push(assetId, new Uint8Array([30]));
  registry.finish(assetId);

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/gif');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...body], [10, 20, 30]);
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('second consumer on the same assetId returns 409', async () => {
  const registry = createVirtualAssetRegistry({ idFactory: () => 'once' });
  const { url } = registry.create({ mimeType: 'image/png' });
  const first = registry.handleRequest(new Request(url));
  assert.equal(first.status, 200);
  const second = registry.handleRequest(new Request(url));
  assert.equal(second.status, 409);
  registry.cancel('once');
  registry.dispose();
});

test('unknown asset and wrong scheme return 404 without leaking paths', () => {
  const registry = createVirtualAssetRegistry();
  const missing = registry.handleRequest(new Request(`${ASSET_PROTOCOL}://${ASSET_HOST}/nope`));
  assert.equal(missing.status, 404);
  const fileish = registry.handleRequest(new Request('file:///tmp/secret.png'));
  assert.equal(fileish.status, 404);
  registry.dispose();
});

test('cancel aborts an in-flight protocol stream', async () => {
  const registry = createVirtualAssetRegistry({ idFactory: () => 'cancel-me' });
  const { assetId, url } = registry.create({ mimeType: 'image/png' });
  const response = registry.handleRequest(new Request(url));
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const readPromise = reader.read();
  registry.cancel(assetId);

  await assert.rejects(async () => {
    await readPromise;
  });
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('protocol cancel callback destroys the asset', async () => {
  const registry = createVirtualAssetRegistry({ idFactory: () => 'proto-cancel' });
  const { url } = registry.create({ mimeType: 'image/png' });
  const response = registry.handleRequest(new Request(url));
  assert.ok(response.body);
  await response.body.cancel();
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('request AbortSignal cancels the asset', async () => {
  const registry = createVirtualAssetRegistry({ idFactory: () => 'abort-sig' });
  const { url } = registry.create({ mimeType: 'image/png' });
  const controller = new AbortController();
  const response = registry.handleRequest(new Request(url, { signal: controller.signal }));
  assert.equal(response.status, 200);
  controller.abort();
  // Allow abort listener to run.
  await Promise.resolve();
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('chunk size and total byte limits are enforced', async () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'limits',
    limits: {
      maxChunkBytes: 4,
      maxTotalBytes: 6,
      maxQueuedBytes: 64,
    },
  });
  const { assetId } = registry.create({ mimeType: 'image/png' });
  await assert.rejects(
    () => registry.push(assetId, new Uint8Array(5)),
    /maxChunkBytes/,
  );
  await registry.push(assetId, new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    () => registry.push(assetId, new Uint8Array([5, 6, 7])),
    /maxTotalBytes/,
  );
  registry.dispose();
});

test('backpressure waits until the consumer drains the queue', async () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'bp',
    limits: {
      maxQueuedBytes: 4,
      maxChunkBytes: 4,
      maxTotalBytes: 32,
    },
  });
  const { assetId, url } = registry.create({ mimeType: 'image/png' });

  // Fill the queue without a consumer.
  await registry.push(assetId, new Uint8Array([1, 2, 3, 4]));

  let secondResolved = false;
  const secondPush = registry.push(assetId, new Uint8Array([5, 6])).then((result) => {
    secondResolved = true;
    return result;
  });

  // Give the blocked push a turn; it must still be waiting.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondResolved, false);

  const response = registry.handleRequest(new Request(url));
  const bodyPromise = response.arrayBuffer().then((buf) => new Uint8Array(buf));

  // Finish after consumer is attached so the stream can complete.
  await secondPush;
  assert.equal(secondResolved, true);
  registry.finish(assetId);

  const body = await bodyPromise;
  assert.deepEqual([...body], [1, 2, 3, 4, 5, 6]);
  registry.dispose();
});

test('create returns asset URL before any consumer attaches', () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'url-first',
  });
  const created = registry.create({ mimeType: 'image/png' });
  assert.equal(created.url, `${ASSET_PROTOCOL}://${ASSET_HOST}/url-first`);
  assert.equal(registry.getStats().assets[0]?.consumerAttached, false);
  // URL is usable as a protocol request target even though nothing has loaded yet.
  assert.equal(parseVirtualAssetId(created.url), created.assetId);
  registry.dispose();
});

test('push to maxQueuedBytes then blocked push ends when consumer never attaches and cancel fires', async () => {
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'cancel-block',
    limits: {
      maxQueuedBytes: 4,
      maxChunkBytes: 4,
      maxTotalBytes: 32,
      ttlMs: 60_000,
    },
  });
  const { assetId, url } = registry.create({ mimeType: 'image/png' });
  assert.equal(url, `${ASSET_PROTOCOL}://${ASSET_HOST}/cancel-block`);
  assert.equal(registry.getStats().assets[0]?.consumerAttached, false);

  const first = await registry.push(assetId, new Uint8Array([1, 2, 3, 4]));
  assert.equal(first.queuedBytes, 4);
  assert.equal(first.totalBytes, 4);

  let settled = false;
  const blocked = registry.push(assetId, new Uint8Array([5, 6])).then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(registry.getStats().assets[0]?.consumerAttached, false);
  assert.equal(registry.getStats().assets[0]?.queuedBytes, 4);

  registry.cancel(assetId);
  await assert.rejects(() => blocked, /cancelled/);
  assert.equal(settled, true);
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('push to maxQueuedBytes then blocked push ends when consumer never attaches and TTL fires', async () => {
  let clock = 1_000;
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'ttl-block',
    now: () => clock,
    limits: {
      maxQueuedBytes: 4,
      maxChunkBytes: 4,
      maxTotalBytes: 32,
      ttlMs: 100,
    },
  });
  const { assetId, url } = registry.create({ mimeType: 'image/png' });
  assert.equal(parseVirtualAssetId(url), assetId);
  assert.equal(registry.getStats().assets[0]?.consumerAttached, false);

  await registry.push(assetId, new Uint8Array([1, 2, 3, 4]));
  assert.equal(registry.getStats().assets[0]?.queuedBytes, 4);

  let settled = false;
  const blocked = registry.push(assetId, new Uint8Array([5])).then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  // Still under the memory cap — no unbounded buffering while waiting for attach.
  assert.equal(registry.getStats().assets[0]?.queuedBytes, 4);

  clock = 1_200;
  registry.sweepExpired();

  await assert.rejects(() => blocked, /cancelled/);
  assert.equal(settled, true);
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('TTL sweep removes stale assets', () => {
  let clock = 1_000;
  const registry = createVirtualAssetRegistry({
    idFactory: () => 'ttl',
    now: () => clock,
    limits: { ttlMs: 100 },
  });
  registry.create({ mimeType: 'image/png' });
  assert.equal(registry.getStats().size, 1);
  clock = 1_200;
  registry.sweepExpired();
  assert.equal(registry.getStats().size, 0);
  registry.dispose();
});

test('push after finish or cancel fails', async () => {
  const registry = createVirtualAssetRegistry({
    idFactory: (() => {
      let n = 0;
      return () => `x-${++n}`;
    })(),
  });
  const a = registry.create({ mimeType: 'image/png' });
  registry.finish(a.assetId);
  await assert.rejects(() => registry.push(a.assetId, new Uint8Array([1])), /finished|cancelled|unknown/);

  const b = registry.create({ mimeType: 'image/png' });
  registry.cancel(b.assetId);
  await assert.rejects(() => registry.push(b.assetId, new Uint8Array([1])), /unknown|cancelled/);
  registry.dispose();
});
