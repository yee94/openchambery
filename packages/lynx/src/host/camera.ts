/**
 * Cap BarcodeScanner spirit for Lynx 扫一扫.
 * Host injects a camera binder. Without host → unavailable (never fake pairing).
 * Source Cap: packages/ui/src/apps/mobileQrScan.ts
 */
import { parseConnectionPayload, type LynxConnectionPayload, type LynxPairingPayload } from '../pairing/scan';

export type LynxCameraScanRawResult =
  | { status: 'ok'; rawValue: string }
  | { status: 'cancelled' }
  | { status: 'permission-denied' }
  | { status: 'unavailable' }
  | { status: 'failed'; error: string };

export type LynxCameraScanBinder = {
  scanPairingQr: () => Promise<LynxCameraScanRawResult>;
};

export type LynxQrScanResult =
  | ({ status: 'ok' } & LynxConnectionPayload)
  | ({ status: 'pairing' } & LynxPairingPayload)
  | { status: 'cancelled' }
  | { status: 'permission-denied' }
  | { status: 'unsupported' }
  | { status: 'unavailable'; reason: 'no-host' }
  | { status: 'invalid' }
  | { status: 'failed'; error?: string };

export type LynxCameraAdapter = {
  inject: (binder: LynxCameraScanBinder | null) => void;
  isAvailable: () => boolean;
  /** Open host camera QR. No host → unavailable (honest). */
  scanPairingQr: () => Promise<LynxQrScanResult>;
};

export const createLynxCameraAdapter = (): LynxCameraAdapter => {
  let binder: LynxCameraScanBinder | null = null;
  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    scanPairingQr: async (): Promise<LynxQrScanResult> => {
      if (!binder) return { status: 'unavailable', reason: 'no-host' };
      try {
        const raw = await binder.scanPairingQr();
        if (raw.status === 'cancelled') return { status: 'cancelled' };
        if (raw.status === 'permission-denied') return { status: 'permission-denied' };
        if (raw.status === 'unavailable') return { status: 'unsupported' };
        if (raw.status === 'failed') return { status: 'failed', error: raw.error };
        const parsed = parseConnectionPayload(raw.rawValue);
        if (!parsed) return { status: 'invalid' };
        if ('pairing' in parsed) return { status: 'pairing', pairing: parsed.pairing };
        return { status: 'ok', ...parsed };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
