import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useMobileNavigationStore } from './useMobileNavigationStore';
import { getSelectedAssistantID, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

describe('Assistant worker return navigation', () => {
  beforeEach(() => {
    useMobileNavigationStore.getState().reset();
    vi.spyOn(useSessionUIStore.getState(), 'setCurrentSession').mockResolvedValue(undefined);
  });
  afterEach(() => {
    useMobileNavigationStore.getState().reset();
    vi.restoreAllMocks();
  });

  test('nested chats, btw and replacement preserve the exact Assistant origin', () => {
    const store = useMobileNavigationStore.getState();
    store.setActiveTab('assistant');
    store.openAssistant('asst_origin');
    store.openSession({ sessionId: 'ses_worker', directory: '/workspace' });
    store.reconcileChatPredecessor({ sessionId: 'ses_unvisited_parent', directory: '/workspace' });
    const first = useMobileNavigationStore.getState().secondary;
    expect(first).toMatchObject({
      kind: 'chat',
      routes: [{ sessionId: 'ses_worker' }],
      returnTo: { tab: 'assistant', assistantID: 'asst_origin' },
    });
    store.pushSession({ sessionId: 'ses_child', directory: '/workspace' });
    store.pushBtw({ sessionId: 'ses_child', directory: '/workspace' });
    store.popBtw();
    store.popChatSession();
    expect(useMobileNavigationStore.getState().secondary).toEqual(first);
    store.replaceChatSession({ sessionId: 'ses_other', directory: '/other' });
    useAssistantUIStore.getState().selectAssistant('asst_other');
    store.popChatSession();
    expect(getSelectedAssistantID()).toBe('asst_origin');
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'assistant', secondary: { kind: 'assistant' } });
    store.closeSecondary();
    expect(useMobileNavigationStore.getState().secondary).toBeNull();
  });

  test.each(['tab', 'runtime'] as const)('%s switch drops the previous return destination', (kind) => {
    const store = useMobileNavigationStore.getState();
    store.setActiveTab('assistant');
    store.openAssistant('asst_origin');
    store.openSession({ sessionId: 'ses_worker', directory: '/workspace' });
    if (kind === 'tab') store.setActiveTab('projects');
    else store.reset();
    store.openSession({ sessionId: 'ses_fresh', directory: '/new-workspace' });
    store.closeSecondary();
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'projects', secondary: null });
  });

  test('project and cold-link entry still reconcile parents and return to their root', () => {
    const store = useMobileNavigationStore.getState();
    store.openSession({ sessionId: 'ses_child', directory: '/workspace' });
    store.reconcileChatPredecessor({ sessionId: 'ses_parent', directory: '/workspace' });
    store.popChatSession();
    expect(useMobileNavigationStore.getState().secondary).toMatchObject({ kind: 'chat', routes: [{ sessionId: 'ses_parent' }] });
    store.popChatSession();
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'projects', secondary: null });
  });
});

describe('assistant Settings push page', () => {
  afterEach(() => useMobileNavigationStore.getState().reset());

  test('push and pop preserve the conversation, root tab and Settings selection', () => {
    const store = useMobileNavigationStore.getState();
    store.setActiveTab('assistant');
    store.openAssistant('asst_1');
    const settingsPage = useUIStore.getState().settingsPage;
    const settingsSelection = useAssistantUIStore.getState().settingsSelectedAssistantID;
    const revision = useAssistantUIStore.getState().openSettingsRequestRevision;

    for (let visit = 0; visit < 2; visit += 1) {
      store.pushAssistantSettings('asst_1');
      expect(useMobileNavigationStore.getState()).toMatchObject({
        activeTab: 'assistant',
        secondary: { kind: 'assistant', settingsAssistantID: 'asst_1' },
        settingsReturnTo: null,
      });
      const pushed = useMobileNavigationStore.getState().secondary;
      store.pushAssistantSettings('asst_1');
      expect(useMobileNavigationStore.getState().secondary).toBe(pushed);
      store.popAssistantSettings();
      expect(useMobileNavigationStore.getState().secondary).toEqual({ kind: 'assistant' });
    }
    expect(useUIStore.getState().settingsPage).toBe(settingsPage);
    expect(useAssistantUIStore.getState().settingsSelectedAssistantID).toBe(settingsSelection);
    expect(useAssistantUIStore.getState().openSettingsRequestRevision).toBe(revision);
    store.closeSecondary();
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'assistant', secondary: null });
  });

  test('tab changes and runtime reset discard the pushed Settings detail', () => {
    const store = useMobileNavigationStore.getState();
    store.openAssistant('asst_1');
    store.pushAssistantSettings('asst_1');
    store.setActiveTab('projects');
    store.popAssistantSettings();
    store.pushAssistantSettings('asst_1');
    expect(useMobileNavigationStore.getState().secondary).toBeNull();
    store.openAssistant('asst_2');
    store.pushAssistantSettings('asst_2');
    store.reset();
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'projects', secondary: null });
  });
});

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
