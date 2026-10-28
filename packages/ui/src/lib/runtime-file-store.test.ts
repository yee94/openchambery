import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFileStore } from './runtime-file-store';
import { guiBundleCache } from './gui-plugins/bundle-cache';

vi.mock('./brand-storage-migration', () => ({ migrateBrandIndexedDB: async () => {} }));

type StoreName = 'meta' | 'bytes';
type Operation = { store: StoreName; method: string; key?: string };
type Request = { result?: unknown; error?: Error; onsuccess?: () => void; onerror?: () => void };

// Stage both stores until commit, including requests whose caller does not await
// them. A request error or explicit abort discards the entire transaction.
function installIndexedDB() {
  const rows = { meta: new Map<string, unknown>(), bytes: new Map<string, unknown>() };
  const transactions: Operation[][] = [];
  let fail: ((operation: Operation) => boolean) | undefined;
  let beforeCommit: (() => void) | undefined;

  class Transaction {
    oncomplete?: () => void;
    onabort?: () => void;
    onerror?: () => void;
    error?: Error;
    private aborted = false;
    private settled = false;
    private pending = 0;
    private staged = { meta: new Map(rows.meta), bytes: new Map(rows.bytes) };
    private operations: Operation[] = [];

    constructor() { transactions.push(this.operations); }

    abort() {
      if (this.settled) return;
      this.aborted = true;
      this.error ??= new Error('Transaction aborted');
      setTimeout(() => this.settle(), 0);
    }

    private settle() {
      if (this.settled || this.pending) return;
      const hook = beforeCommit;
      beforeCommit = undefined;
      hook?.();
      this.settled = true;
      if (this.aborted) { this.onabort?.(); return; }
      rows.meta = this.staged.meta;
      rows.bytes = this.staged.bytes;
      this.oncomplete?.();
    }

    private request(operation: Operation, action: () => unknown): Request {
      const request: Request = {};
      this.operations.push(operation);
      this.pending++;
      setTimeout(() => {
        if (this.aborted || fail?.(operation)) {
          fail = undefined;
          request.error = this.error = new Error('Injected request failure');
          this.aborted = true;
          request.onerror?.();
          this.onerror?.();
        } else {
          request.result = action();
          request.onsuccess?.();
        }
        this.pending--;
        setTimeout(() => this.settle(), 0);
      }, 0);
      return request;
    }

    objectStore(store: StoreName) {
      const values = this.staged[store];
      return {
        get: (key: string) => this.request({ store, method: 'get', key }, () => values.get(key)),
        getAll: () => this.request({ store, method: 'getAll' }, () => [...values.values()]),
        put: (value: unknown, key?: string) => {
          const target = key ?? (value as { key: string }).key;
          return this.request({ store, method: 'put', key: target }, () => values.set(target, value));
        },
        delete: (key: string) => this.request({ store, method: 'delete', key }, () => values.delete(key)),
      };
    }
  }

  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: Request = {
        result: { transaction: () => new Transaction(), close: () => {} },
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return {
    rows, transactions,
    failRequest: (predicate: (operation: Operation) => boolean) => { fail = predicate; },
    beforeCommit: (hook: () => void) => { beforeCommit = hook; },
  };
}

const signal = () => new AbortController().signal;
const group = (runtime = 'runtime-a', id = 'plugin-a') => JSON.stringify(['gui-code', runtime, id]);
const key = (schema = 'gui-code-v1', abi = '2.2', runtime = 'runtime-a', id = 'plugin-a') => JSON.stringify([schema, abi, runtime, id]);
const code = (value: string) => ({ code: value, token: 'a'.repeat(64) });
const blob = (value: string) => new Blob([JSON.stringify(code(value))], { type: 'application/json' });

describe('runtime file store transactional GUI replacement', () => {
  let database: ReturnType<typeof installIndexedDB>;
  beforeEach(() => { database = installIndexedDB(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes old schema and ABI keys atomically while preserving other plugins, runtimes and images', async () => {
    const oldSchema = key('test-previous-schema');
    const oldAbi = key('gui-code-v1', 'test-previous-abi');
    for (const old of [oldSchema, oldAbi]) await runtimeFileStore.write(old, blob('old'), signal(), [group()]);
    await guiBundleCache.write('runtime-a', 'plugin-b', code('other plugin'), signal());
    await guiBundleCache.write('runtime-b', 'plugin-a', code('other runtime'), signal());
    await runtimeFileStore.write('image', new Blob(['image bytes'], { type: 'image/png' }), signal(), ['image-scope']);
    const before = database.transactions.length;

    await guiBundleCache.write('runtime-a', 'plugin-a', code('new'), signal());

    expect(database.transactions.length - before).toBe(1);
    for (const old of [oldSchema, oldAbi]) {
      expect(database.rows.meta.has(old)).toBe(false);
      expect(database.rows.bytes.has(old)).toBe(false);
    }
    expect(database.rows.meta.size).toBe(4);
    expect(database.rows.bytes.size).toBe(4);
    expect(await guiBundleCache.read('runtime-a', 'plugin-a', signal())).toEqual(code('new'));
    expect(await guiBundleCache.read('runtime-a', 'plugin-b', signal())).toEqual(code('other plugin'));
    expect(await guiBundleCache.read('runtime-b', 'plugin-a', signal())).toEqual(code('other runtime'));
    const image = await runtimeFileStore.read('image', signal());
    expect(await image?.text()).toBe('image bytes');
    expect(image?.type).toBe('image/png');
  });

  it('tags an existing untagged same key and overwrites revisions without accumulating records', async () => {
    await runtimeFileStore.write(key(), blob('untagged'), signal());
    await guiBundleCache.write('runtime-a', 'plugin-a', code('revision 1'), signal());
    await guiBundleCache.write('runtime-a', 'plugin-a', { code: 'revision 2', token: 'b'.repeat(64) }, signal());
    expect(database.rows.meta.get(key())).toMatchObject({ tags: [group()] });
    expect(database.rows.meta.size).toBe(1);
    expect(database.rows.bytes.size).toBe(1);
    expect(await guiBundleCache.read('runtime-a', 'plugin-a', signal())).toEqual({ code: 'revision 2', token: 'b'.repeat(64) });
  });

  it.each([
    ['bytes', 'put'], ['meta', 'put'], ['bytes', 'delete'], ['meta', 'delete'],
  ] as const)('rolls back both stores on %s.%s failure and allows retry', async (store, method) => {
    const old = key('test-previous-schema');
    await runtimeFileStore.write(old, blob('old'), signal(), [group()]);
    const previousMeta = new Map(database.rows.meta);
    const previousBytes = new Map(database.rows.bytes);
    database.failRequest((operation) => operation.store === store && operation.method === method);

    await expect(runtimeFileStore.write(key(), blob('new'), signal(), undefined, group())).rejects.toThrow();
    expect(database.rows.meta).toEqual(previousMeta);
    expect(database.rows.bytes).toEqual(previousBytes);
    expect(await (await runtimeFileStore.read(old, signal()))?.text()).toBe(await blob('old').text());

    await guiBundleCache.write('runtime-a', 'plugin-a', code('retry'), signal());
    expect(database.rows.meta.has(old)).toBe(false);
    expect(database.rows.bytes.has(old)).toBe(false);
    expect(await guiBundleCache.read('runtime-a', 'plugin-a', signal())).toEqual(code('retry'));
  });

  it('rolls back deletion and replacement when the signal aborts before commit', async () => {
    const old = key('test-previous-schema');
    await runtimeFileStore.write(old, blob('old'), signal(), [group()]);
    const controller = new AbortController();
    database.beforeCommit(() => controller.abort());
    await expect(runtimeFileStore.write(key(), blob('new'), controller.signal, undefined, group())).rejects.toThrow();
    expect([...database.rows.meta.keys()]).toEqual([old]);
    expect([...database.rows.bytes.keys()]).toEqual([old]);
  });

  it('keeps optional GUI persistence failures from deleting the previous code', async () => {
    await guiBundleCache.write('runtime-a', 'plugin-a', code('old'), signal());
    database.failRequest((operation) => operation.store === 'meta' && operation.method === 'put');
    await expect(guiBundleCache.write('runtime-a', 'plugin-a', code('new'), signal())).resolves.toBeUndefined();
    expect(await guiBundleCache.read('runtime-a', 'plugin-a', signal())).toEqual(code('old'));
  });

  it('preserves ordinary shared tags unless replacement is explicitly requested', async () => {
    await runtimeFileStore.write('first', new Blob(['one']), signal(), ['shared']);
    await runtimeFileStore.write('second', new Blob(['two']), signal(), ['shared']);
    await runtimeFileStore.write('second', new Blob(['updated']), signal(), ['extra']);
    expect(database.rows.meta.get('second')).toMatchObject({ tags: ['shared', 'extra'] });
    expect(await (await runtimeFileStore.read('first', signal()))?.text()).toBe('one');
  });

  it('removes replacement entries before calculating the shared count budget', async () => {
    // At the 128-entry budget, replacing one old ABI must not evict an unrelated
    // older image merely because both ABI keys were counted during the write.
    for (let index = 0; index < 127; index++) {
      const image = `image-${index}`;
      database.rows.meta.set(image, { key: image, size: 1, mime: 'image/png', used: index });
      database.rows.bytes.set(image, new Uint8Array([index]).buffer);
    }
    const old = key('test-previous-schema');
    await runtimeFileStore.write(old, blob('old'), signal(), [group()]);
    await guiBundleCache.write('runtime-a', 'plugin-a', code('new'), signal());
    expect(database.rows.meta.size).toBe(128);
    expect(database.rows.bytes.size).toBe(128);
    expect(database.rows.meta.has('image-0')).toBe(true);
    expect(database.rows.bytes.has('image-0')).toBe(true);
    expect(database.rows.meta.has(old)).toBe(false);
  });
});
