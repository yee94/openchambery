import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * Packaged Electron multi-window shares one UI origin (`openchamber-ui://`) while
 * each window may target a different runtime host. Appearance keys that live in
 * localStorage must therefore be transport-scoped so local prefs never leak into
 * a remote window (and vice versa).
 *
 * Unscoped legacy keys remain readable only for the active local desktop runtime
 * (or single-runtime web), so existing installs keep theme/brand without a
 * migration step. Remote packaged windows never fall back to the shared bucket.
 */

const SCOPE_PREFIX = 'oc.rt.';

const encodeTransport = (transport: string): string => {
  // Keep keys short and storage-safe; transport fingerprints may contain `:`, `/`, `{`.
  try {
    return btoa(unescape(encodeURIComponent(transport)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  } catch {
    return encodeURIComponent(transport);
  }
};

export const runtimeScopedStorageKey = (
  baseKey: string,
  transport: string = getRuntimeTransportIdentity(),
): string => {
  const identity = transport.trim().length > 0 ? transport.trim() : 'default';
  return `${SCOPE_PREFIX}${encodeTransport(identity)}.${baseKey}`;
};

/** True when a StorageEvent key is the scoped form of `baseKey` under the active transport. */
export const isRuntimeScopedStorageEventKey = (
  eventKey: string | null,
  baseKey: string,
  transport: string = getRuntimeTransportIdentity(),
): boolean => {
  if (!eventKey) return false;
  return eventKey === runtimeScopedStorageKey(baseKey, transport);
};

/**
 * Whether this window may inherit pre-scoping unscoped localStorage keys.
 * Remote multi-window desktops must not, or local brand/theme leaks in.
 */
export const mayReadLegacyUnscopedStorage = (): boolean => {
  if (typeof window === 'undefined') return true;
  const api = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  const local = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  // Multi-host desktop signal: only same-origin API vs local origin may inherit
  // the unscoped legacy bucket. Remote packaged windows must not.
  if (typeof api === 'string' && api.trim() && typeof local === 'string' && local.trim()) {
    try {
      return new URL(api).origin === new URL(local).origin;
    } catch {
      return false;
    }
  }
  try {
    if (isDesktopLocalOriginActive()) return true;
  } catch {
    // desktop helpers can throw in constrained test windows
  }
  // Explicit non-loopback API without a matching local origin → remote multi-host window.
  if (typeof api === 'string' && api.trim()) {
    try {
      const host = new URL(api).hostname;
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if (!loopback) return false;
    } catch {
      return false;
    }
  }
  // No multi-host signal (plain web / unit tests) → single runtime, legacy OK.
  return true;
};

export const readRuntimeScopedItem = (
  baseKey: string,
  options?: {
    storage?: Pick<Storage, 'getItem'>;
    transport?: string;
  },
): string | null => {
  const storage = options?.storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null });
  const transport = options?.transport ?? getRuntimeTransportIdentity();
  const scoped = storage.getItem(runtimeScopedStorageKey(baseKey, transport));
  if (scoped !== null) return scoped;
  if (!mayReadLegacyUnscopedStorage()) return null;
  return storage.getItem(baseKey);
};

export const writeRuntimeScopedItem = (
  baseKey: string,
  value: string,
  options?: {
    storage?: Pick<Storage, 'setItem'>;
    transport?: string;
  },
): void => {
  const storage = options?.storage
    ?? (typeof localStorage !== 'undefined' ? localStorage : { setItem: () => undefined });
  const transport = options?.transport ?? getRuntimeTransportIdentity();
  storage.setItem(runtimeScopedStorageKey(baseKey, transport), value);
};

type JsonStorageOptions = {
  reviver?: (key: string, value: unknown) => unknown;
  replacer?: (key: string, value: unknown) => unknown;
};

/**
 * Zustand persist storage that namespaces the store name by the *current*
 * transport identity on every get/set. Remote windows never fall back to the
 * unscoped legacy name; local/web may, for upgrade compatibility.
 */
export const createRuntimeScopedJSONStorage = <S>(
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
      const transport = getRuntimeTransportIdentity();
      const scopedName = runtimeScopedStorageKey(name, transport);
      const primary = readRaw(scopedName);
      if (primary instanceof Promise) {
        return primary.then((value) => {
          if (value !== null) return parse(value);
          if (!mayReadLegacyUnscopedStorage()) return null;
          const fallback = readRaw(name);
          return fallback instanceof Promise ? fallback.then(parse) : parse(fallback);
        });
      }
      if (primary !== null) return parse(primary);
      if (!mayReadLegacyUnscopedStorage()) return null;
      const fallback = readRaw(name);
      return fallback instanceof Promise ? fallback.then(parse) : parse(fallback);
    },
    setItem: (name, value) => {
      const scopedName = runtimeScopedStorageKey(name, getRuntimeTransportIdentity());
      storage.setItem(scopedName, JSON.stringify(value, options?.replacer));
    },
    removeItem: (name) => {
      const scopedName = runtimeScopedStorageKey(name, getRuntimeTransportIdentity());
      storage.removeItem(scopedName);
    },
  };
};
