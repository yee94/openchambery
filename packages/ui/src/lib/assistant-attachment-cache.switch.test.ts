/**
 * Integration: real runtime-switch + runtime-auth wiring with only runtimeFetch mocked.
 * Proves A→B→A durable hit under endpoint-switch auth reason (no disk wipe of A).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  resetNativeRelayAssetBridgeCacheForTests,
} from './relay/native-asset-bridge';

const fetchCalls: Array<{ path: string }> = [];
let fetchImpl: (path: string) => Promise<Response> = async () => new Response('no', { status: 500 });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string) => {
    fetchCalls.push({ path });
    return fetchImpl(path);
  },
}));

// Real modules — no mocks for switch/auth.
const {
  clearRuntimeAuthCredentialProvider,
  getRuntimeAuthGeneration,
  setRuntimeBearerToken,
  subscribeRuntimeAuthGeneration,
} = await import('./runtime-auth');

const { switchRuntimeEndpoint, getRuntimeTransportIdentity } = await import('./runtime-switch');

const { digestSha256Hex } = await import('./assistant-attachment-upload');

const {
  clearAssistantAttachmentCacheForBearer,
  clearAssistantAttachmentMemoryForTests,
  getAssistantAttachmentBlob,
  resetAssistantAttachmentCacheForTests,
} = await import('./assistant-attachment-cache');

const { resetRelayImageStreamForTests } = await import('./relay/relay-image-stream');

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const asBlobPart = (bytes: Uint8Array): BlobPart => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const okBody = (bytes: Uint8Array): Response => {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i++) {
        c.close();
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      c.enqueue(copy);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
};

const installFakeIndexedDB = (): void => {
  type Row = Record<string, unknown>;
  const databases = new Map<string, Map<string, Map<string, Row>>>();
  const openStore = (dbName: string, storeName: string) => {
    if (!databases.has(dbName)) databases.set(dbName, new Map());
    const db = databases.get(dbName)!;
    if (!db.has(storeName)) db.set(storeName, new Map());
    return db.get(storeName)!;
  };
  const requestOf = <T>(run: () => T): IDBRequest<T> => {
    const request = {
      result: undefined as unknown as T,
      error: null as DOMException | null,
      onsuccess: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onupgradeneeded: null as ((ev: Event) => void) | null,
      onblocked: null as ((ev: Event) => void) | null,
    };
    try {
      request.result = run();
      Promise.resolve().then(() => request.onsuccess?.(new Event('success')));
    } catch (error) {
      request.error = error as DOMException;
      Promise.resolve().then(() => request.onerror?.(new Event('error')));
    }
    return request as unknown as IDBRequest<T>;
  };
  class FakeIndex {
    constructor(private readonly rows: Map<string, Row>, private readonly field: string) {}
    openCursor() {
      const sorted = [...this.rows.values()].sort(
        (a, b) => Number(a[this.field] ?? 0) - Number(b[this.field] ?? 0),
      );
      let i = 0;
      const request = {
        result: null as unknown,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
      };
      const advance = () => {
        if (i >= sorted.length) {
          request.result = null;
          request.onsuccess?.(new Event('success'));
          return;
        }
        const value = sorted[i++]!;
        request.result = {
          value,
          continue: () => {
            Promise.resolve().then(advance);
          },
        };
        request.onsuccess?.(new Event('success'));
      };
      Promise.resolve().then(advance);
      return request as unknown as IDBRequest;
    }
  }
  class FakeStore {
    constructor(private readonly rows: Map<string, Row>, private readonly keyPath: string) {}
    get(key: IDBValidKey) {
      return requestOf(() => this.rows.get(String(key)) as never);
    }
    getAll() {
      return requestOf(() => Array.from(this.rows.values()) as never);
    }
    getAllKeys() {
      return requestOf(() => Array.from(this.rows.keys()) as never);
    }
    put(value: Row) {
      return requestOf(() => {
        this.rows.set(String(value[this.keyPath]), value);
        return String(value[this.keyPath]) as never;
      });
    }
    delete(key: IDBValidKey) {
      return requestOf(() => {
        this.rows.delete(String(key));
        return undefined as never;
      });
    }
    clear() {
      return requestOf(() => {
        this.rows.clear();
        return undefined as never;
      });
    }
    createIndex(name: string) {
      return new FakeIndex(this.rows, name) as unknown as IDBIndex;
    }
    index(name: string) {
      return new FakeIndex(this.rows, name);
    }
  }
  class FakeTx {
    oncomplete: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onabort: ((ev: Event) => void) | null = null;
    error: DOMException | null = null;
    #done = false;
    constructor(private readonly dbName: string) {
      setTimeout(() => {
        if (this.#done) return;
        this.#done = true;
        this.oncomplete?.(new Event('complete'));
      }, 0);
    }
    objectStore(name: string) {
      return new FakeStore(openStore(this.dbName, name), 'key');
    }
  }
  class FakeDB {
    objectStoreNames = {
      contains: (name: string) => name === 'meta' || name === 'data' || name === 'blobs',
    };
    constructor(private readonly dbName: string) {}
    transaction(storeNames: string | string[]) {
      void storeNames;
      return new FakeTx(this.dbName) as unknown as IDBTransaction;
    }
    createObjectStore(name: string, options?: IDBObjectStoreParameters) {
      openStore(this.dbName, name);
      return new FakeStore(openStore(this.dbName, name), String(options?.keyPath || 'key')) as unknown as IDBObjectStore;
    }
    deleteObjectStore(name: string) {
      databases.get(this.dbName)?.delete(name);
    }
    close() {}
  }
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = {
    open(name: string) {
      const request = {
        result: undefined as unknown as IDBDatabase,
        error: null as DOMException | null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
        onupgradeneeded: null as ((ev: Event) => void) | null,
        onblocked: null as ((ev: Event) => void) | null,
      };
      Promise.resolve().then(() => {
        const db = new FakeDB(name);
        request.result = db as unknown as IDBDatabase;
        request.onupgradeneeded?.({} as IDBVersionChangeEvent);
        request.onsuccess?.(new Event('success'));
      });
      return request as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(name: string) {
      databases.delete(name);
      return requestOf(() => undefined as never) as unknown as IDBOpenDBRequest;
    },
  } as IDBFactory;
};

beforeEach(async () => {
  fetchCalls.length = 0;
  installFakeIndexedDB();
  // Minimal window so endpoint-changed CustomEvent + listeners work.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: globalThis.addEventListener?.bind(globalThis) ?? (() => undefined),
      removeEventListener: globalThis.removeEventListener?.bind(globalThis) ?? (() => undefined),
      dispatchEvent: (event: Event) => {
        // happy-dom / node: fan out via EventTarget if available
        if (typeof EventTarget !== 'undefined') {
          return (globalThis as unknown as EventTarget).dispatchEvent?.(event) ?? true;
        }
        return true;
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  // Use EventTarget for real fanout
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });

  resetNativeRelayAssetBridgeCacheForTests();
  resetRelayImageStreamForTests();
  await resetAssistantAttachmentCacheForTests();
  clearRuntimeAuthCredentialProvider();
  // Seed runtime A
  switchRuntimeEndpoint({
    apiBaseUrl: 'https://host-a.example',
    clientToken: 'token-a-stable',
    runtimeKey: 'runtime-a',
  });
  fetchImpl = async () => new Response('no', { status: 500 });
});

afterEach(async () => {
  resetRelayImageStreamForTests();
  resetNativeRelayAssetBridgeCacheForTests();
  await resetAssistantAttachmentCacheForTests();
  clearRuntimeAuthCredentialProvider();
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe('real switchRuntimeEndpoint + attachment cache', () => {
  test('A→B→A with different bearers keeps disk hit (zero re-download)', async () => {
    const bytes = bytesOf('persist-a');
    const blob = new Blob([asBlobPart(bytes)], { type: 'image/png' });
    const sha256 = await digestSha256Hex(blob);
    const descriptor = {
      type: 'file' as const,
      attachmentID: 'att-a',
      sha256,
      size: bytes.byteLength,
      mime: 'image/png',
    };

    const authReasons: string[] = [];
    const stopAuth = subscribeRuntimeAuthGeneration((detail) => {
      authReasons.push(detail.reason);
    });

    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBody(bytes);
    };

    // Warm A
    expect(getRuntimeTransportIdentity()).toContain('host-a');
    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('persist-a');
    expect(network).toBe(1);

    // Switch to B (different bearer) — must publish endpoint-switch and not wipe A's disk
    switchRuntimeEndpoint({
      apiBaseUrl: 'https://host-b.example',
      clientToken: 'token-b-other',
      runtimeKey: 'runtime-b',
    });
    expect(authReasons).toContain('endpoint-switch');
    expect(getRuntimeTransportIdentity()).toContain('host-b');

    // B miss
    fetchImpl = async () => new Response('no', { status: 500 });
    let bFailed = false;
    try {
      await getAssistantAttachmentBlob('asst-1', descriptor);
    } catch {
      bFailed = true;
    }
    expect(bFailed).toBe(true);

    // Back to A — disk hit, no network
    switchRuntimeEndpoint({
      apiBaseUrl: 'https://host-a.example',
      clientToken: 'token-a-stable',
      runtimeKey: 'runtime-a',
    });
    clearAssistantAttachmentMemoryForTests();
    fetchImpl = async () => {
      network += 1;
      return okBody(bytes);
    };
    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('persist-a');
    expect(network).toBe(1);

    stopAuth();
  });

  test('forget still clears old bearer disk after switch', async () => {
    const bytes = bytesOf('forget-me');
    const blob = new Blob([asBlobPart(bytes)], { type: 'image/png' });
    const sha256 = await digestSha256Hex(blob);
    const descriptor = {
      type: 'file' as const,
      attachmentID: 'att-f',
      sha256,
      size: bytes.byteLength,
      mime: 'image/png',
    };

    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBody(bytes);
    };
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(1);

    const forgotten = 'token-a-stable';
    switchRuntimeEndpoint({
      apiBaseUrl: 'https://host-b.example',
      clientToken: 'token-b-other',
      runtimeKey: 'runtime-b',
    });
    await clearAssistantAttachmentCacheForBearer(forgotten, 'forget');

    // Return to A with same bearer — disk must be gone
    switchRuntimeEndpoint({
      apiBaseUrl: 'https://host-a.example',
      clientToken: forgotten,
      runtimeKey: 'runtime-a',
    });
    clearAssistantAttachmentMemoryForTests();
    fetchImpl = async () => {
      network += 1;
      return okBody(bytes);
    };
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(2);
  });

  test('explicit setRuntimeBearerToken (credential) still fires auth event', () => {
    const reasons: string[] = [];
    const stop = subscribeRuntimeAuthGeneration((d) => reasons.push(d.reason));
    const before = getRuntimeAuthGeneration();
    setRuntimeBearerToken(`explicit-${before}`);
    expect(reasons.at(-1)).toBe('credential');
    expect(getRuntimeAuthGeneration()).toBeGreaterThan(before);
    stop();
  });
});
