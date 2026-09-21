import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({ currentSessionId: null, getDirectoryForSession: () => null })) };
});
vi.mock('@/queries/assistantQueries', () => ({ useAssistantUnreadTotal: () => 0 }));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => false }));
vi.mock('./useNativeIosTabBar', () => ({ useNativeIosTabBar: () => 'web' }));
vi.mock('@/lib/native-ios-composer-session', () => ({ nativeIosComposerSession: { shutdown: () => undefined } }));
vi.mock('./projects', () => ({ MobileProjectsHomeContainer: () => null }));
vi.mock('./assistant/MobileAssistantTab', () => ({ MobileAssistantTab: () => null }));
vi.mock('./scheduled/MobileScheduledTab', () => ({ MobileScheduledTab: () => null }));
vi.mock('./settings/MobileSettingsTab', () => ({
  MobileSettingsTab: () => <input data-settings-draft defaultValue="retained Settings draft" />,
}));
vi.mock('@/components/assistants/AssistantView', () => ({
  AssistantView: ({ activeOverride, onMobileOpenSettings }: {
    activeOverride: boolean;
    onMobileOpenSettings: (id: string) => void;
  }) => <div data-conversation-active={String(activeOverride)}>
    <input data-conversation-draft defaultValue="retained conversation draft" />
    <button data-open-settings onClick={() => onMobileOpenSettings('asst_1')}>Settings</button>
  </div>,
}));
vi.mock('@/components/sections/assistants/AssistantsSettingsPage', () => ({
  AssistantsSettingsPage: ({ assistantID }: { assistantID: string }) => <div data-settings-assistant={assistantID} />,
}));

import { MobilePhoneShell } from './MobilePhoneShell';
import { useMobileNavigationStore } from './useMobileNavigationStore';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('phone Assistant Settings route', () => {
  let host: HTMLDivElement;
  let root: Root;
  let systemBack: (() => boolean) | null;
  const registerBack = (handler: (() => boolean) | null) => { systemBack = handler; };

  beforeEach(() => {
    useMobileNavigationStore.getState().reset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    systemBack = null;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useMobileNavigationStore.getState().reset();
  });

  test.each(['header', 'system', 'gesture'] as const)('%s Back reveals the retained conversation directly', async (backKind) => {
    useMobileNavigationStore.getState().setActiveTab('settings');
    await act(async () => root.render(<MobilePhoneShell
      onAddProject={() => undefined}
      onEnableAssistants={() => undefined}
      registerSecondaryBackHandler={registerBack}
      renderChat={() => null}
    />));
    const settingsDraft = host.querySelector<HTMLInputElement>('[data-settings-draft]')!;
    settingsDraft.value = 'edited Settings draft';
    await act(async () => {
      useMobileNavigationStore.getState().setActiveTab('assistant');
      useMobileNavigationStore.getState().openAssistant('asst_1');
    });
    const conversation = host.querySelector<HTMLElement>('[data-conversation-active]')!;
    const conversationDraft = host.querySelector<HTMLInputElement>('[data-conversation-draft]')!;
    conversationDraft.value = 'edited conversation draft';

    for (let visit = 0; visit < 2; visit += 1) {
      await act(async () => host.querySelector<HTMLButtonElement>('[data-open-settings]')!.click());
      const pages = host.querySelectorAll<HTMLElement>('[data-mobile-secondary-page]');
      expect(pages).toHaveLength(2);
      expect(pages[0].getAttribute('inert')).not.toBeNull();
      expect(pages[1].querySelector('[data-settings-assistant="asst_1"]')).not.toBeNull();
      expect(conversation.dataset.conversationActive).toBe('false');
      const route = mobileBackNavigationCoordinator.getTopRoute()!;
      expect(route.id).toBe('mobile-secondary:assistant-settings:asst_1');
      expect(route.getSurface()).toBe(pages[1]);
      expect(route.getUnderlay()).toBe(pages[0]);
      expect(useMobileNavigationStore.getState().activeTab).toBe('assistant');
      expect(useMobileNavigationStore.getState().settingsReturnTo).toBeNull();

      await act(async () => {
        if (backKind === 'header') {
          pages[1].querySelector<HTMLButtonElement>('[aria-label="settings.view.actions.back"]')!.click();
        } else if (backKind === 'system') {
          expect(systemBack?.()).toBe(true);
        } else {
          expect(mobileBackNavigationCoordinator.backImmediately('root')).toBe(true);
        }
      });
      expect(host.querySelectorAll('[data-mobile-secondary-page]')).toHaveLength(1);
      expect(host.querySelector('[data-conversation-active]')).toBe(conversation);
      expect(conversation.dataset.conversationActive).toBe('true');
      expect(conversationDraft.value).toBe('edited conversation draft');
      expect(host.querySelector('[data-settings-draft]')).toBe(settingsDraft);
      expect(settingsDraft.value).toBe('edited Settings draft');
      expect(useMobileNavigationStore.getState().secondary).toEqual({ kind: 'assistant' });
    }
    await act(async () => { expect(systemBack?.()).toBe(true); });
    expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'assistant', secondary: null });
  });
});
