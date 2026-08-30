import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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
};

export const evaluateNativeIosTabBarAvailability = (
  input: NativeIosTabBarAvailabilityInput,
): boolean => input.isCapacitor && input.platform === 'ios' && input.pluginAvailable;

/** True on Capacitor iOS when the native tab-bar plugin is registered. Glass adoption is decided natively. */
export function canUseNativeIosTabBar(): boolean {
  if (typeof window === 'undefined') return false;
  return evaluateNativeIosTabBarAvailability({
    isCapacitor: isCapacitorApp(),
    platform: getClientPlatform(),
    pluginAvailable: Capacitor.isPluginAvailable(NATIVE_IOS_TAB_BAR_PLUGIN),
  });
}

export const nativeIosTabBarAppearanceFromRoot = (root: {
  classList: { contains: (name: string) => boolean };
}): NativeIosTabBarAppearance => (root.classList.contains('dark') ? 'dark' : 'light');

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
  && left.tabs.length === right.tabs.length
  && left.tabs.every((tab, index) => (
    tab.id === right.tabs[index]?.id && tab.label === right.tabs[index]?.label
  ))
);

export const setNativeTabBarDocumentClass = (root: HTMLElement, active: boolean): void => {
  root.classList.toggle(NATIVE_IOS_TAB_BAR_CLASS, active);
};

export const getNativeIosTabBarPlugin = (): NativeIosTabBarPlugin => OpenChamberTabBar;
