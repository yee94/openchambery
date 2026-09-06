import { describe, expect, test } from 'vitest';

import { createMemoryClock, createMemoryHost, jsonResponse } from '../host/memory.ts';
import { pairingCandidatesToMobile, probeConnectionCandidates } from './probe.ts';
import { LYNX_RELAY_RACE_HEADSTART_MS } from './types.ts';

const relay = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_1',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey,
};

describe('connect race', () => {
  test('relay-only payloads do not sleep the LAN headstart', async () => {
    const clock = createMemoryClock();
    const host = createMemoryHost({
      clock,
      openRelay: async () => ({
        fetch: async (path) => {
          if (path === '/auth/session') return jsonResponse(200, { authenticated: true, scope: 'client' });
          return jsonResponse(404, null);
        },
      }),
    });

    const result = await probeConnectionCandidates(
      [{ kind: 'relay', relay }],
      'tok',
      host,
    );
    expect(result.status).toBe('ok');
    expect(clock.sleeps).toEqual([]);
  });

  test('LAN + relay starts the 1.5s headstart and prefers a live LAN', async () => {
    const clock = createMemoryClock();
    let relayOpened = false;
    const host = createMemoryHost({
      clock,
      request: async (url) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok', serverId: 'srv_1' });
        if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
        return jsonResponse(404, null);
      },
      openRelay: async () => {
        relayOpened = true;
        return {
          fetch: async () => jsonResponse(200, { authenticated: true, scope: 'client' }),
        };
      },
    });

    const probe = probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.9:2606' }, { kind: 'relay', relay }],
      'tok',
      host,
    );
    const result = await probe;
    expect(result).toEqual({ status: 'ok', transport: { kind: 'direct', url: 'http://192.168.1.9:2606' } });
    expect(clock.sleeps).toEqual([LYNX_RELAY_RACE_HEADSTART_MS]);
    expect(relayOpened).toBe(false);
  });

  test('GET /health then /auth/session on a typed URL; 401 is needs-login', async () => {
    const paths: string[] = [];
    const host = createMemoryHost({
      request: async (url) => {
        paths.push(url.replace(/^https?:\/\/[^/]+/, ''));
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/auth/session')) return jsonResponse(401, { authenticated: false });
        return jsonResponse(404, null);
      },
    });
    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.9:2606' }],
      'expired',
      host,
    );
    expect(result.status).toBe('needs-login');
    expect(paths).toEqual(['/health', '/auth/session']);
  });

  test('skips a LAN address whose /health serverId does not match the paired relay', async () => {
    const host = createMemoryHost({
      request: async (url) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok', serverId: 'other' });
        throw new Error('must not send bearer to a mismatched host');
      },
      openRelay: async () => ({
        fetch: async () => jsonResponse(200, { authenticated: true, scope: 'client' }),
      }),
    });
    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.9:2606' }, { kind: 'relay', relay }],
      'tok',
      host,
    );
    expect(result).toEqual({ status: 'ok', transport: { kind: 'relay', relay } });
  });
});

describe('pairingCandidatesToMobile', () => {
  test('orders by priority and keeps relay last on ties', () => {
    const candidates = pairingCandidatesToMobile([
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_1', hostEncPubJwk: relay.hostEncPubJwk, priority: 10 },
      { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
      { type: 'tunnel', url: 'https://runtime.example', priority: 5 },
    ]);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['direct', 'direct', 'relay']);
    expect(candidates[0] && candidates[0].kind === 'direct' ? candidates[0].url : '').toBe('https://runtime.example');
  });
});
