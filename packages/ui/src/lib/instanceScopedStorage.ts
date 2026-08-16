import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * Instance-scoped localStorage for data that belongs to one paired device /
 * OpenChamber host, not to a transport.
 *
 * `runtimeKey` is stable across LAN⇄relay for the same device. Mobile relay
 * instances share `window.location.origin` as the API base URL, so URL-keyed
 * or unscoped caches leak project order and other host-specific prefs.
 *
 * Transport-scoped appearance keys stay in `runtimeScopedStorage.ts`.
 *
 * Legacy unscoped / API-URL keys remain readable only for local desktop and
 * direct `url:*` runtimes. Relay instances never fall back to those shared
 * buckets.
 */

const SCOPE_PREFIX = 'oc.inst.';

const encodeInstance = (identity: string): string => {
  try {
    return btoa(unescape(encodeURIComponent(identity)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  } catch {
    return encodeURIComponent(identity);
  }
};

const resolveInstanceKey = (runtimeKey?: string): string => {
  const identity = (runtimeKey ?? getRuntimeKey()).trim();
  return identity.length > 0 ? identity : 'default';
};

const readLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const value = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
};

export const instanceScopedStorageKey = (
  baseKey: string,
  runtimeKey: string = getRuntimeKey(),
): string => `${SCOPE_PREFIX}${encodeInstance(resolveInstanceKey(runtimeKey))}.${baseKey}`;

const isRelayRuntimeKey = (runtimeKey: string = getRuntimeKey()): boolean =>
  resolveInstanceKey(runtimeKey).startsWith('relay:');

/**
 * Unscoped legacy keys are only safe for the local desktop / single-runtime
 * web bucket. Relay and remote `url:*` hosts must not inherit them.
 */
export const mayReadLegacyUnscopedInstanceStorage = (
  runtimeKey: string = getRuntimeKey(),
): boolean => {
  const identity = resolveInstanceKey(runtimeKey);
  if (identity === 'default' || identity === 'local') return true;
  if (isRelayRuntimeKey(identity)) return false;
  if (!identity.startsWith('url:')) return false;
  const localOrigin = readLocalOrigin();
  if (!localOrigin) return false;
  try {
    return new URL(identity.slice(4)).origin === new URL(localOrigin).origin;
  } catch {
    return false;
  }
};

/**
 * Pre-instance-scope project caches were namespaced by API base URL. Direct
 * connections keep a unique URL; relay instances share the UI origin and must
 * not read that bucket.
 */
export const mayReadLegacyApiBaseUrlInstanceCache = (
  runtimeKey: string = getRuntimeKey(),
): boolean => !isRelayRuntimeKey(runtimeKey);

const legacyApiBaseUrlStorageKey = (
  baseKey: string,
  apiBaseUrl: string = getRuntimeApiBaseUrl(),
): string | null => {
  const namespace = apiBaseUrl.trim().replace(/\/+$/, '');
  if (!namespace) return null;
  return `${baseKey}:${encodeURIComponent(namespace)}`;
};

export const readInstanceScopedItem = (
  baseKey: string,
  options?: {
    storage?: Pick<Storage, 'getItem'>;
    runtimeKey?: string;
  },
): string | null => {
  const storage = options?.storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null });
  const runtimeKey = options?.runtimeKey ?? getRuntimeKey();
  const scoped = storage.getItem(instanceScopedStorageKey(baseKey, runtimeKey));
  if (scoped !== null) return scoped;
  if (mayReadLegacyApiBaseUrlInstanceCache(runtimeKey)) {
    const legacyKey = legacyApiBaseUrlStorageKey(baseKey);
    const namespaced = legacyKey ? storage.getItem(legacyKey) : null;
    if (namespaced !== null) return namespaced;
  }
  if (!mayReadLegacyUnscopedInstanceStorage(runtimeKey)) return null;
  return storage.getItem(baseKey);
};

export const writeInstanceScopedItem = (
  baseKey: string,
  value: string,
  options?: {
    storage?: Pick<Storage, 'setItem'>;
    runtimeKey?: string;
  },
): void => {
  const storage = options?.storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : { setItem: () => undefined });
  const runtimeKey = options?.runtimeKey ?? getRuntimeKey();
  storage.setItem(instanceScopedStorageKey(baseKey, runtimeKey), value);
};

export const createInstanceScopedStorageAdapter = (
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => ({
  getItem: (key) => readInstanceScopedItem(key, { storage }),
  setItem: (key, value) => {
    writeInstanceScopedItem(key, value, { storage });
  },
  removeItem: (key) => {
    removeInstanceScopedItem(key, { storage });
  },
});

export const removeInstanceScopedItem = (
  baseKey: string,
  options?: {
    storage?: Pick<Storage, 'removeItem'>;
    runtimeKey?: string;
  },
): void => {
  const storage = options?.storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : { removeItem: () => undefined });
  const runtimeKey = options?.runtimeKey ?? getRuntimeKey();
  storage.removeItem(instanceScopedStorageKey(baseKey, runtimeKey));
};

type JsonStorageOptions = {
  reviver?: (key: string, value: unknown) => unknown;
  replacer?: (key: string, value: unknown) => unknown;
};

/**
 * Zustand persist storage namespaced by the current runtimeKey on every
 * get/set. Relay instances never fall back to the unscoped store name.
 */
export const createInstanceScopedJSONStorage = <S>(
  options?: JsonStorageOptions,
): PersistStorage<S> | undefined => {
  let storage: StateStorage;
  try {
    storage = getSafeStorage();
  } catch {
    return undefined;
  }

  const parse = (value: string | null): StorageValue<S> | null => {
    if (value === null) return null;
    return JSON.parse(value, options?.reviver) as StorageValue<S>;
  };

  const readRaw = (key: string): string | null | Promise<string | null> => storage.getItem(key);

  return {
    getItem: (name) => {
      const runtimeKey = getRuntimeKey();
      const scopedName = instanceScopedStorageKey(name, runtimeKey);
      const primary = readRaw(scopedName);
      if (primary instanceof Promise) {
        return primary.then((value) => {
          if (value !== null) return parse(value);
          if (!mayReadLegacyUnscopedInstanceStorage(runtimeKey)) return null;
          const fallback = readRaw(name);
          return fallback instanceof Promise ? fallback.then(parse) : parse(fallback);
        });
      }
      if (primary !== null) return parse(primary);
      if (!mayReadLegacyUnscopedInstanceStorage(runtimeKey)) return null;
      const fallback = readRaw(name);
      return fallback instanceof Promise ? fallback.then(parse) : parse(fallback);
    },
    setItem: (name, value) => {
      const scopedName = instanceScopedStorageKey(name, getRuntimeKey());
      storage.setItem(scopedName, JSON.stringify(value, options?.replacer));
    },
    removeItem: (name) => {
      const scopedName = instanceScopedStorageKey(name, getRuntimeKey());
      storage.removeItem(scopedName);
    },
  };
};
