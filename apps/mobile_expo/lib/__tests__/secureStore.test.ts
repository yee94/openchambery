import { createHash } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';

import {
  EXPO_SECURE_STORE_KEY_RE,
  MemorySecureStore,
  readSecureToken,
  setSecureStoreBackend,
  tokenStorageKey,
  writeSecureToken,
} from '@/lib/secureStore';
import { sha256Hex } from '@/lib/sha256';

afterEach(() => {
  setSecureStoreBackend(null);
});

describe('tokenStorageKey', () => {
  it('matches expo-secure-store ensureValidKey /^[\\w.-]+$/ for relay and http keys', () => {
    const samples = [
      'relay:srv_abc@wss://relay.example/ws',
      'http://192.168.1.74:2606',
      'https://openchamber.example.com',
      'relay:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@wss://r.example/path?x=1',
    ];
    for (const logical of samples) {
      const key = tokenStorageKey(logical);
      expect(key).toMatch(EXPO_SECURE_STORE_KEY_RE);
      expect(key).toMatch(/^openchamber\.mobile\.token\.[0-9a-f]{64}$/);
      // Must NOT contain percent-encoding from encodeURIComponent.
      expect(key).not.toContain('%');
      expect(key).not.toContain(':');
      expect(key).not.toContain('@');
      expect(key).not.toContain('/');
    }
  });

  it('is stable and matches node crypto SHA-256', () => {
    const logical = 'relay:srv_test@wss://relay.example/ws';
    const a = tokenStorageKey(logical);
    const b = tokenStorageKey(logical);
    expect(a).toBe(b);
    const nodeHex = createHash('sha256').update(logical, 'utf8').digest('hex');
    expect(sha256Hex(logical)).toBe(nodeHex);
    expect(a).toBe(`openchamber.mobile.token.${nodeHex}`);
  });
});

describe('writeSecureToken', () => {
  it('persists under hashed key and round-trips', async () => {
    const mem = new MemorySecureStore();
    setSecureStoreBackend(mem);
    const logical = 'http://192.168.1.20:4096';
    expect(await writeSecureToken(logical, ' oc_client_tok ')).toBe(true);
    expect(mem.snapshot.has(tokenStorageKey(logical))).toBe(true);
    expect(mem.snapshot.get(tokenStorageKey(logical))).toBe('oc_client_tok');
    expect(await readSecureToken(logical)).toBe('oc_client_tok');
  });

  it('stores relay runtime keys that previously broke encodeURIComponent path', async () => {
    const mem = new MemorySecureStore();
    setSecureStoreBackend(mem);
    const logical = 'relay:0123456789abcdef0123456789abcdef@wss://relay.openchamber.app/ws';
    expect(EXPO_SECURE_STORE_KEY_RE.test(tokenStorageKey(logical))).toBe(true);
    expect(await writeSecureToken(logical, 'tok-from-redeem')).toBe(true);
    expect(await readSecureToken(logical)).toBe('tok-from-redeem');
  });
});

describe('expo-secure-store charset gate regression', () => {
  it('hashed keys survive a backend that mirrors ensureValidKey', async () => {
    const store = new Map<string, string>();
    setSecureStoreBackend({
      getItem: async (key) => {
        if (!EXPO_SECURE_STORE_KEY_RE.test(key)) throw new Error('Invalid key provided to SecureStore');
        return store.has(key) ? store.get(key)! : null;
      },
      setItem: async (key, value) => {
        if (!EXPO_SECURE_STORE_KEY_RE.test(key)) throw new Error('Invalid key provided to SecureStore');
        store.set(key, value);
      },
      deleteItem: async (key) => {
        if (!EXPO_SECURE_STORE_KEY_RE.test(key)) throw new Error('Invalid key provided to SecureStore');
        store.delete(key);
      },
    });
    const logical = 'relay:srv_test@wss://relay.example/ws';
    // Old encodeURIComponent key would throw here on real devices.
    expect(await writeSecureToken(logical, 'oc_client_issued')).toBe(true);
    expect(await readSecureToken(logical)).toBe('oc_client_issued');
  });
});
