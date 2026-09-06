import { describe, expect, test } from 'vitest';

import { buildPairingConnectionPayload, encodePairingConnectionPayload } from './payload';
import { parseConnectionPayload } from './scan';

describe('parseConnectionPayload', () => {
  test('accepts a bare http(s) server URL', () => {
    expect(parseConnectionPayload('https://oc.example')).toEqual({ url: 'https://oc.example' });
    expect(parseConnectionPayload('  http://192.168.1.10:2606 ')).toEqual({ url: 'http://192.168.1.10:2606' });
  });

  test('accepts a v2 pairing link', () => {
    const pairing = buildPairingConnectionPayload({
      pairingId: 'pair_scan',
      secret: 'one-time-secret',
      candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
    });
    expect(parseConnectionPayload(encodePairingConnectionPayload(pairing))).toEqual({ pairing });
  });

  test('rejects non-connection, session, and legacy v1 payloads', () => {
    expect(parseConnectionPayload('')).toBeNull();
    expect(parseConnectionPayload('hello world')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect')).toBeNull();
    expect(parseConnectionPayload('openchamber://session/abc')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect?v=1&server=http%3A%2F%2F192.168.1.10%3A2606&token=tok')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect?v=1&mode=relay#offer=eyJ2IjoxfQ')).toBeNull();
  });
});
