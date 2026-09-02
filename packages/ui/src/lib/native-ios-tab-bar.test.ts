import { describe, expect, test } from 'vitest';

import {
  evaluateNativeIosTabBarAvailability,
  isNativeIosTabId,
  nativeIosTabBarAppearanceFromRoot,
  nativeTabBarStatesEqual,
  NATIVE_IOS_TAB_BAR_CLASS,
  parseNativeIosTabId,
  resolveNativeIosTabBarSync,
  resolveNativeIosTabBarVisible,
  setNativeTabBarDocumentClass,
  type NativeIosTabBarState,
} from './native-ios-tab-bar';

const state = (overrides: Partial<NativeIosTabBarState> = {}): NativeIosTabBarState => ({
  tabs: [
    { id: 'projects', label: 'Projects' },
    { id: 'assistant', label: 'Agent' },
    { id: 'scheduled', label: 'Schedule' },
    { id: 'settings', label: 'Settings' },
  ],
  selectedTab: 'projects',
  appearance: 'dark',
  accentColor: '#edb449',
  ariaLabel: 'Mobile navigation',
  ...overrides,
});

describe('native iOS tab bar contract', () => {
  test('is available only on Capacitor iOS with the plugin registered', () => {
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
    })).toBe(true);
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: true,
      platform: 'android',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: false,
      platform: 'ios',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: false,
    })).toBe(false);
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      nativeUiEnabled: false,
    })).toBe(false);
    expect(evaluateNativeIosTabBarAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      nativeUiEnabled: true,
    })).toBe(true);
  });

  test('parses allowlisted tab ids and rejects anything else', () => {
    expect(parseNativeIosTabId('projects')).toBe('projects');
    expect(parseNativeIosTabId('assistant')).toBe('assistant');
    expect(parseNativeIosTabId('scheduled')).toBe('scheduled');
    expect(parseNativeIosTabId('settings')).toBe('settings');
    expect(parseNativeIosTabId('chat')).toBeNull();
    expect(parseNativeIosTabId('')).toBeNull();
    expect(parseNativeIosTabId(1)).toBeNull();
    expect(isNativeIosTabId('projects')).toBe(true);
    expect(isNativeIosTabId('plan')).toBe(false);
  });

  test('toggles the document class used to hide the web dock', () => {
    const root = document.createElement('html');
    setNativeTabBarDocumentClass(root, true);
    expect(root.classList.contains(NATIVE_IOS_TAB_BAR_CLASS)).toBe(true);
    setNativeTabBarDocumentClass(root, false);
    expect(root.classList.contains(NATIVE_IOS_TAB_BAR_CLASS)).toBe(false);
  });

  test('reads appearance from the root dark class', () => {
    const root = document.createElement('html');
    expect(nativeIosTabBarAppearanceFromRoot(root)).toBe('light');
    root.classList.add('dark');
    expect(nativeIosTabBarAppearanceFromRoot(root)).toBe('dark');
  });

  test('treats identical tab-bar states as equal so updates can skip', () => {
    expect(nativeTabBarStatesEqual(state(), state())).toBe(true);
    expect(nativeTabBarStatesEqual(state(), state({ selectedTab: 'settings' }))).toBe(false);
    expect(nativeTabBarStatesEqual(state(), state({ appearance: 'light' }))).toBe(false);
    expect(nativeTabBarStatesEqual(state(), state({ accentColor: '#22c55e' }))).toBe(false);
    expect(nativeTabBarStatesEqual(state(), state({ ariaLabel: 'Nav' }))).toBe(false);
    expect(nativeTabBarStatesEqual(
      state(),
      state({ tabs: [{ id: 'projects', label: '项目' }] }),
    )).toBe(false);
  });

  test('hides the native dock while a mobile overlay is active, matching the web sheet cover', () => {
    expect(resolveNativeIosTabBarVisible(true, false)).toBe(true);
    expect(resolveNativeIosTabBarVisible(true, true)).toBe(false);
    expect(resolveNativeIosTabBarVisible(false, false)).toBe(false);
    expect(resolveNativeIosTabBarVisible(false, true)).toBe(false);
  });

  test('hides and re-presents the same dock without dropping lastState', () => {
    const current = state();
    expect(resolveNativeIosTabBarSync({
      visible: false,
      overlayHidden: false,
      lastState: current,
      nextState: current,
    })).toEqual({ action: 'hide' });
    expect(resolveNativeIosTabBarSync({
      visible: false,
      overlayHidden: true,
      lastState: current,
      nextState: current,
    })).toEqual({ action: 'skip' });
    expect(resolveNativeIosTabBarSync({
      visible: true,
      overlayHidden: true,
      lastState: current,
      nextState: current,
    })).toEqual({ action: 'present' });
    expect(resolveNativeIosTabBarSync({
      visible: true,
      overlayHidden: false,
      lastState: current,
      nextState: current,
    })).toEqual({ action: 'skip' });
    expect(resolveNativeIosTabBarSync({
      visible: true,
      overlayHidden: false,
      lastState: current,
      nextState: state({ selectedTab: 'settings' }),
    })).toEqual({ action: 'present' });
  });
});
