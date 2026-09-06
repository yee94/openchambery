import { describe, expect, test } from 'vitest';

import { buildPairingConnectionPayload } from '../pairing/payload';
import { createLynxConnectionClient } from './client';
import { createMemoryKvStore, createMemorySecureStore } from './persist';
import type { LynxHttpResponse, LynxRelayConfig } from './types';

const relay: LynxRelayConfig = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_home',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('LynxConnectionClient', () => {
  test('redeems pairing v2 on the first reachable candidate and persists LAN+relay', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const client = createLynxConnectionClient({
      metadataStore: createMemoryKvStore(),
      secureStore: createMemorySecureStore(),
      getDevicePlatform: () => 'ios',
      http: {
        request: async (url, init) => {
          requests.push({ url, body: init?.body });
          if (url.endsWith('/health')) return jsonResponse(200, { serverId: 'srv_home' });
          if (url.endsWith('/api/client-auth/pairing/redeem')) {
            return jsonResponse(200, {
              ok: true,
              clientToken: 'issued-token',
              server: { label: 'Studio' },
            });
          }
          return jsonResponse(404, {});
        },
      },
    });

    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_1',
      secret: 'one-time-secret',
      label: 'Studio',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
        { type: 'relay', relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk, priority: 30 },
      ],
    });

    const result = await client.redeemPairingConnection(payload);
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') return;
    expect(result.connection.candidates.map((candidate) => candidate.kind)).toEqual(['direct', 'relay']);
    expect(result.connection.hasToken).toBe(true);
    expect(result.runtimeKey.startsWith('relay:')).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/api/client-auth/pairing/redeem'))).toBe(true);
    const redeem = requests.find((request) => request.url.endsWith('/api/client-auth/pairing/redeem'));
    const body = JSON.parse(redeem?.body ?? '{}') as Record<string, unknown>;
    expect(body.pairingId).toBe('pair_1');
    expect(body.secret).toBe('one-time-secret');
    expect(body.clientKind).toBe('mobile');
    expect(body.dedupeKey).toMatch(/^mobile:/);
    expect(client.identity.get()?.clientToken).toBe('issued-token');
    expect(JSON.stringify(client.loadConnections()[0])).not.toContain('issued-token');
  });

  test('does not invent a nearby redeem route when LAN is down and no relay tunnel is injected', async () => {
    const urls: string[] = [];
    const client = createLynxConnectionClient({
      metadataStore: createMemoryKvStore(),
      secureStore: createMemorySecureStore(),
      http: {
        request: async (url) => {
          urls.push(url);
          return jsonResponse(503, {});
        },
      },
    });
    const result = await client.redeemPairingConnection(buildPairingConnectionPayload({
      pairingId: 'pair_1',
      secret: 's',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096' },
        { type: 'relay', relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk },
      ],
    }));
    expect(result).toEqual({ status: 'failed', error: 'unreachable' });
    expect(urls.some((url) => url.includes('/nearby/'))).toBe(false);
    expect(urls.some((url) => url.endsWith('/api/client-auth/pairing/redeem'))).toBe(false);
  });

  test('password unlock issues a client token over POST /auth/session', async () => {
    const client = createLynxConnectionClient({
      metadataStore: createMemoryKvStore(),
      secureStore: createMemorySecureStore(),
      http: {
        request: async (url, init) => {
          if (url.endsWith('/health')) return jsonResponse(200, {});
          if (url.endsWith('/auth/session') && init?.method === 'POST') {
            const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
            expect(body.issueClientToken).toBe(true);
            expect(body.trustDevice).toBe(true);
            return jsonResponse(200, { clientToken: 'pw-token' });
          }
          return jsonResponse(404, {});
        },
      },
    });
    const result = await client.submitPassword({
      id: 'pending-1',
      label: 'Home',
      candidates: [{ kind: 'direct', url: 'http://192.168.1.20:4096' }],
    }, 'secret-password');
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') return;
    expect(result.connection.hasToken).toBe(true);
  });

  test('auto-connect requires a saved token and switches the runtime on probe success', async () => {
    const metadataStore = createMemoryKvStore();
    const secureStore = createMemorySecureStore();
    const client = createLynxConnectionClient({
      metadataStore,
      secureStore,
      http: {
        request: async (url) => {
          if (url.endsWith('/health')) return jsonResponse(200, {});
          if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
          return jsonResponse(404, {});
        },
      },
    });
    expect(await client.autoConnectLastInstance()).toBe(false);
    await client.upsert({
      label: 'Home',
      candidates: [{ kind: 'direct', url: 'http://192.168.1.20:4096' }],
      clientToken: 'saved-token',
    });
    expect(await client.autoConnectLastInstance()).toBe(true);
    expect(client.identity.get()?.transport).toEqual({ kind: 'direct', url: 'http://192.168.1.20:4096' });
  });

  test('deleting the active instance clears runtime identity', async () => {
    const client = createLynxConnectionClient({
      metadataStore: createMemoryKvStore(),
      secureStore: createMemorySecureStore(),
      http: {
        request: async (url) => {
          if (url.endsWith('/health')) return jsonResponse(200, {});
          if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
          return jsonResponse(404, {});
        },
      },
    });
    await client.upsert({
      id: 'home',
      label: 'Home',
      candidates: [{ kind: 'direct', url: 'http://192.168.1.20:4096' }],
      clientToken: 'tok',
    });
    await client.connect({ id: 'home' });
    expect(client.identity.get()).not.toBeNull();
    await client.remove('home');
    expect(client.identity.get()).toBeNull();
    expect(client.loadConnections()).toEqual([]);
  });
});
