import type { LynxTabId } from '../shell/tabs';
import type { LynxEmbeddingMode, LynxHostPlatform } from './embedding';

/**
 * Host ↔ Lynx page channel. Native never owns the Lynx route stack.
 * Taps emit `tabSelected`; Lynx/JS still commits `setActiveTab` (Cap pattern).
 *
 * Cap plugin spirit: JS invokes page→host commands; host emits events back.
 * See `hostChannel.ts` for the documented invoke/listen surface.
 */
export type LynxHostBridgeEvent =
  | { type: 'tabSelected'; tab: LynxTabId }
  | { type: 'backProgress'; progress: number }
  | { type: 'backCommit' }
  | { type: 'backCancel' }
  | { type: 'keyboardInset'; height: number }
  | { type: 'imeInset'; keyboardHeight: number; safeAreaBottom: number; collapsedComposerHeight: number }
  | { type: 'predictiveBackProgress'; progress: number }
  | { type: 'predictiveBackCommit' }
  | { type: 'predictiveBackCancel' }
  | { type: 'qrScanResult'; rawValue: string }
  | { type: 'qrScanCancelled' }
  | { type: 'qrScanFailed'; error: string }
  | { type: 'oauthCallback'; callbackUrl: string }
  | { type: 'oauthCancelled' };

export type LynxPageToHostCommand =
  | { type: 'setActiveTab'; tab: LynxTabId }
  | { type: 'hideHostTabChrome' }
  | { type: 'showHostTabChrome' }
  | { type: 'reportOccupancy'; collapsedComposerHeight: number }
  | { type: 'openInstances' }
  | { type: 'scanPairingQr' }
  | { type: 'openOAuthAuthorize'; url: string; callbackScheme?: string; prefersEphemeral?: boolean }
  | { type: 'subscribeImeInsets' }
  | { type: 'unsubscribeImeInsets' }
  | { type: 'registerVirtualAssetScheme' }
  | {
      type: 'secureStore';
      op: 'get' | 'set' | 'delete';
      prefixedKey: string;
      data?: string;
      access?: number;
    };

export type LynxHostBridgeSnapshot = {
  platform: LynxHostPlatform;
  embeddingMode: LynxEmbeddingMode;
  selectedTab: LynxTabId;
  hostTabChromeVisible: boolean;
};

export function hostTabChromeCommand(visible: boolean): LynxPageToHostCommand {
  return visible ? { type: 'showHostTabChrome' } : { type: 'hideHostTabChrome' };
}

export function scanPairingQrCommand(): LynxPageToHostCommand {
  return { type: 'scanPairingQr' };
}

export function openOAuthAuthorizeCommand(input: {
  url: string;
  callbackScheme?: string;
  prefersEphemeral?: boolean;
}): LynxPageToHostCommand {
  return {
    type: 'openOAuthAuthorize',
    url: input.url,
    callbackScheme: input.callbackScheme,
    prefersEphemeral: input.prefersEphemeral,
  };
}
