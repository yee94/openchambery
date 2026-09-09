/**
 * Token storage. Production uses expo-secure-store (Keychain / Keystore).
 * Tests inject MemorySecureStore. Never log token values.
 *
 * expo-secure-store keys MUST match /^[\w.-]+$/. Logical connection keys are
 * `relay:uuid@wss://...` / `http://192.168...` — encodeURIComponent still
 * produces `%3A` / `%40` which throw on setItemAsync. Hash the logical key.
 */

import { sha256Hex } from '@/lib/sha256';

export interface SecureStoreBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';

/** Same charset gate expo-secure-store uses in ensureValidKey. */
export const EXPO_SECURE_STORE_KEY_RE = /^[\w.-]+$/;

/**
 * Map a logical connectionKey (may contain :/@/) to an expo-secure-store-safe key.
 * Logs keep the logical key; the hashed form is storage-only.
 */
export const tokenStorageKey = (connectionKey: string): string => {
  const digest = sha256Hex(connectionKey);
  return `${MOBILE_SECURE_STORAGE_PREFIX}token.${digest}`;
};

export class MemorySecureStore implements SecureStoreBackend {
  readonly snapshot = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.snapshot.has(key) ? this.snapshot.get(key)! : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.snapshot.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.snapshot.delete(key);
  }
}

let backend: SecureStoreBackend | null = null;

export const setSecureStoreBackend = (next: SecureStoreBackend | null): void => {
  backend = next;
};

export const getSecureStoreBackend = (): SecureStoreBackend => {
  if (backend) return backend;
  // Lazy-load expo-secure-store so unit tests never need the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  backend = {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItem: (key) => SecureStore.deleteItemAsync(key),
  };
  return backend;
};

const isInvalidKeyError = (error: unknown): boolean => {
  const message =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '');
  return /invalid key/i.test(message);
};

export const readSecureToken = async (connectionKey: string): Promise<string | undefined> => {
  if (!connectionKey) return undefined;
  const storageKey = tokenStorageKey(connectionKey);
  try {
    const value = await getSecureStoreBackend().getItem(storageKey);
    const token = typeof value === 'string' && value.trim() ? value.trim() : undefined;
    console.info(
      '[mobile-storage]',
      'secure:read',
      JSON.stringify({ key: connectionKey, storageKey, hasToken: Boolean(token) }),
    );
    return token;
  } catch (error) {
    if (isInvalidKeyError(error)) {
      console.warn('[mobile-storage]', 'secure:read-invalid-key', JSON.stringify({ key: connectionKey, storageKey }));
    }
    console.warn('[mobile-storage] secure:read failed', error);
    return undefined;
  }
};

export const writeSecureToken = async (connectionKey: string, token: string): Promise<boolean> => {
  if (!connectionKey || !token.trim()) return false;
  const storageKey = tokenStorageKey(connectionKey);
  if (!EXPO_SECURE_STORE_KEY_RE.test(storageKey)) {
    console.warn(
      '[mobile-storage]',
      'secure:write-invalid-key',
      JSON.stringify({ key: connectionKey, storageKey }),
    );
    return false;
  }
  try {
    await getSecureStoreBackend().setItem(storageKey, token.trim());
    console.info('[mobile-storage]', 'secure:write', JSON.stringify({ key: connectionKey, storageKey, ok: true }));
    return true;
  } catch (error) {
    if (isInvalidKeyError(error)) {
      console.warn(
        '[mobile-storage]',
        'secure:write-invalid-key',
        JSON.stringify({ key: connectionKey, storageKey }),
      );
    }
    console.warn('[mobile-storage] secure:write failed', error);
    return false;
  }
};

export const deleteSecureToken = async (connectionKey: string): Promise<void> => {
  if (!connectionKey) return;
  const storageKey = tokenStorageKey(connectionKey);
  try {
    await getSecureStoreBackend().deleteItem(storageKey);
  } catch (error) {
    console.warn('[mobile-storage] secure:delete failed', error);
  }
};
