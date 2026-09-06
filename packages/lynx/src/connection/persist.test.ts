import { describe, expect, test } from 'vitest';

import {
  CONNECTIONS_STORAGE_KEY,
  createMemoryKvStore,
  createMemorySecureStore,
  prefixedTokenKey,
  readConnections,
  readSecureToken,
  upsertConnectionInList,
  writeConnections,
  writeSecureToken,
} from './persist';
import type { LynxRelayConfig } from './types';
import { secureTokenKeyOf } from './urls';

const testRelay: LynxRelayConfig = {
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_test123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

describe('connection persistence', () => {
  test('migrates a pre-candidates entry to a single direct candidate', () => {
    const store = createMemoryKvStore({
      [CONNECTIONS_STORAGE_KEY]: JSON.stringify([
        { id: 'a', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'tok-a' },
        { id: 'b', label: 'Work', url: 'http://work.example', lastUsedAt: 5 },
      ]),
    });
    const connections = readConnections(store);
    expect(connections).toHaveLength(2);
    const home = connections.find((connection) => connection.id === 'a')!;
    expect(home.candidates).toEqual([{ kind: 'direct', url: 'http://192.168.1.10:2606' }]);
    expect(home.hasToken).toBe(true);
  });

  test('persists LAN then relay in order and never writes the token into metadata', async () => {
    const store = createMemoryKvStore();
    const secure = createMemorySecureStore();
    const candidates = [
      { kind: 'direct' as const, url: 'http://192.168.1.5:2606' },
      { kind: 'relay' as const, relay: testRelay },
    ];
    const next = upsertConnectionInList([], {
      label: 'Both',
      candidates,
      hasToken: true,
      now: 1,
    });
    writeConnections(store, next);
    await writeSecureToken(secure, { candidates }, 'oc_client_secret');

    const raw = JSON.parse(store.getItem(CONNECTIONS_STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
    expect(raw[0]?.clientToken).toBeUndefined();
    expect((raw[0]?.candidates as Array<{ kind: string }>).map((candidate) => candidate.kind)).toEqual(['direct', 'relay']);
    const rawRelay = (raw[0]?.candidates as Array<Record<string, unknown>>)[1];
    expect(Object.keys(rawRelay.relay as object).sort()).toEqual(['hostEncPubJwk', 'relayUrl', 'serverId']);
    expect(await readSecureToken(secure, { candidates })).toBe('oc_client_secret');
    expect(secureTokenKeyOf({ candidates })).toContain('relay:');
    expect(prefixedTokenKey(secureTokenKeyOf({ candidates }))).toContain('token.');
  });

  test('drops a malformed legacy relay entry and keeps a valid direct one', () => {
    const store = createMemoryKvStore({
      [CONNECTIONS_STORAGE_KEY]: JSON.stringify([
        { id: 'bad', label: 'Broken', lastUsedAt: 20, mode: 'relay', relay: { relayUrl: 'wss://relay.example' } },
        { id: 'ok', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10 },
      ]),
    });
    const connections = readConnections(store);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.id).toBe('ok');
  });

  test('dedupes the same relay identity and keeps a different relay URL as a second instance', () => {
    const first = upsertConnectionInList([], {
      label: 'Stable',
      candidates: [{ kind: 'relay', relay: testRelay }],
      now: 1,
    });
    const renamed = upsertConnectionInList(first, {
      label: 'Home Mac renamed',
      candidates: [{ kind: 'relay', relay: testRelay }],
      now: 2,
    });
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.label).toBe('Home Mac renamed');

    const other = upsertConnectionInList(renamed, {
      label: 'Preview',
      candidates: [{
        kind: 'relay',
        relay: { ...testRelay, relayUrl: 'wss://self-hosted.example/ws' },
      }],
      now: 3,
    });
    expect(other).toHaveLength(2);
  });
});
