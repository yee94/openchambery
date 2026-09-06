import { describe, expect, test } from 'vitest';

import { createMemoryHost, jsonResponse } from '../host/memory.ts';
import { refreshConnectionCandidates } from './candidates.ts';
import { createLynxConnectionStore } from './store.ts';

const relay = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_1',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey,
};

describe('refreshConnectionCandidates', () => {
  test('replaces stale LAN URLs from the official candidates route and keeps relayUrl', async () => {
    const host = createMemoryHost({
      runtimeFetch: async (path) => {
        expect(path).toBe('/api/client-auth/connection/candidates');
        return jsonResponse(200, {
          serverId: 'srv_1',
          candidates: [{ type: 'lan', url: 'http://192.168.1.77:2606' }],
        });
      },
    });
    const store = createLynxConnectionStore(host.metadataStore);
    store.upsert({
      id: 'home',
      label: 'Home',
      candidates: [
        { kind: 'direct', url: 'http://192.168.1.9:2606' },
        { kind: 'relay', relay },
      ],
      hasToken: true,
    });
    const active = store.load()[0]!;
    const result = await refreshConnectionCandidates(active, host);
    expect(result.result).toBe('updated');
    expect(result.next?.candidates).toEqual([
      { kind: 'direct', url: 'http://192.168.1.77:2606' },
      { kind: 'relay', relay },
    ]);
  });

  test('ignores a refresh that does not echo the paired serverId', async () => {
    const host = createMemoryHost({
      runtimeFetch: async () => jsonResponse(200, {
        serverId: 'other',
        candidates: [{ type: 'lan', url: 'http://10.0.0.2:2606' }],
      }),
    });
    const active = {
      id: 'home',
      label: 'Home',
      lastUsedAt: 1,
      hasToken: true,
      candidates: [{ kind: 'relay' as const, relay }],
    };
    const result = await refreshConnectionCandidates(active, host);
    expect(result.result).toBe('skipped');
  });
});
