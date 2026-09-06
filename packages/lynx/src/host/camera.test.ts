import { describe, expect, test } from 'vitest';

import { createLynxCameraAdapter } from './camera';

describe('Lynx camera QR adapter', () => {
  test('no host → unavailable (never fake pairing)', async () => {
    const adapter = createLynxCameraAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.scanPairingQr()).toEqual({ status: 'unavailable', reason: 'no-host' });
  });

  test('parses pairing payload from host raw value', async () => {
    const adapter = createLynxCameraAdapter();
    // Minimal invalid openchamber link → invalid; http url → ok
    adapter.inject({
      scanPairingQr: async () => ({ status: 'ok', rawValue: 'http://127.0.0.1:4096' }),
    });
    expect(await adapter.scanPairingQr()).toEqual({
      status: 'ok',
      url: 'http://127.0.0.1:4096',
    });
  });

  test('host cancelled / permission-denied preserved', async () => {
    const adapter = createLynxCameraAdapter();
    adapter.inject({ scanPairingQr: async () => ({ status: 'cancelled' }) });
    expect(await adapter.scanPairingQr()).toEqual({ status: 'cancelled' });
    adapter.inject({ scanPairingQr: async () => ({ status: 'permission-denied' }) });
    expect(await adapter.scanPairingQr()).toEqual({ status: 'permission-denied' });
  });
});
