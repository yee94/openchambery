import { afterEach, describe, expect, test } from 'bun:test';
import { switchRuntimeEndpoint } from './runtime-switch';
import {
  createInstanceScopedJSONStorage,
  instanceScopedStorageKey,
  mayReadLegacyApiBaseUrlInstanceCache,
  mayReadLegacyUnscopedInstanceStorage,
  readInstanceScopedItem,
  writeInstanceScopedItem,
} from './instanceScopedStorage';

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
};

const installWindow = (options: {
  apiBaseUrl?: string;
  localOrigin?: string;
  storage?: Storage;
}) => {
  const storage = options.storage ?? createMemoryStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const runtimeWindow = {
    localStorage: storage,
    __OPENCHAMBER_API_BASE_URL__: options.apiBaseUrl,
    __OPENCHAMBER_LOCAL_ORIGIN__: options.localOrigin,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: runtimeWindow,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return () => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
};

const relayA = {
  relayUrl: 'wss://relay.example',
  serverId: 'server-a',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
};

const relayB = {
  ...relayA,
  serverId: 'server-b',
};

describe('instanceScopedStorage', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('isolates project cache across two relay instances that share the UI origin', () => {
    const storage = createMemoryStorage();
    cleanups.push(installWindow({
      apiBaseUrl: 'https://app.example',
      storage,
    }));

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
      relay: relayA,
    });
    writeInstanceScopedItem('projects', JSON.stringify([{ id: 'alpha' }]), { storage });
    writeInstanceScopedItem('projects:manualOrder', JSON.stringify(['alpha']), { storage });

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-b@wss://relay.example',
      relay: relayB,
    });
    expect(readInstanceScopedItem('projects', { storage })).toBeNull();
    expect(readInstanceScopedItem('projects:manualOrder', { storage })).toBeNull();
    writeInstanceScopedItem('projects', JSON.stringify([{ id: 'beta' }]), { storage });

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
      relay: relayA,
    });
    expect(JSON.parse(readInstanceScopedItem('projects', { storage }) ?? '[]')).toEqual([{ id: 'alpha' }]);
    expect(JSON.parse(readInstanceScopedItem('projects:manualOrder', { storage }) ?? '[]')).toEqual(['alpha']);
  });

  test('relay instances do not inherit unscoped or origin-namespaced legacy project keys', () => {
    const storage = createMemoryStorage();
    storage.setItem('projects', JSON.stringify([{ id: 'shared' }]));
    storage.setItem(`projects:${encodeURIComponent('https://app.example')}`, JSON.stringify([{ id: 'origin' }]));
    cleanups.push(installWindow({
      apiBaseUrl: 'https://app.example',
      storage,
    }));

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
      relay: relayA,
    });

    expect(mayReadLegacyUnscopedInstanceStorage()).toBe(false);
    expect(mayReadLegacyApiBaseUrlInstanceCache()).toBe(false);
    expect(readInstanceScopedItem('projects', { storage })).toBeNull();
  });

  test('local desktop still reads unscoped legacy keys', () => {
    const storage = createMemoryStorage();
    storage.setItem('projects', JSON.stringify([{ id: 'legacy' }]));
    cleanups.push(installWindow({
      apiBaseUrl: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
      storage,
    }));

    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    expect(mayReadLegacyUnscopedInstanceStorage()).toBe(true);
    expect(JSON.parse(readInstanceScopedItem('projects', { storage }) ?? '[]')).toEqual([{ id: 'legacy' }]);
  });

  test('direct url runtimes can read the old API-URL namespaced key', () => {
    const storage = createMemoryStorage();
    const api = 'http://192.168.1.20:8787';
    storage.setItem(`projects:${encodeURIComponent(api)}`, JSON.stringify([{ id: 'lan' }]));
    cleanups.push(installWindow({ apiBaseUrl: api, storage }));

    switchRuntimeEndpoint({ apiBaseUrl: api, runtimeKey: `url:${api}` });
    expect(mayReadLegacyApiBaseUrlInstanceCache()).toBe(true);
    expect(JSON.parse(readInstanceScopedItem('projects', { storage }) ?? '[]')).toEqual([{ id: 'lan' }]);
  });

  test('zustand persist storage writes distinct buckets per runtimeKey', () => {
    const storage = createMemoryStorage();
    cleanups.push(installWindow({
      apiBaseUrl: 'https://app.example',
      storage,
    }));
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });

    const persist = createInstanceScopedJSONStorage<{ projectSortOrder: string }>();
    expect(persist).toBeDefined();

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
      relay: relayA,
    });
    persist!.setItem('session-display-mode', {
      state: { projectSortOrder: 'a-z' },
      version: 4,
    });

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-b@wss://relay.example',
      relay: relayB,
    });
    expect(persist!.getItem('session-display-mode')).toBeNull();

    switchRuntimeEndpoint({
      apiBaseUrl: 'https://app.example',
      runtimeKey: 'relay:server-a@wss://relay.example',
      relay: relayA,
    });
    expect(persist!.getItem('session-display-mode')).toEqual({
      state: { projectSortOrder: 'a-z' },
      version: 4,
    });
    expect(storage.getItem(instanceScopedStorageKey('session-display-mode'))).not.toBeNull();
  });
});
