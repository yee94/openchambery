import { describe, expect, test } from 'vitest';

import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  parsePairingConnectionPayloadString,
} from './pairing.ts';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;

describe('pairing v2 payload', () => {
  test('round-trips direct + relay candidates including relayUrl', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_123',
      secret: 'one-time-secret',
      label: 'Desktop',
      fingerprint: 'ABCD-1234',
      expiresAt: '2099-01-01T00:00:00.000Z',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096/', priority: 20 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
      ],
    });

    const encoded = encodePairingConnectionPayload(payload);
    expect(encoded.startsWith('openchamber://connect?v=2&p=')).toBe(true);
    expect(parsePairingConnectionPayload(encoded)).toEqual({
      ...payload,
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
      ],
    });
  });

  test('rejects legacy v1 connect links', () => {
    expect(parsePairingConnectionPayload('openchamber://connect?v=1&server=https://runtime.example&token=t')).toBeNull();
    expect(parsePairingConnectionPayload('openchamber://connect?v=2&p=not-json')).toBeNull();
  });

  test('rejects missing secret, file URLs, and expired payloads', () => {
    const missingSecret = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${missingSecret}`)).toBeNull();

    const invalidCandidate = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      candidates: [{ type: 'lan', url: 'file:///tmp/socket' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${invalidCandidate}`)).toBeNull();

    const expired = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      expiresAt: '2000-01-01T00:00:00.000Z',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${expired}`)).toBeNull();
  });

  test('string parser reads a v2 link without depending on URL hostname', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_old_webview',
      secret: 'one-time-secret',
      candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 }],
    });
    const encoded = encodePairingConnectionPayload(payload);
    expect(parsePairingConnectionPayloadString(encoded)?.pairingId).toBe('pair_old_webview');
    expect(parsePairingConnectionPayloadString('openchamber://connect?v=1&p=abc')).toBeNull();
  });

  test('strips relay query/fragment and rejects userinfo', () => {
    const encodeCandidates = (candidates: unknown[]) =>
      Buffer.from(JSON.stringify({ v: 2, pairingId: 'pair_1', secret: 's', candidates })).toString('base64url');
    const parsed = parsePairingConnectionPayload(`openchamber://connect?v=2&p=${encodeCandidates([{
      type: 'relay',
      relayUrl: 'wss://relay.example/ws?token=secret#frag',
      serverId: 'srv',
      hostEncPubJwk,
    }])}`);
    expect(parsed?.candidates).toEqual([
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk },
    ]);
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${encodeCandidates([{
      type: 'relay',
      relayUrl: 'wss://user:pass@relay.example/ws',
      serverId: 'srv',
      hostEncPubJwk,
    }])}`)).toBeNull();
  });
});
