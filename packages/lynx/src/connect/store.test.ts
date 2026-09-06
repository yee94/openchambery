import { describe, expect, test } from 'vitest';

import { createMemoryJsonStore, createMemorySecureStore } from '../host/memory.ts';
import {
  createLynxConnectionStore,
  migrateLegacyInlineTokens,
  prefixedTokenKey,
} from './store.ts';
import { LYNX_METADATA_STORAGE_KEY } from './types.ts';
import { secureTokenKeyOf } from './urls.ts';

const testRelay = {
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_test123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey,
};

describe('instance persistence', () => {
  test('persists the full LAN + relay candidate set including v2 relayUrl', () => {
    const metadata = createMemoryJsonStore();
    const store = createLynxConnectionStore(metadata);
    store.upsert({
      label: 'Both',
      candidates: [
        { kind: 'direct', url: 'http://192.168.1.5:2606' },
        { kind: 'relay', relay: testRelay },
      ],
      hasToken: true,
      now: 10,
      createId: () => 'conn_1',
    });

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.candidates).toEqual([
      { kind: 'direct', url: 'http://192.168.1.5:2606' },
      { kind: 'relay', relay: testRelay },
    ]);

    const raw = JSON.parse(metadata.read(LYNX_METADATA_STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
    expect(raw[0]?.clientToken).toBeUndefined();
    const rawCandidate = (raw[0]?.candidates as Array<Record<string, unknown>>)[1];
    expect(rawCandidate.kind).toBe('relay');
    expect(Object.keys(rawCandidate.relay as object).sort()).toEqual(['hostEncPubJwk', 'relayUrl', 'serverId']);
  });

  test('migrates a pre-candidates URL entry and drops a broken relay', () => {
    const metadata = createMemoryJsonStore({
      [LYNX_METADATA_STORAGE_KEY]: JSON.stringify([
        { id: 'bad', label: 'Broken', lastUsedAt: 20, mode: 'relay', relay: { relayUrl: 'wss://relay.example' } },
        { id: 'ok', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'legacy' },
      ]),
    });
    const store = createLynxConnectionStore(metadata);
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('ok');
    expect(loaded[0]?.candidates).toEqual([{ kind: 'direct', url: 'http://192.168.1.10:2606' }]);
    expect(loaded[0]?.hasToken).toBe(true);
  });

  test('same serverId on a different relayUrl stays a separate instance', () => {
    const store = createLynxConnectionStore(createMemoryJsonStore());
    store.upsert({ label: 'Stable', candidates: [{ kind: 'relay', relay: testRelay }], now: 1, createId: () => 'a' });
    store.upsert({
      label: 'Preview',
      candidates: [{ kind: 'relay', relay: { ...testRelay, relayUrl: 'wss://self-hosted.example/ws' } }],
      now: 2,
      createId: () => 'b',
    });
    expect(store.load().map((connection) => connection.label).sort()).toEqual(['Preview', 'Stable']);
  });

  test('moves an inline legacy token into the secure store and strips metadata', async () => {
    const metadata = createMemoryJsonStore({
      [LYNX_METADATA_STORAGE_KEY]: JSON.stringify([
        { id: 'a', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'tok-a' },
      ]),
    });
    const secure = createMemorySecureStore();
    await migrateLegacyInlineTokens(metadata, secure);
    const store = createLynxConnectionStore(metadata);
    const loaded = store.load();
    expect(loaded[0]?.hasToken).toBe(true);
    const raw = JSON.parse(metadata.read(LYNX_METADATA_STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
    expect(raw[0]?.clientToken).toBeUndefined();
    const key = prefixedTokenKey(secureTokenKeyOf(loaded[0]!));
    expect(secure.snapshot()[key]).toBe('tok-a');
  });
});
