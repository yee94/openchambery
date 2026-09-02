import { afterEach, describe, expect, test } from 'vitest';

import {
  IOS_NATIVE_UI_STORAGE_KEY,
  isIosNativeUiEnabled,
  persistIosNativeUiEnabled,
  readStoredIosNativeUiEnabled,
  useIosNativeUiStore,
} from './iosNativeUi';

const reset = (): void => {
  window.localStorage.removeItem(IOS_NATIVE_UI_STORAGE_KEY);
  useIosNativeUiStore.setState({ enabled: true });
};

afterEach(() => {
  reset();
});

describe('ios native UI setting', () => {
  test('defaults to enabled when nothing is stored', () => {
    expect(readStoredIosNativeUiEnabled()).toBe(true);
    expect(isIosNativeUiEnabled()).toBe(true);
  });

  test('persists off as 0 and reads back disabled', () => {
    persistIosNativeUiEnabled(false);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBe('0');
    expect(readStoredIosNativeUiEnabled()).toBe(false);
  });

  test('clearing storage turns native UI back on', () => {
    persistIosNativeUiEnabled(false);
    persistIosNativeUiEnabled(true);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBeNull();
    expect(readStoredIosNativeUiEnabled()).toBe(true);
  });

  test('store setter updates memory and storage together', () => {
    useIosNativeUiStore.getState().setEnabled(false);
    expect(isIosNativeUiEnabled()).toBe(false);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBe('0');
    useIosNativeUiStore.getState().setEnabled(true);
    expect(isIosNativeUiEnabled()).toBe(true);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBeNull();
  });
});
