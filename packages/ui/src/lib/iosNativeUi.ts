import { create } from 'zustand';

import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

/** Persist off as `'0'`. Missing / any other value means native UI stays on. */
export const IOS_NATIVE_UI_STORAGE_KEY = 'openchamber.iosNativeUi';

export const readStoredIosNativeUiEnabled = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
};

export const persistIosNativeUiEnabled = (enabled: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.removeItem(IOS_NATIVE_UI_STORAGE_KEY);
    } else {
      window.localStorage.setItem(IOS_NATIVE_UI_STORAGE_KEY, '0');
    }
  } catch {
    // Restricted storage still applies the in-memory flag for this session.
  }
};

type IosNativeUiStore = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

export const useIosNativeUiStore = create<IosNativeUiStore>((set) => ({
  enabled: readStoredIosNativeUiEnabled(),
  setEnabled: (enabled) => {
    persistIosNativeUiEnabled(enabled);
    set({ enabled });
  },
}));

/** JS-layer kill switch. Plugin registration stays true even when this is off. */
export const isIosNativeUiEnabled = (): boolean => useIosNativeUiStore.getState().enabled;

export const useIosNativeUiEnabled = (): boolean => useIosNativeUiStore((state) => state.enabled);

/** Appearance row + search: Capacitor iOS only, independent of the current toggle. */
export const canShowIosNativeUiSetting = (): boolean => (
  isCapacitorApp() && getClientPlatform() === 'ios'
);
