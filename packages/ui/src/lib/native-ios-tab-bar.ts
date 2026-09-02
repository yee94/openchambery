import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { isIosNativeUiEnabled } from '@/lib/iosNativeUi';
import { resolveCssVarToHex } from '@/lib/native-ios-composer';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

export const NATIVE_IOS_TAB_BAR_CLASS = 'oc-native-ios-tab-bar';
const NATIVE_IOS_TAB_BAR_PLUGIN = 'OpenChamberTabBar';

export type NativeIosTabId = 'projects' | 'assistant' | 'scheduled' | 'settings';

const NATIVE_IOS_TAB_IDS: readonly NativeIosTabId[] = [
  'projects',
  'assistant',
  'scheduled',
  'settings',
];

export type NativeIosTabBarAppearance = 'dark' | 'light';

export type NativeIosTabBarItem = {
  id: NativeIosTabId;
  label: string;
};

export type NativeIosTabBarState = {
  tabs: NativeIosTabBarItem[];
  selectedTab: NativeIosTabId;
  appearance: NativeIosTabBarAppearance;
  ariaLabel: string;
  accentColor: string;
};

export type NativeIosTabBarPresentResult = {
  adopted?: boolean;
};

export type NativeIosTabBarEventName = 'tabSelected' | 'heightChanged';

export type NativeIosTabBarEventPayload = {
  tab?: string;
  height?: number;
};

export type NativeIosTabBarPlugin = {
  present: (state: NativeIosTabBarState) => Promise<NativeIosTabBarPresentResult>;
  update: (state: Partial<NativeIosTabBarState>) => Promise<NativeIosTabBarPresentResult>;
  hide: () => Promise<void>;
  dismiss: () => Promise<void>;
  addListener: (
    event: NativeIosTabBarEventName,
    listener: (payload: NativeIosTabBarEventPayload) => void,
  ) => Promise<PluginListenerHandle>;
};

const OpenChamberTabBar = registerPlugin<NativeIosTabBarPlugin>(NATIVE_IOS_TAB_BAR_PLUGIN);

export type NativeIosTabBarAvailabilityInput = {
  isCapacitor: boolean;
  platform: string;
  pluginAvailable: boolean;
  nativeUiEnabled?: boolean;
};

export const evaluateNativeIosTabBarAvailability = (
  input: NativeIosTabBarAvailabilityInput,
): boolean => (
  input.isCapacitor
  && input.platform === 'ios'
  && input.pluginAvailable
  && input.nativeUiEnabled !== false
);

/** True on Capacitor iOS when the native tab-bar plugin is registered and native UI is on. Glass adoption is decided natively. */
export function canUseNativeIosTabBar(): boolean {
  if (typeof window === 'undefined') return false;
  return evaluateNativeIosTabBarAvailability({
    isCapacitor: isCapacitorApp(),
    platform: getClientPlatform(),
    pluginAvailable: Capacitor.isPluginAvailable(NATIVE_IOS_TAB_BAR_PLUGIN),
    nativeUiEnabled: isIosNativeUiEnabled(),
  });
}

export const nativeIosTabBarAppearanceFromRoot = (root: {
  classList: { contains: (name: string) => boolean };
}): NativeIosTabBarAppearance => (root.classList.contains('dark') ? 'dark' : 'light');

export const nativeIosTabBarAccentFromRoot = (): string => resolveCssVarToHex('--primary');

export const isNativeIosTabId = (value: string | null | undefined): value is NativeIosTabId => (
  typeof value === 'string' && (NATIVE_IOS_TAB_IDS as readonly string[]).includes(value)
);

export const parseNativeIosTabId = (value: unknown): NativeIosTabId | null => (
  typeof value === 'string' && isNativeIosTabId(value) ? value : null
);

export const nativeTabBarStatesEqual = (
  left: NativeIosTabBarState,
  right: NativeIosTabBarState,
): boolean => (
  left.selectedTab === right.selectedTab
  && left.appearance === right.appearance
  && left.ariaLabel === right.ariaLabel
  && left.accentColor === right.accentColor
  && left.tabs.length === right.tabs.length
  && left.tabs.every((tab, index) => (
    tab.id === right.tabs[index]?.id && tab.label === right.tabs[index]?.label
  ))
);

export const setNativeTabBarDocumentClass = (root: HTMLElement, active: boolean): void => {
  root.classList.toggle(NATIVE_IOS_TAB_BAR_CLASS, active);
};

/** Same suppress rule as the web dock under `#mobile-overlay-root` sheets. */
export const resolveNativeIosTabBarVisible = (
  requested: boolean,
  overlayBusy: boolean,
): boolean => requested && !overlayBusy;

export type NativeIosTabBarSyncDecision =
  | { action: 'hide' }
  | { action: 'skip' }
  | { action: 'present' };

/**
 * Hide/show the process-owned dock without dropping lastState.
 * Clearing lastState on hide forced a full present() on every return from
 * chat, unlike the composer overlay which conceal/reveals the same view.
 */
export const resolveNativeIosTabBarSync = (input: {
  visible: boolean;
  overlayHidden: boolean;
  lastState: NativeIosTabBarState | null;
  nextState: NativeIosTabBarState;
}): NativeIosTabBarSyncDecision => {
  if (!input.visible) {
    return input.overlayHidden ? { action: 'skip' } : { action: 'hide' };
  }
  if (input.overlayHidden) return { action: 'present' };
  if (input.lastState && nativeTabBarStatesEqual(input.lastState, input.nextState)) {
    return { action: 'skip' };
  }
  return { action: 'present' };
};

export const getNativeIosTabBarPlugin = (): NativeIosTabBarPlugin => OpenChamberTabBar;
