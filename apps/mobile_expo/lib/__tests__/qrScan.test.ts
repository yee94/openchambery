import { describe, expect, it } from 'vitest';

import { encodePairingConnectionPayload, parseConnectionPayload } from '@/lib/connectionPayload';
import { pickScannedQrRaw } from '@/lib/qrScan';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey;

describe('pickScannedQrRaw', () => {
  it('prefers the longest candidate (Cap rawValue over truncated display)', () => {
    const full = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_long',
      secret: 'one-time-secret-value',
      label: 'Studio',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096' },
        {
          type: 'relay',
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_test',
          hostEncPubJwk,
          grant: 'grant-keep',
        },
      ],
    });
    expect(full.length).toBeGreaterThan(64);
    const picked = pickScannedQrRaw({
      displayValue: full.slice(0, 40),
      data: full.slice(0, 80),
      rawValue: full,
    });
    expect(picked).toBe(full);
    expect(parseConnectionPayload(picked)).toBeTruthy();
  });

  it('returns empty when scanner yields nothing', () => {
    expect(pickScannedQrRaw({})).toBe('');
    expect(pickScannedQrRaw({ data: '   ' })).toBe('');
  });
});
