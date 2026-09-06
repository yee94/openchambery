/**
 * Token storage. Production uses expo-secure-store (Keychain / Keystore).
 * Tests inject MemorySecureStore. Never log token values.
 */

export interface SecureStoreBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';

export const tokenStorageKey = (connectionKey: string): string =>
  `${MOBILE_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(connectionKey)}`;

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

export const readSecureToken = async (connectionKey: string): Promise<string | undefined> => {
  if (!connectionKey) return undefined;
  try {
    const value = await getSecureStoreBackend().getItem(tokenStorageKey(connectionKey));
    const token = typeof value === 'string' && value.trim() ? value.trim() : undefined;
    console.info('[mobile-storage]', 'secure:read', JSON.stringify({ key: connectionKey, hasToken: Boolean(token) }));
    return token;
  } catch (error) {
    console.warn('[mobile-storage] secure:read failed', error);
    return undefined;
  }
};

export const writeSecureToken = async (connectionKey: string, token: string): Promise<boolean> => {
  if (!connectionKey || !token.trim()) return false;
  try {
    await getSecureStoreBackend().setItem(tokenStorageKey(connectionKey), token.trim());
    console.info('[mobile-storage]', 'secure:write', JSON.stringify({ key: connectionKey, ok: true }));
    return true;
  } catch (error) {
    console.warn('[mobile-storage] secure:write failed', error);
    return false;
  }
};

export const deleteSecureToken = async (connectionKey: string): Promise<void> => {
  if (!connectionKey) return;
  try {
    await getSecureStoreBackend().deleteItem(tokenStorageKey(connectionKey));
  } catch (error) {
    console.warn('[mobile-storage] secure:delete failed', error);
  }
};
