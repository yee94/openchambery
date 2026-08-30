import { describe, expect, test } from 'vitest';

import {
  evaluateNativeIosTabBarAvailability,
  isNativeIosTabId,
  nativeIosTabBarAppearanceFromRoot,
  nativeTabBarStatesEqual,
  NATIVE_IOS_TAB_BAR_CLASS,
  parseNativeIosTabId,
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
    expect(nativeTabBarStatesEqual(state(), state({ ariaLabel: 'Nav' }))).toBe(false);
    expect(nativeTabBarStatesEqual(
      state(),
      state({ tabs: [{ id: 'projects', label: '项目' }] }),
    )).toBe(false);
  });
});
