import { describe, expect, test } from 'vitest';

import {
  createLynxSecureStoreAdapter,
  lynxSecurePrefixedTokenKey,
  LYNX_KEYCHAIN_ACCESS_WHEN_UNLOCKED,
  LYNX_SECURE_STORAGE_PREFIX,
} from './secureStore';

describe('Lynx secure store adapter', () => {
  test('no host → get undefined / set false (never fake Keychain)', async () => {
    const adapter = createLynxSecureStoreAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.get('k')).toBeUndefined();
    expect(await adapter.set('k', 'secret')).toBe(false);
  });

  test('host binder get/set/delete with Cap prefixed key + access', async () => {
    const map = new Map<string, string>();
    const adapter = createLynxSecureStoreAdapter();
    let lastAccess: number | undefined;
    adapter.inject({
      getItem: async ({ prefixedKey }) => map.get(prefixedKey) ?? null,
      setItem: async ({ prefixedKey, data, access }) => {
        lastAccess = access;
        map.set(prefixedKey, data);
      },
      removeItem: async ({ prefixedKey }) => {
        map.delete(prefixedKey);
      },
    });
    const key = lynxSecurePrefixedTokenKey('http://127.0.0.1:4096');
    expect(key.startsWith(LYNX_SECURE_STORAGE_PREFIX)).toBe(true);
    expect(await adapter.set(key, 'tok')).toBe(true);
    expect(lastAccess).toBe(LYNX_KEYCHAIN_ACCESS_WHEN_UNLOCKED);
    expect(await adapter.get(key)).toBe('tok');
    await adapter.delete(key);
    expect(await adapter.get(key)).toBeUndefined();
  });
});
