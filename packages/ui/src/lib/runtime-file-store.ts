// Persistent complete file bodies. Copy existing image data before opening the
// Yuri database; runtime-file-resource owns authorization and leases.
import { migrateBrandIndexedDB } from './brand-storage-migration';

const DATABASE = 'yuri-runtime-images';
const MAX_ENTRIES = 128;
const MAX_BYTES = 256 * 1024 * 1024;
type Metadata = { key: string; size: number; mime: string; used: number; tags?: string[] };
let tail: Promise<unknown> = Promise.resolve();

const open = async (): Promise<IDBDatabase> => {
  await migrateBrandIndexedDB(DATABASE);
  return new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
  const request = indexedDB.open(DATABASE, 1);
  let failed = false;
  request.onupgradeneeded = () => {
    request.result.createObjectStore('meta', { keyPath: 'key' });
    request.result.createObjectStore('bytes');
  };
  request.onerror = request.onblocked = () => { failed = true; reject(new Error('Image database unavailable')); };
  request.onsuccess = () => {
    if (failed) { request.result.close(); return; }
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  });
};

const requestValue = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transaction = <T>(action: (meta: IDBObjectStore, bytes: IDBObjectStore) => Promise<T>, signal?: AbortSignal): Promise<T> => {
  const run = tail.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    const database = await open();
    try {
      signal?.throwIfAborted();
      const tx = database.transaction(['meta', 'bytes'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch { /* Already complete. */ } };
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Image transaction aborted'));
      });
      // Observe failures even when the action itself fails before awaiting commit.
      void done.catch(() => {});
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await action(tx.objectStore('meta'), tx.objectStore('bytes'));
        await done;
        return result;
      } catch (error) { abort(); await done.catch(() => {}); throw error; }
      finally { signal?.removeEventListener('abort', abort); }
    } finally { database.close(); }
  });
  tail = run;
  return run;
};

export const runtimeFileStore = {
  read: (key: string, signal: AbortSignal): Promise<Blob | null> => transaction(async (meta, bytes) => {
    const entry = await requestValue<Metadata | undefined>(meta.get(key));
    if (!entry) return null;
    const value = await requestValue<ArrayBuffer | undefined>(bytes.get(key));
    if (!(value instanceof ArrayBuffer) || value.byteLength !== entry.size) {
      meta.delete(key); bytes.delete(key); return null;
    }
    meta.put({ ...entry, used: Date.now() });
    return new Blob([value], { type: entry.mime });
  }, signal),
  write: async (key: string, blob: Blob, signal: AbortSignal, tags?: string[], replaceTag?: string): Promise<void> => {
    const value = await blob.arrayBuffer();
    signal.throwIfAborted();
    if (value.byteLength > 32 * 1024 * 1024) throw new Error('File exceeds complete-body cache budget');
    await transaction(async (meta, bytes) => {
      const entries = (await requestValue<Metadata[]>(meta.getAll())).filter((entry) => {
        if (entry.key === key) return false;
        if (replaceTag !== undefined && entry.tags?.includes(replaceTag)) {
          meta.delete(entry.key); bytes.delete(entry.key);
          return false;
        }
        return true;
      })
        .sort((a, b) => a.used - b.used);
      let size = entries.reduce((total, entry) => total + entry.size, value.byteLength);
      let count = entries.length + 1;
      for (const entry of entries) {
        if (size <= MAX_BYTES && count <= MAX_ENTRIES) break;
        meta.delete(entry.key); bytes.delete(entry.key);
        size -= entry.size; count--;
      }
      bytes.put(value, key);
      const existing = await requestValue<Metadata | undefined>(meta.get(key));
      meta.put({ key, size: value.byteLength, mime: blob.type, used: Date.now(), tags: [...new Set([...(existing?.tags ?? []), ...(tags ?? []), ...(replaceTag === undefined ? [] : [replaceTag])])] } satisfies Metadata);
    }, signal);
  },
  clear: (): Promise<void> => transaction(async (meta, bytes) => { meta.clear(); bytes.clear(); }),
  tag: (key: string, tags: string[], signal: AbortSignal): Promise<void> => transaction(async (meta) => {
    const entry = await requestValue<Metadata | undefined>(meta.get(key));
    if (entry) meta.put({ ...entry, tags: [...new Set([...(entry.tags ?? []), ...tags])] });
  }, signal),
  clearTag: (tag: string): Promise<void> => transaction(async (meta, bytes) => {
    for (const entry of await requestValue<Metadata[]>(meta.getAll())) {
      if (entry.tags?.includes(tag)) { meta.delete(entry.key); bytes.delete(entry.key); }
    }
  }),
};
