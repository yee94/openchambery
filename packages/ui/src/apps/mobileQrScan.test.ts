import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { encodePairingConnectionPayload, buildPairingConnectionPayload } from '@/lib/connectionPayload';

const {
  barcodeScannerPlugin,
  removeBarcode,
  removeError,
  resolveStopScan,
  stopScan,
} = vi.hoisted(() => {
  const removeBarcode = vi.fn();
  const removeError = vi.fn();
  let settleStopScan: (() => void) | undefined;
  const resolveStopScan = () => {
    settleStopScan?.();
    settleStopScan = undefined;
  };
  const stopScan = vi.fn(() => new Promise<void>((resolve) => {
    settleStopScan = resolve;
  }));
  const barcodeScannerPlugin = {
    requestPermissions: vi.fn(async () => ({ camera: 'granted' as const })),
    scan: vi.fn(async () => {
      throw new Error('17: API_NOT_CONNECTED');
    }),
    startScan: vi.fn(async () => undefined),
    stopScan,
    addListener: vi.fn(async (event: string) => {
      if (event === 'barcodesScanned') return { remove: removeBarcode };
      return { remove: removeError };
    }),
  };
  return { barcodeScannerPlugin, removeBarcode, removeError, resolveStopScan, stopScan };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'BarcodeScanner',
  },
  registerPlugin: () => barcodeScannerPlugin,
}));

import {
  evaluateQrScanSupport,
  parseConnectionPayload,
  scanConnectionQr,
  shouldFallbackToBundledScanner,
} from './mobileQrScan';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;
const BUNDLED_SCANNER_ACTIVE_CLASS = 'oc-barcode-scanner-active';

const originalWindowCapacitor = (window as typeof window & { Capacitor?: unknown }).Capacitor;

beforeEach(() => {
  (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
    getPlatform: () => 'android',
  };
  resolveStopScan();
  stopScan.mockClear();
  removeBarcode.mockClear();
  removeError.mockClear();
  barcodeScannerPlugin.scan.mockClear();
  barcodeScannerPlugin.startScan.mockClear();
  barcodeScannerPlugin.addListener.mockClear();
  barcodeScannerPlugin.requestPermissions.mockClear();
});

afterEach(() => {
  resolveStopScan();
  document.documentElement.classList.remove(BUNDLED_SCANNER_ACTIVE_CLASS);
  document.querySelectorAll('.oc-barcode-scanner-chrome').forEach((node) => node.remove());
  (window as typeof window & { Capacitor?: unknown }).Capacitor = originalWindowCapacitor;
  vi.restoreAllMocks();
});

describe('evaluateQrScanSupport', () => {
  test('supports an available plugin on a native platform', () => {
    expect(evaluateQrScanSupport({ isNativePlatform: true, isPluginAvailable: true })).toBe(true);
  });

  test('does not support scanning on web', () => {
    expect(evaluateQrScanSupport({ isNativePlatform: false, isPluginAvailable: true })).toBe(false);
  });

  test('does not support scanning when the native plugin is absent', () => {
    expect(evaluateQrScanSupport({ isNativePlatform: true, isPluginAvailable: false })).toBe(false);
  });
});

describe('parseConnectionPayload', () => {
  test('parses bare http(s) URLs', () => {
    expect(parseConnectionPayload('https://oc.example')).toEqual({ url: 'https://oc.example' });
    expect(parseConnectionPayload('  http://192.168.1.10:2606 ')).toEqual({ url: 'http://192.168.1.10:2606' });
  });

  test('parses a v2 pairing link with direct + relay candidates', () => {
    const url = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair_abc',
      secret: 'one-time',
      label: 'My Desktop',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_1', hostEncPubJwk, priority: 30 },
      ],
    }));
    const payload = parseConnectionPayload(url);
    if (!payload || !('pairing' in payload)) throw new Error('expected a pairing payload');
    expect(payload.pairing.pairingId).toBe('pair_abc');
    expect(payload.pairing.secret).toBe('one-time');
    expect(payload.pairing.candidates.map((c) => c.type)).toEqual(['lan', 'relay']);
  });

  test('rejects non-connection and legacy/relay-offer payloads', () => {
    expect(parseConnectionPayload('')).toBeNull();
    expect(parseConnectionPayload('hello world')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect')).toBeNull();
    expect(parseConnectionPayload('openchamber://session/abc')).toBeNull();
    // Legacy v1 direct links are no longer accepted.
    expect(parseConnectionPayload('openchamber://connect?v=1&server=http%3A%2F%2F192.168.1.10%3A2606&token=tok')).toBeNull();
    // Legacy relay-offer format (mode=relay + fragment) is no longer accepted.
    expect(parseConnectionPayload('openchamber://connect?v=1&mode=relay#offer=eyJ2IjoxfQ')).toBeNull();
  });
});

describe('shouldFallbackToBundledScanner', () => {
  test('does not fall back when the user canceled the Google scanner', () => {
    expect(shouldFallbackToBundledScanner(new Error('scan canceled.'))).toBe(false);
    expect(shouldFallbackToBundledScanner({ message: 'scan canceled.' })).toBe(false);
  });

  test('does not fall back when camera permission is denied', () => {
    expect(shouldFallbackToBundledScanner(new Error('User denied access to camera.'))).toBe(false);
  });

  test('falls back when Google scan cannot start', () => {
    expect(shouldFallbackToBundledScanner(new Error(
      'The Google Barcode Scanner Module is not available. You must install it first using the installGoogleBarcodeScannerModule method.',
    ))).toBe(true);
    expect(shouldFallbackToBundledScanner(new Error('17: API_NOT_CONNECTED'))).toBe(true);
    expect(shouldFallbackToBundledScanner(new Error('module install timed out'))).toBe(true);
  });
});

describe('scanConnectionQr bundled CameraX cancel cleanup', () => {
  test('clears the active class and cancel button before stopScan settles', async () => {
    const scanPromise = scanConnectionQr();
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains(BUNDLED_SCANNER_ACTIVE_CLASS)).toBe(true);
      expect(document.querySelector('.oc-barcode-scanner-chrome')).not.toBeNull();
    });

    document.querySelector<HTMLButtonElement>('.oc-barcode-scanner-chrome')?.click();
    await vi.waitFor(() => {
      expect(stopScan).toHaveBeenCalledTimes(1);
    });

    // Visibility must recover before native stopScan finishes — otherwise the
    // page stays blank behind the transparent WebView while CameraX tears down.
    expect(document.documentElement.classList.contains(BUNDLED_SCANNER_ACTIVE_CLASS)).toBe(false);
    expect(document.querySelector('.oc-barcode-scanner-chrome')).toBeNull();
    expect(removeBarcode).toHaveBeenCalledTimes(1);
    expect(removeError).toHaveBeenCalledTimes(1);

    resolveStopScan();
    await expect(scanPromise).resolves.toEqual({ status: 'cancelled' });
  });

  test('still clears the active class when cancel-button detach races with DOM removal', async () => {
    const originalRemoveChild = Node.prototype.removeChild;
    const removeChildSpy = vi.spyOn(Node.prototype, 'removeChild').mockImplementation(function (
      this: Node,
      child: Node,
    ) {
      if (
        this === document.body
        && child instanceof HTMLElement
        && child.classList.contains('oc-barcode-scanner-chrome')
      ) {
        // Simulate a concurrent detach (e.g. React removeChild) before our cleanup runs.
        if (child.parentNode === document.body) originalRemoveChild.call(document.body, child);
        throw new DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
      }
      return originalRemoveChild.call(this, child);
    });

    const scanPromise = scanConnectionQr();
    await vi.waitFor(() => {
      expect(document.querySelector('.oc-barcode-scanner-chrome')).not.toBeNull();
    });

    document.querySelector<HTMLButtonElement>('.oc-barcode-scanner-chrome')?.click();
    await vi.waitFor(() => {
      expect(stopScan).toHaveBeenCalledTimes(1);
    });
    resolveStopScan();
    await expect(scanPromise).resolves.toEqual({ status: 'cancelled' });

    expect(document.documentElement.classList.contains(BUNDLED_SCANNER_ACTIVE_CLASS)).toBe(false);
    expect(document.querySelector('.oc-barcode-scanner-chrome')).toBeNull();
    expect(stopScan).toHaveBeenCalledTimes(1);
    removeChildSpy.mockRestore();
  });
});
