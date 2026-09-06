/**
 * Connection *metadata* store (no tokens on native).
 * AsyncStorage in production; MemoryMetaStore in tests.
 */

export interface MetaStoreBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryMetaStore implements MetaStoreBackend {
  readonly snapshot = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.snapshot.has(key) ? this.snapshot.get(key)! : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.snapshot.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.snapshot.delete(key);
  }
}

let backend: MetaStoreBackend | null = null;

export const setMetaStoreBackend = (next: MetaStoreBackend | null): void => {
  backend = next;
};

export const getMetaStoreBackend = (): MetaStoreBackend => {
  if (backend) return backend;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage').default as {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  backend = {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
  return backend;
};
