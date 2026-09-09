import { afterEach, describe, expect, test } from 'vitest';

import { useMobileNavigationStore } from './useMobileNavigationStore';

describe('mobile settings returnTo', () => {
  afterEach(() => {
    useMobileNavigationStore.getState().reset();
  });

  test('openSettingsFromCurrent remembers assistant conversation and restore brings it back', () => {
    const store = useMobileNavigationStore.getState();
    store.setActiveTab('assistant');
    store.openAssistant('asst_1');

    useMobileNavigationStore.getState().openSettingsFromCurrent();
    expect(useMobileNavigationStore.getState()).toMatchObject({
      activeTab: 'settings',
      secondary: null,
      settingsReturnTo: {
        tab: 'assistant',
        secondary: { kind: 'assistant' },
      },
    });

    const restored = useMobileNavigationStore.getState().restoreSettingsReturnTo();
    expect(restored).toEqual({
      tab: 'assistant',
      secondary: { kind: 'assistant' },
    });
    expect(useMobileNavigationStore.getState()).toMatchObject({
      activeTab: 'assistant',
      secondary: { kind: 'assistant' },
      settingsReturnTo: null,
    });
  });

  test('setActiveTab clears the Settings origin', () => {
    const store = useMobileNavigationStore.getState();
    store.setActiveTab('assistant');
    store.openSettingsFromCurrent();
    store.setActiveTab('projects');

    expect(useMobileNavigationStore.getState().settingsReturnTo).toBeNull();
    expect(useMobileNavigationStore.getState().restoreSettingsReturnTo()).toBeNull();
  });

  test('opening Settings while already on that tab has no origin', () => {
    useMobileNavigationStore.getState().setActiveTab('settings');
    useMobileNavigationStore.getState().openSettingsFromCurrent();
    expect(useMobileNavigationStore.getState().settingsReturnTo).toBeNull();
  });
});
