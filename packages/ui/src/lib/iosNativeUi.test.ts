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
  useIosNativeUiStore.setState({ enabled: false });
};

afterEach(() => {
  reset();
});

describe('ios native UI setting', () => {
  test('defaults to disabled when nothing is stored', () => {
    expect(readStoredIosNativeUiEnabled()).toBe(false);
    expect(isIosNativeUiEnabled()).toBe(false);
  });

  test('persists on as 1 and reads back enabled', () => {
    persistIosNativeUiEnabled(true);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBe('1');
    expect(readStoredIosNativeUiEnabled()).toBe(true);
  });

  test('clearing storage turns native UI back off', () => {
    persistIosNativeUiEnabled(true);
    persistIosNativeUiEnabled(false);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBeNull();
    expect(readStoredIosNativeUiEnabled()).toBe(false);
  });

  test('store setter updates memory and storage together', () => {
    useIosNativeUiStore.getState().setEnabled(true);
    expect(isIosNativeUiEnabled()).toBe(true);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBe('1');
    useIosNativeUiStore.getState().setEnabled(false);
    expect(isIosNativeUiEnabled()).toBe(false);
    expect(window.localStorage.getItem(IOS_NATIVE_UI_STORAGE_KEY)).toBeNull();
  });
});
