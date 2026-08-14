// Connection payload parsing + native QR scanning for the dedicated mobile app.
//
// Pairing v2 links (openchamber://connect?v=2&p=<base64url>) carry a one-time
// secret and a list of transport candidates (lan / tunnel / relay); they are
// redeemed server-side over whichever candidate connects first. We also accept a
// bare http(s) URL so a QR encoding only the server address works.
//
// QR scanning is delegated to the native BarcodeScanner plugin. Capacitor 8 exposes
// its JavaScript proxy through registerPlugin(); capability checks still require a
// native platform with the corresponding native plugin installed.
//
// Android: call the Google ready-made scan() first so devices with Play Services
// keep that UI. If scan() fails (missing GMS / barcode module), fall back to the
// plugin's CameraX startScan() which bundles the barcode model. User cancel and
// camera permission denial do not fall back.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { parsePairingConnectionPayload, type PairingConnectionPayload } from '@/lib/connectionPayload';

export type MobileConnectionPayload = {
  url: string;
  clientToken?: string;
  label?: string;
};

export type MobilePairingPayload = {
  pairing: PairingConnectionPayload;
};

export type QrScanResult =
  | ({ status: 'ok' } & MobileConnectionPayload)
  | ({ status: 'pairing' } & MobilePairingPayload)
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'permission-denied' }
  | { status: 'invalid' }
  | { status: 'failed' };

type ScannedBarcode = { rawValue?: string; displayValue?: string };
type ListenerHandle = { remove: () => void | Promise<void> };

type BarcodeScannerPlugin = {
  requestPermissions?: () => Promise<{ camera?: string } | undefined>;
  scan?: (options?: { formats?: string[] }) => Promise<{ barcodes?: ScannedBarcode[] } | undefined>;
  startScan?: (options?: { formats?: string[] }) => Promise<void>;
  stopScan?: () => Promise<void>;
  installGoogleBarcodeScannerModule?: () => Promise<void>;
  addListener?: (
    event: 'barcodesScanned' | 'scanError',
    cb: (info: { barcodes?: ScannedBarcode[]; message?: string }) => void,
  ) => Promise<ListenerHandle> | ListenerHandle;
};

const BarcodeScanner = registerPlugin<BarcodeScannerPlugin>('BarcodeScanner');
const BUNDLED_SCANNER_ACTIVE_CLASS = 'oc-barcode-scanner-active';

const getScannerPlugin = (): BarcodeScannerPlugin | null => {
  return isQrScanSupported() ? BarcodeScanner : null;
};

const isAndroid = (): boolean => {
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return capacitor?.getPlatform?.() === 'android';
};

const errorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return String(error ?? '');
};

// Plugin rejects with this exact string when the user backs out of Google's scanner.
export const isGoogleScanCanceledError = (error: unknown): boolean =>
  /^\s*scan canceled\.?\s*$/i.test(errorMessage(error));

export const isCameraPermissionDeniedError = (error: unknown): boolean =>
  /denied access to camera/i.test(errorMessage(error));

// Anything other than user-cancel / permission-denied is a scanner that never
// started — safe to retry with the bundled CameraX path on Android.
export const shouldFallbackToBundledScanner = (error: unknown): boolean =>
  !isGoogleScanCanceledError(error) && !isCameraPermissionDeniedError(error);

const isGoogleModuleUnavailableError = (error: unknown): boolean => {
  const message = errorMessage(error);
  return /module/i.test(message) && /not\s*available|unavailable/i.test(message);
};

const kickoffGoogleScannerModuleInstall = (plugin: BarcodeScannerPlugin): void => {
  void plugin.installGoogleBarcodeScannerModule?.().catch(() => undefined);
};

export const parseConnectionPayload = (raw: string): MobileConnectionPayload | MobilePairingPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^openchamber:\/\//i.test(trimmed)) {
    const pairing = parsePairingConnectionPayload(trimmed);
    return pairing ? { pairing } : null;
  }

  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  return null;
};

const resultFromRawValue = (raw: string): QrScanResult => {
  const payload = parseConnectionPayload(raw);
  if (!payload) return { status: 'invalid' };
  if ('pairing' in payload) return { status: 'pairing', ...payload };
  return { status: 'ok', ...payload };
};

const setBundledScannerActive = (active: boolean): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(BUNDLED_SCANNER_ACTIVE_CLASS, active);
};

const mountBundledScannerCancel = (onCancel: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'oc-barcode-scanner-chrome';
  button.setAttribute('aria-label', 'Cancel');
  button.textContent = '×';
  button.addEventListener('click', onCancel);
  document.body.appendChild(button);
  return () => {
    button.removeEventListener('click', onCancel);
    button.remove();
  };
};

const scanWithBundledAndroidScanner = async (plugin: BarcodeScannerPlugin): Promise<QrScanResult> => {
  if (!plugin.startScan || !plugin.stopScan || !plugin.addListener) return { status: 'unsupported' };

  let barcodeListener: ListenerHandle | undefined;
  let errorListener: ListenerHandle | undefined;
  let removeCancel: (() => void) | undefined;
  let removeBack: (() => void) | undefined;
  let settled = false;
  let resolveResult: (result: QrScanResult) => void = () => undefined;

  const result = new Promise<QrScanResult>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (scanResult: QrScanResult) => {
    if (settled) return;
    settled = true;
    resolveResult(scanResult);
  };

  setBundledScannerActive(true);
  removeCancel = mountBundledScannerCancel(() => finish({ status: 'cancelled' }));

  try {
    const { App } = await import('@capacitor/app');
    const backHandle = await App.addListener('backButton', () => finish({ status: 'cancelled' }));
    removeBack = () => void backHandle.remove();
  } catch {
    removeBack = undefined;
  }

  try {
    const listenerResults = await Promise.allSettled([
      Promise.resolve(
        plugin.addListener('barcodesScanned', ({ barcodes }) => {
          const barcode = barcodes?.[0];
          const raw = (barcode?.rawValue ?? barcode?.displayValue ?? '').trim();
          if (raw) finish(resultFromRawValue(raw));
        }),
      ).then((handle) => {
        barcodeListener = handle;
      }),
      Promise.resolve(plugin.addListener('scanError', () => finish({ status: 'failed' }))).then((handle) => {
        errorListener = handle;
      }),
    ]);

    if (listenerResults.some(({ status }) => status === 'rejected')) {
      finish({ status: 'failed' });
    } else if (!settled) {
      void plugin.startScan({ formats: ['QR_CODE'] }).catch((error) => {
        if (isCameraPermissionDeniedError(error)) finish({ status: 'permission-denied' });
        else finish({ status: 'failed' });
      });
    }

    return await result;
  } finally {
    removeCancel?.();
    removeBack?.();
    setBundledScannerActive(false);
    await Promise.allSettled([
      Promise.resolve(barcodeListener?.remove()),
      Promise.resolve(errorListener?.remove()),
      plugin.stopScan(),
    ]);
  }
};

export const evaluateQrScanSupport = (input: {
  isNativePlatform: boolean;
  isPluginAvailable: boolean;
}): boolean => input.isNativePlatform && input.isPluginAvailable;

export const isQrScanSupported = (): boolean => evaluateQrScanSupport({
  isNativePlatform: Capacitor.isNativePlatform(),
  isPluginAvailable: Capacitor.isPluginAvailable('BarcodeScanner'),
});

export const scanConnectionQr = async (): Promise<QrScanResult> => {
  const plugin = getScannerPlugin();
  if (!plugin) return { status: 'unsupported' };

  try {
    if (plugin.requestPermissions) {
      const permission = await plugin.requestPermissions();
      const camera = permission?.camera;
      if (camera && camera !== 'granted' && camera !== 'limited') {
        return { status: 'permission-denied' };
      }
    }

    if (plugin.scan) {
      try {
        const result = await plugin.scan({ formats: ['QR_CODE'] });
        const barcode = result?.barcodes?.[0];
        const raw = (barcode?.rawValue ?? barcode?.displayValue ?? '').trim();
        return raw ? resultFromRawValue(raw) : { status: 'cancelled' };
      } catch (error) {
        if (isGoogleScanCanceledError(error)) return { status: 'cancelled' };
        if (isCameraPermissionDeniedError(error)) return { status: 'permission-denied' };
        if (isAndroid() && shouldFallbackToBundledScanner(error) && plugin.startScan) {
          // Don't wait on the module download — this scan already fell through.
          // Kick it off so a later Google scan() can use the ready-made UI.
          if (isGoogleModuleUnavailableError(error)) kickoffGoogleScannerModuleInstall(plugin);
          return scanWithBundledAndroidScanner(plugin);
        }
        return { status: 'failed' };
      }
    }

    if (isAndroid() && plugin.startScan) return scanWithBundledAndroidScanner(plugin);
    return { status: 'unsupported' };
  } catch {
    return { status: 'failed' };
  }
};
