/**
 * Documented Cap-plugin-style host message channel for Lynx JS.
 *
 * Cap plugins expose `Plugin.call('method', args)` + `addListener`.
 * Lynx host mirrors that with:
 * - `invoke(command)` → page→host (`LynxPageToHostCommand`)
 * - `emit(event)` / `subscribe(listener)` → host→page (`LynxHostBridgeEvent`)
 *
 * Adapters (camera, secure store, OAuth, IME, HTTP, virtual asset) inject
 * binders that the host wires before first paint. This channel is the
 * single dispatch surface so Lynx screens never call native APIs directly.
 */
import type { LynxHostBridgeEvent, LynxPageToHostCommand } from './bridge';
import type { LynxCameraAdapter } from './camera';
import type { LynxHttpClientAdapter } from './httpClient';
import type { LynxImeInsetPublisher } from './imeInset';
import type { LynxOAuthBrowserAdapter } from './oauthBrowser';
import type { LynxSecureStoreAdapter } from './secureStore';
import type { LynxVirtualAssetAdapter } from './virtualAsset';
import { openOAuthAuthorizeCommand, scanPairingQrCommand } from './bridge';

export type LynxHostChannelListener = (event: LynxHostBridgeEvent) => void;

export type LynxHostChannelDispatch = (command: LynxPageToHostCommand) => void | Promise<void>;

export type LynxHostChannelAdapters = {
  camera?: LynxCameraAdapter;
  secureStore?: LynxSecureStoreAdapter;
  http?: LynxHttpClientAdapter;
  oauthBrowser?: LynxOAuthBrowserAdapter;
  imeInset?: LynxImeInsetPublisher;
  virtualAsset?: LynxVirtualAssetAdapter;
};

export type LynxHostChannel = {
  /** Cap `Plugin.call` analogue. */
  invoke: (command: LynxPageToHostCommand) => Promise<void>;
  /** Cap `addListener` analogue. */
  subscribe: (listener: LynxHostChannelListener) => () => void;
  /** Host → page emit (tests / native bridge sink). */
  emit: (event: LynxHostBridgeEvent) => void;
  adapters: LynxHostChannelAdapters;
  /** Convenience: open QR scan via camera adapter or host command. */
  scanPairingQr: () => Promise<void>;
  /** Convenience: open OAuth authorize URL via oauth adapter or host command. */
  openOAuthAuthorize: (input: {
    url: string;
    callbackScheme?: string;
    prefersEphemeral?: boolean;
  }) => Promise<void>;
};

export const LYNX_HOST_CHANNEL_METHODS = [
  'setActiveTab',
  'hideHostTabChrome',
  'showHostTabChrome',
  'reportOccupancy',
  'openInstances',
  'scanPairingQr',
  'openOAuthAuthorize',
  'subscribeImeInsets',
  'unsubscribeImeInsets',
  'registerVirtualAssetScheme',
  'secureStore',
] as const;

export const createLynxHostChannel = (input?: {
  dispatch?: LynxHostChannelDispatch;
  adapters?: LynxHostChannelAdapters;
}): LynxHostChannel => {
  const listeners = new Set<LynxHostChannelListener>();
  const adapters = input?.adapters ?? {};
  const dispatch = input?.dispatch;

  const invoke = async (command: LynxPageToHostCommand): Promise<void> => {
    if (command.type === 'scanPairingQr' && adapters.camera) {
      const result = await adapters.camera.scanPairingQr();
      if (result.status === 'ok' && 'url' in result) {
        emit({ type: 'qrScanResult', rawValue: result.url });
        return;
      }
      if (result.status === 'pairing' && 'pairing' in result) {
        emit({ type: 'qrScanResult', rawValue: JSON.stringify({ pairing: result.pairing }) });
        return;
      }
      if (result.status === 'cancelled') {
        emit({ type: 'qrScanCancelled' });
        return;
      }
      if (result.status === 'failed') {
        emit({ type: 'qrScanFailed', error: result.error || 'scan failed' });
        return;
      }
      // unavailable / unsupported / invalid / permission — still surface to host dispatch
    }
    if (command.type === 'openOAuthAuthorize' && adapters.oauthBrowser) {
      const result = await adapters.oauthBrowser.openAuthorize({
        url: command.url,
        callbackScheme: command.callbackScheme,
        prefersEphemeral: command.prefersEphemeral,
      });
      if (result.status === 'ok' && result.callbackUrl) {
        emit({ type: 'oauthCallback', callbackUrl: result.callbackUrl });
        return;
      }
      if (result.status === 'cancelled' || (result.status === 'ok' && result.cancelled)) {
        emit({ type: 'oauthCancelled' });
        return;
      }
    }
    await dispatch?.(command);
  };

  const emit = (event: LynxHostBridgeEvent): void => {
    for (const listener of listeners) listener(event);
  };

  return {
    invoke,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit,
    adapters,
    scanPairingQr: () => invoke(scanPairingQrCommand()),
    openOAuthAuthorize: (opts) => invoke(openOAuthAuthorizeCommand(opts)),
  };
};
