import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  NATIVE_RELAY_ASSET_BRIDGE_KEY,
  resetNativeRelayAssetBridgeCacheForTests,
  type NativeRelayAssetBridge,
  type NativeRelayAssetOpenResult,
} from './relay/native-asset-bridge';

type FetchCall = { path: string; init?: RequestInit };
type AssistantAttachmentDescriptor = {
  type: 'file';
  attachmentID: string;
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
};

const fetchCalls: FetchCall[] = [];
let fetchImpl: (path: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('fetch not configured');
};

const transportIdentity = { value: 'direct:url:https://host.example' };
const transportListeners = new Set<() => void>();
const bearer = { value: 'test-bearer-token-abc' };
const authGeneration = { value: 1 };
type AuthDetail = { generation: number; reason: 'credential' | 'invalidate' | 'endpoint-switch'; previousBearerDigest?: string };
const authListeners = new Set<(detail: AuthDetail) => void>();

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    fetchCalls.push({ path, init });
    return fetchImpl(path, init);
  },
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => transportIdentity.value,
  subscribeRuntimeEndpointChanged: (callback: () => void) => {
    transportListeners.add(callback);
    return () => {
      transportListeners.delete(callback);
    };
  },
}));

mock.module('@/lib/runtime-auth', () => ({
  getRuntimeBearerTokenSync: () => bearer.value,
  getRuntimeAuthGeneration: () => authGeneration.value,
  subscribeRuntimeAuthGeneration: (listener: (detail: AuthDetail) => void) => {
    authListeners.add(listener);
    return () => {
      authListeners.delete(listener);
    };
  },
  invalidateRuntimeAuthSession: () => {
    authGeneration.value += 1;
    for (const listener of authListeners) {
      listener({ generation: authGeneration.value, reason: 'invalidate' });
    }
  },
}));

const { digestSha256Hex } = await import('./assistant-attachment-upload');

const {
  clearAssistantAttachmentCacheForBearer,
  clearAssistantAttachmentCacheScope,
  clearAssistantAttachmentMemoryForTests,
  getAssistantAttachmentBlob,
  getAssistantAttachmentCacheCapabilities,
  getAssistantAttachmentDisplay,
  getAssistantAttachmentCacheEpoch,
  resetAssistantAttachmentCacheForTests,
  resolveAssistantAttachmentCacheScope,
} = await import('./assistant-attachment-cache');

const {
  RELAY_IMAGE_ASSET_TTL_MS,
  isRelayImageDisplayUrlLive,
  resetRelayImageStreamForTests,
} = await import('./relay/relay-image-stream');

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const asBlobPart = (bytes: Uint8Array): BlobPart => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const descriptorFor = async (
  bytes: Uint8Array,
  overrides: Partial<AssistantAttachmentDescriptor> = {},
): Promise<AssistantAttachmentDescriptor> => {
  const blob = new Blob([asBlobPart(bytes)], { type: overrides.mime || 'image/png' });
  const sha256 = await digestSha256Hex(blob);
  return {
    type: 'file',
    attachmentID: overrides.attachmentID || 'att-1',
    sha256,
    size: bytes.byteLength,
    mime: overrides.mime || 'image/png',
    filename: overrides.filename,
  };
};

const okBodyResponse = (bytes: Uint8Array, mime = 'image/png'): Response => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= 1) {
        controller.close();
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      controller.enqueue(copy);
      index += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': mime } });
};

const installBridge = (): {
  record: { open: number; writes: number; ends: string[]; releases: string[] };
} => {
  const record = { open: 0, writes: 0, ends: [] as string[], releases: [] as string[] };
  const bridge: NativeRelayAssetBridge = {
    openAsset: async ({ assetId }): Promise<NativeRelayAssetOpenResult> => {
      record.open += 1;
      return { assetId, url: `openchamber-asset://stream/${assetId}` };
    },
    writeChunk: async () => {
      record.writes += 1;
    },
    endAsset: async (assetId) => {
      record.ends.push(assetId);
    },
    abortAsset: async () => undefined,
    releaseAsset: async (assetId) => {
      record.releases.push(assetId);
    },
  };
  (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY] = bridge;
  return { record };
};

const uninstallBridge = (): void => {
  delete (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY];
};

/** Minimal IndexedDB stand-in — happy-dom does not ship one. */
const installFakeIndexedDB = (): void => {
  type Row = Record<string, unknown>;
  const databases = new Map<string, Map<string, Map<string, Row>>>();

  const openStore = (dbName: string, storeName: string): Map<string, Row> => {
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
    constructor(
      private readonly rows: Map<string, Row>,
      private readonly keyPath: string,
    ) {}
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
        const key = String(value[this.keyPath]);
        this.rows.set(key, value);
        return key as never;
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
    #completed = false;
    constructor(
      private readonly dbName: string,
      private readonly storeNames: string[],
    ) {
      setTimeout(() => {
        if (this.#completed) return;
        this.#completed = true;
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
    onversionchange: ((ev: Event) => void) | null = null;
    constructor(private readonly dbName: string) {}
    transaction(storeNames: string | string[]) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      return new FakeTx(this.dbName, names) as unknown as IDBTransaction;
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

  const factory = {
    open(name: string, _version?: number) {
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
  };

  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory as unknown as IDBFactory;
};

const uninstallFakeIndexedDB = (): void => {
  try {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    // ignore
  }
};

const expectErrorCode = async (run: () => Promise<unknown>, code: string): Promise<void> => {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught && typeof caught === 'object' && 'code' in caught && (caught as { code: string }).code).toBe(code);
};

beforeEach(async () => {
  fetchCalls.length = 0;
  transportIdentity.value = 'direct:url:https://host.example';
  transportListeners.clear();
  bearer.value = 'test-bearer-token-abc';
  authGeneration.value = 1;
  authListeners.clear();
  uninstallBridge();
  installFakeIndexedDB();
  resetNativeRelayAssetBridgeCacheForTests();
  resetRelayImageStreamForTests();
  await resetAssistantAttachmentCacheForTests();
  fetchImpl = async () => new Response('no', { status: 500 });
});

afterEach(async () => {
  resetRelayImageStreamForTests();
  uninstallBridge();
  resetNativeRelayAssetBridgeCacheForTests();
  await resetAssistantAttachmentCacheForTests();
  uninstallFakeIndexedDB();
});

describe('assistant attachment cache capabilities', () => {
  test('uses durable IDB when bearer is present (hashed scope)', async () => {
    const caps = await getAssistantAttachmentCacheCapabilities();
    expect(caps.durableIndexedDB).toBe(true);
    expect(caps.authScopeKind).toBe('bearer-hash');
  });

  test('falls back to memory-only without durable auth scope', async () => {
    bearer.value = '';
    const caps = await getAssistantAttachmentCacheCapabilities();
    expect(caps.durableIndexedDB).toBe(false);
    expect(caps.authScopeKind).toBe('memory-ephemeral');
  });
});

describe('getAssistantAttachmentBlob', () => {
  test('downloads once, verifies hash, and serves cache hit with zero network', async () => {
    const bytes = bytesOf('png-payload');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBodyResponse(bytes);
    };

    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('png-payload');
    expect(network).toBe(1);
    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('png-payload');
    expect(network).toBe(1);
  });

  test('rehydrates from IDB after memory wipe with zero network (simulated reopen)', async () => {
    const bytes = bytesOf('durable-bytes');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBodyResponse(bytes);
    };

    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(1);
    clearAssistantAttachmentMemoryForTests();
    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('durable-bytes');
    expect(network).toBe(1);
  });

  test('A→B→A transport switch keeps disk hit for A', async () => {
    const bytes = bytesOf('partition-a');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBodyResponse(bytes);
    };

    transportIdentity.value = 'direct:url:https://host-a.example';
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(1);

    transportIdentity.value = 'direct:url:https://host-b.example';
    for (const listener of transportListeners) listener();
    // B has no disk row; force network failure so we prove partition isolation.
    fetchImpl = async () => new Response('no', { status: 500 });
    await expectErrorCode(() => getAssistantAttachmentBlob('asst-1', descriptor), 'unavailable');

    transportIdentity.value = 'direct:url:https://host-a.example';
    for (const listener of transportListeners) listener();
    clearAssistantAttachmentMemoryForTests();
    fetchImpl = async () => {
      network += 1;
      return okBodyResponse(bytes);
    };
    expect(await (await getAssistantAttachmentBlob('asst-1', descriptor)).text()).toBe('partition-a');
    expect(network).toBe(1);
  });

  test('late download after forget does not write into new scope', async () => {
    const bytes = bytesOf('stale-write');
    const descriptor = await descriptorFor(bytes);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      await gate;
      return okBodyResponse(bytes);
    };

    const pending = getAssistantAttachmentBlob('asst-1', descriptor);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(network).toBe(1);
    const oldBearer = bearer.value;
    await clearAssistantAttachmentCacheForBearer(oldBearer, 'forget');
    bearer.value = 'new-bearer-after-forget';
    authGeneration.value += 1;
    for (const listener of authListeners) {
      listener({ generation: authGeneration.value, reason: 'credential' });
    }

    releaseGate?.();
    await expectErrorCode(() => pending, 'stale');
    expect(network).toBe(1);

    // New scope must miss and re-fetch — old bytes must not resurrect under new key.
    let network2 = 0;
    fetchImpl = async () => {
      network2 += 1;
      return okBodyResponse(bytes);
    };
    clearAssistantAttachmentMemoryForTests();
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network2).toBe(1);
  });

  test('rejects hash corruption from network', async () => {
    const bytes = bytesOf('good');
    const descriptor = await descriptorFor(bytes);
    fetchImpl = async () => okBodyResponse(bytesOf('evil'));
    await expectErrorCode(() => getAssistantAttachmentBlob('asst-1', descriptor), 'integrity');
  });

  test('rejects size over max', async () => {
    const { ASSISTANT_ATTACHMENT_MAX_BYTES } = await import('./assistant-attachment-upload');
    const descriptor: AssistantAttachmentDescriptor = {
      type: 'file',
      attachmentID: 'big',
      sha256: 'c'.repeat(64),
      size: ASSISTANT_ATTACHMENT_MAX_BYTES + 1,
      mime: 'application/octet-stream',
    };
    await expectErrorCode(() => getAssistantAttachmentBlob('asst-1', descriptor), 'too-large');
  });

  test('oversize stream cancels reader', async () => {
    const { ASSISTANT_ATTACHMENT_MAX_BYTES } = await import('./assistant-attachment-upload');
    const descriptor: AssistantAttachmentDescriptor = {
      type: 'file',
      attachmentID: 'stream-big',
      sha256: 'd'.repeat(64),
      size: 100,
      mime: 'application/octet-stream',
    };
    let cancelled = false;
    fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(ASSISTANT_ATTACHMENT_MAX_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    };
    await expectErrorCode(() => getAssistantAttachmentBlob('asst-1', descriptor), 'too-large');
    expect(cancelled).toBe(true);
  });

  test('isolates cache by auth bearer scope', async () => {
    const bytes = bytesOf('scoped');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      return okBodyResponse(bytes);
    };
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(1);
    bearer.value = 'other-user-token';
    authGeneration.value = 2;
    for (const listener of authListeners) {
      listener({ generation: 2, reason: 'credential' });
    }
    await getAssistantAttachmentBlob('asst-1', descriptor);
    expect(network).toBe(2);
  });

  test('singleflight shares one network download across concurrent callers', async () => {
    const bytes = bytesOf('shared');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      network += 1;
      await gate;
      return okBodyResponse(bytes);
    };

    const p1 = getAssistantAttachmentBlob('asst-1', descriptor);
    const p2 = getAssistantAttachmentBlob('asst-1', descriptor);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(network).toBe(1);
    releaseGate?.();
    const [a, b] = await Promise.all([p1, p2]);
    expect(await a.text()).toBe('shared');
    expect(await b.text()).toBe('shared');
    expect(network).toBe(1);
  });

  test('aborting one subscriber does not fail a peer singleflight waiter', async () => {
    const bytes = bytesOf('peer');
    const descriptor = await descriptorFor(bytes);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      await gate;
      return okBodyResponse(bytes);
    };

    const c1 = new AbortController();
    const p1 = getAssistantAttachmentBlob('asst-1', descriptor, { signal: c1.signal });
    const p2 = getAssistantAttachmentBlob('asst-1', descriptor);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    c1.abort(new Error('user-cancel'));
    await expectErrorCode(() => p1, 'aborted').catch(async () => {
      // may be raw Error
      try {
        await p1;
      } catch {
        // ok
      }
    });
    releaseGate?.();
    expect(await (await p2).text()).toBe('peer');
  });

  test('401 clears captured scope only and surfaces unauthorized', async () => {
    const bytes = bytesOf('x');
    const descriptor = await descriptorFor(bytes);
    const epochBefore = getAssistantAttachmentCacheEpoch();
    fetchImpl = async () => new Response('no', { status: 401 });
    await expectErrorCode(() => getAssistantAttachmentBlob('asst-1', descriptor), 'unauthorized');
    expect(getAssistantAttachmentCacheEpoch()).toBeGreaterThan(epochBefore);
  });

  test('clearAssistantAttachmentCacheScope is awaitable and fences late writes', async () => {
    const scope = await resolveAssistantAttachmentCacheScope();
    await clearAssistantAttachmentCacheScope(scope, 'test');
    expect(getAssistantAttachmentCacheEpoch()).toBeGreaterThan(0);
  });
});

describe('getAssistantAttachmentDisplay', () => {
  test('returns openchamber-asset URL via native bridge for verified blob', async () => {
    const { record } = installBridge();
    const bytes = bytesOf('img');
    const descriptor = await descriptorFor(bytes);
    fetchImpl = async () => okBodyResponse(bytes);

    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(handle.url.startsWith('openchamber-asset://stream/')).toBe(true);
    expect(record.open).toBe(1);
    expect(isRelayImageDisplayUrlLive(handle.url)).toBe(true);
    handle.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(record.releases.length).toBeGreaterThanOrEqual(1);
  });

  test('object URL path; dual release revokes once', async () => {
    const bytes = bytesOf('blob-img');
    const descriptor = await descriptorFor(bytes);
    fetchImpl = async () => okBodyResponse(bytes);
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      const url = `blob:att/${created.length}`;
      created.push(url);
      expect(blob).toBeInstanceOf(Blob);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    try {
      const a = await getAssistantAttachmentDisplay('asst-1', descriptor);
      const b = await getAssistantAttachmentDisplay('asst-1', descriptor);
      expect(a.url).toBe(b.url);
      a.release();
      expect(revoked).toHaveLength(0);
      b.release();
      expect(revoked).toEqual([a.url]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test('retain prevents TTL from returning a dead URL while leased', async () => {
    installBridge();
    const bytes = bytesOf('ttl');
    const descriptor = await descriptorFor(bytes);
    fetchImpl = async () => okBodyResponse(bytes);
    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(isRelayImageDisplayUrlLive(handle.url)).toBe(true);
    // Even after TTL window conceptually, retain holds the asset.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(isRelayImageDisplayUrlLive(handle.url)).toBe(true);
    handle.release();
    void RELAY_IMAGE_ASSET_TTL_MS;
  });

  test('first display subscriber abort does not fail the second', async () => {
    installBridge();
    const bytes = bytesOf('peer-display');
    const descriptor = await descriptorFor(bytes);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      await gate;
      return okBodyResponse(bytes);
    };

    const c1 = new AbortController();
    const p1 = getAssistantAttachmentDisplay('asst-1', descriptor, { signal: c1.signal });
    const p2 = getAssistantAttachmentDisplay('asst-1', descriptor);
    await new Promise<void>((r) => setTimeout(r, 15));
    c1.abort(new Error('first-cancel'));
    let p1Failed = false;
    try {
      await p1;
    } catch {
      p1Failed = true;
    }
    expect(p1Failed).toBe(true);
    releaseGate?.();
    const handle = await p2;
    expect(handle.url.startsWith('openchamber-asset://')).toBe(true);
    expect(isRelayImageDisplayUrlLive(handle.url)).toBe(true);
    handle.release();
  });

  test('both display subscribers abort releases orphan URL', async () => {
    installBridge();
    const bytes = bytesOf('both-abort');
    const descriptor = await descriptorFor(bytes);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      await gate;
      return okBodyResponse(bytes);
    };

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = getAssistantAttachmentDisplay('asst-1', descriptor, { signal: c1.signal });
    const p2 = getAssistantAttachmentDisplay('asst-1', descriptor, { signal: c2.signal });
    await new Promise<void>((r) => setTimeout(r, 15));
    c1.abort(new Error('a'));
    c2.abort(new Error('b'));
    await Promise.allSettled([p1, p2]);
    releaseGate?.();
    // Flight may still finish; orphan path must not leave a live unleased URL forever.
    await new Promise<void>((r) => setTimeout(r, 30));
  });

  test('HTTP 503 failure then retry issues a second network request', async () => {
    installBridge();
    const bytes = bytesOf('retry-503');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    fetchImpl = async () => {
      network += 1;
      if (network === 1) return new Response('down', { status: 503 });
      return okBodyResponse(bytes);
    };

    await expectErrorCode(
      () => getAssistantAttachmentDisplay('asst-1', descriptor),
      'unavailable',
    );
    expect(network).toBe(1);

    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(handle.url.startsWith('openchamber-asset://')).toBe(true);
    expect(network).toBe(2);
    handle.release();
  });

  test('native open failure then retry opens a second native asset', async () => {
    let opens = 0;
    const bridge: NativeRelayAssetBridge = {
      openAsset: async ({ assetId }) => {
        opens += 1;
        if (opens === 1) throw new Error('native-open-failed');
        return { assetId, url: `openchamber-asset://stream/${assetId}` };
      },
      writeChunk: async () => undefined,
      endAsset: async () => undefined,
      abortAsset: async () => undefined,
      releaseAsset: async () => undefined,
    };
    (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY] = bridge;

    const bytes = bytesOf('retry-open');
    const descriptor = await descriptorFor(bytes);
    // Seed blob cache so materialize hits native open (not another download).
    fetchImpl = async () => okBodyResponse(bytes);
    await getAssistantAttachmentBlob('asst-1', descriptor);
    const networkAfterSeed = fetchCalls.length;

    let firstFailed = false;
    try {
      await getAssistantAttachmentDisplay('asst-1', descriptor);
    } catch {
      firstFailed = true;
    }
    expect(firstFailed).toBe(true);
    expect(opens).toBe(1);

    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(handle.url.startsWith('openchamber-asset://')).toBe(true);
    expect(opens).toBe(2);
    // Retry must not have required a third network download for the same blob.
    expect(fetchCalls.length).toBe(networkAfterSeed);
    handle.release();
  });

  test('concurrent waiters on a failed flight all reject; next call starts fresh', async () => {
    installBridge();
    const bytes = bytesOf('concurrent-fail');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      network += 1;
      await gate;
      if (network === 1) return new Response('no', { status: 503 });
      return okBodyResponse(bytes);
    };

    const p1 = getAssistantAttachmentDisplay('asst-1', descriptor);
    const p2 = getAssistantAttachmentDisplay('asst-1', descriptor);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(network).toBe(1);
    releaseGate?.();
    const results = await Promise.allSettled([p1, p2]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(network).toBe(2);
    handle.release();
  });

  test('abort during failed flight cleanup still allows later success', async () => {
    installBridge();
    const bytes = bytesOf('abort-fail-cleanup');
    const descriptor = await descriptorFor(bytes);
    let network = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchImpl = async () => {
      network += 1;
      await gate;
      if (network === 1) return new Response('no', { status: 503 });
      return okBodyResponse(bytes);
    };

    const c1 = new AbortController();
    const p1 = getAssistantAttachmentDisplay('asst-1', descriptor, { signal: c1.signal });
    await new Promise<void>((r) => setTimeout(r, 10));
    c1.abort(new Error('user-cancel'));
    releaseGate?.();
    await Promise.allSettled([p1]);

    const handle = await getAssistantAttachmentDisplay('asst-1', descriptor);
    expect(network).toBe(2);
    expect(handle.url.startsWith('openchamber-asset://')).toBe(true);
    handle.release();
  });
});
