import { describe, expect, test } from 'vitest';

import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
} from '../pairing/payload';
import { parsePastedPairingLink } from './pairingPaste';

describe('parsePastedPairingLink', () => {
  test('accepts encoded v2 payload and rejects junk', () => {
    const pairing = buildPairingConnectionPayload({
      pairingId: 'pair_1',
      secret: 'secret_value_here',
      label: 'desk',
      candidates: [{ type: 'lan', url: 'http://192.168.1.10:4096' }],
    });
    const encoded = encodePairingConnectionPayload(pairing);
    const ok = parsePastedPairingLink(encoded);
    expect(ok.status).toBe('pairing');
    if (ok.status === 'pairing') {
      expect(ok.pairing.pairingId).toBe('pair_1');
      expect(ok.pairing.v).toBe(2);
    }
    expect(parsePastedPairingLink('')).toEqual({ status: 'empty' });
    expect(parsePastedPairingLink('not-a-link')).toEqual({ status: 'invalid' });
  });
});
