import type { LynxTabId } from '../shell/tabs';
import type { LynxEmbeddingMode, LynxHostPlatform } from './embedding';

/**
 * Host ↔ Lynx page channel. Native never owns the Lynx route stack.
 * Taps emit `tabSelected`; Lynx/JS still commits `setActiveTab` (Cap pattern).
 */
export type LynxHostBridgeEvent =
  | { type: 'tabSelected'; tab: LynxTabId }
  | { type: 'backProgress'; progress: number }
  | { type: 'backCommit' }
  | { type: 'backCancel' }
  | { type: 'keyboardInset'; height: number }
  | { type: 'predictiveBackProgress'; progress: number }
  | { type: 'predictiveBackCommit' }
  | { type: 'predictiveBackCancel' };

export type LynxPageToHostCommand =
  | { type: 'setActiveTab'; tab: LynxTabId }
  | { type: 'hideHostTabChrome' }
  | { type: 'showHostTabChrome' }
  | { type: 'reportOccupancy'; collapsedComposerHeight: number }
  | { type: 'openInstances' };

export type LynxHostBridgeSnapshot = {
  platform: LynxHostPlatform;
  embeddingMode: LynxEmbeddingMode;
  selectedTab: LynxTabId;
  hostTabChromeVisible: boolean;
};

export function hostTabChromeCommand(visible: boolean): LynxPageToHostCommand {
  return visible ? { type: 'showHostTabChrome' } : { type: 'hideHostTabChrome' };
}
