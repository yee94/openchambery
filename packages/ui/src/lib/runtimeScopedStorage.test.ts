import { afterEach, describe, expect, test } from 'bun:test';
import { switchRuntimeEndpoint } from './runtime-switch';
import {
  createRuntimeScopedJSONStorage,
  isRuntimeScopedStorageEventKey,
  mayReadLegacyUnscopedStorage,
  readRuntimeScopedItem,
  runtimeScopedStorageKey,
  writeRuntimeScopedItem,
} from './runtimeScopedStorage';

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

describe('runtimeScopedStorage', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('isolates theme keys across local and remote transports on a shared origin', () => {
    const storage = createMemoryStorage();
    cleanups.push(installWindow({
      apiBaseUrl: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
      storage,
    }));

    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    writeRuntimeScopedItem('themeMode', 'dark', { storage });
    writeRuntimeScopedItem('sidebar-brand', 'LOCAL BRAND', { storage });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    // Shared unscoped leftovers from the local window must not apply remotely.
    storage.setItem('themeMode', 'dark');
    storage.setItem('sidebar-brand', 'LOCAL BRAND');
    expect(readRuntimeScopedItem('themeMode', { storage })).toBeNull();
    expect(readRuntimeScopedItem('sidebar-brand', { storage })).toBeNull();

    writeRuntimeScopedItem('themeMode', 'light', { storage });
    writeRuntimeScopedItem('sidebar-brand', 'REMOTE BRAND', { storage });

    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    expect(readRuntimeScopedItem('themeMode', { storage })).toBe('dark');
    expect(readRuntimeScopedItem('sidebar-brand', { storage })).toBe('LOCAL BRAND');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    expect(readRuntimeScopedItem('themeMode', { storage })).toBe('light');
    expect(readRuntimeScopedItem('sidebar-brand', { storage })).toBe('REMOTE BRAND');
  });

  test('local runtime may fall back to legacy unscoped keys', () => {
    const storage = createMemoryStorage();
    cleanups.push(installWindow({
      apiBaseUrl: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
      storage,
    }));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    storage.setItem('themeMode', 'system');
    expect(mayReadLegacyUnscopedStorage()).toBe(true);
    expect(readRuntimeScopedItem('themeMode', { storage })).toBe('system');
  });

  test('remote runtime never falls back to legacy unscoped keys', () => {
    const storage = createMemoryStorage();
    cleanups.push(installWindow({
      apiBaseUrl: 'https://remote.example',
      localOrigin: 'http://127.0.0.1:57123',
      storage,
    }));
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    storage.setItem('themeMode', 'dark');
    expect(mayReadLegacyUnscopedStorage()).toBe(false);
    expect(readRuntimeScopedItem('themeMode', { storage })).toBeNull();
  });

  test('storage event matching is transport-scoped', () => {
    cleanups.push(installWindow({
      apiBaseUrl: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
    }));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    const localKey = runtimeScopedStorageKey('themeMode');
    expect(isRuntimeScopedStorageEventKey(localKey, 'themeMode')).toBe(true);
    expect(isRuntimeScopedStorageEventKey('themeMode', 'themeMode')).toBe(false);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    expect(isRuntimeScopedStorageEventKey(localKey, 'themeMode')).toBe(false);
    expect(isRuntimeScopedStorageEventKey(runtimeScopedStorageKey('themeMode'), 'themeMode')).toBe(true);
  });

  test('scoped store names differ by transport and adapter is constructible', () => {
    cleanups.push(installWindow({
      apiBaseUrl: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
    }));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    const localName = runtimeScopedStorageKey('sidebar-brand-store');
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    const remoteName = runtimeScopedStorageKey('sidebar-brand-store');
    expect(localName).not.toBe(remoteName);
    expect(localName.endsWith('.sidebar-brand-store')).toBe(true);
    expect(remoteName.endsWith('.sidebar-brand-store')).toBe(true);
    // Adapter construction uses process-wide safeStorage; isolation is covered by key tests above.
    expect(createRuntimeScopedJSONStorage()).toBeDefined();
  });
});
