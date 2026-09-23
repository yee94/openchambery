import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ generateSessionAside: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: api }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div> }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({
    currentSessionId: null,
    getDirectoryForSession: () => null,
    setCurrentSession: async () => undefined,
  })) };
});
vi.mock('@/queries/assistantQueries', () => ({ useAssistantUnreadTotal: () => 0 }));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => false }));
vi.mock('./useNativeIosTabBar', () => ({ useNativeIosTabBar: () => 'web' }));
vi.mock('@/lib/native-ios-composer-session', () => ({ nativeIosComposerSession: { shutdown: () => undefined } }));
vi.mock('./projects', () => ({ MobileProjectsHomeContainer: () => null }));
vi.mock('./assistant/MobileAssistantTab', () => ({ MobileAssistantTab: () => null }));
vi.mock('./scheduled/MobileScheduledTab', () => ({ MobileScheduledTab: () => null }));
vi.mock('./settings/MobileSettingsTab', () => ({ MobileSettingsTab: () => null }));
vi.mock('@/components/assistants/AssistantView', () => ({ AssistantView: () => null }));

import { MobilePhoneShell } from './MobilePhoneShell';
import { isPhoneBtwScopeOpen, pushPhoneBtw, useMobileNavigationStore } from './useMobileNavigationStore';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';
import { resetSessionBtwStoreForRuntimeSwitch, useSessionBtwStore } from '@/stores/useSessionBtwStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const target = { sessionId: 'ses_1', directory: '/repo' };

describe('phone /btw page', () => {
  let host: HTMLDivElement;
  let root: Root;
  let systemBack: (() => boolean) | null;
  const registerBack = (handler: (() => boolean) | null) => { systemBack = handler; };
  const renderShell = () => root.render(<MobilePhoneShell
    onAddProject={() => undefined}
    onEnableAssistants={() => undefined}
    registerSecondaryBackHandler={registerBack}
    renderChat={(chat) => <div data-chat-active={String(chat.active)} />}
  />);

  beforeEach(() => {
    vi.clearAllMocks();
    api.generateSessionAside.mockImplementation(() => new Promise(() => {}));
    resetSessionBtwStoreForRuntimeSwitch();
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
    resetSessionBtwStoreForRuntimeSwitch();
  });

  test('only the mounted phone shell with an open chat page accepts the push', async () => {
    useMobileNavigationStore.getState().openSession(target);
    expect(pushPhoneBtw(target)).toBe(false);
    useMobileNavigationStore.getState().closeSecondary();
    await act(async () => renderShell());
    expect(pushPhoneBtw(target)).toBe(false);
  });

  test.each(['header', 'system', 'gesture'] as const)('pushes above the chat page; %s Back returns and clears the side conversation', async (backKind) => {
    await act(async () => renderShell());
    await act(async () => { useMobileNavigationStore.getState().openSession(target); });
    const chat = host.querySelector<HTMLElement>('[data-chat-active]')!;
    await act(async () => { expect(pushPhoneBtw(target)).toBe(true); });

    const pages = host.querySelectorAll<HTMLElement>('[data-mobile-secondary-page]');
    expect(pages).toHaveLength(2);
    expect(pages[0].getAttribute('inert')).not.toBeNull();
    expect(pages[1].querySelector('[data-btw-composer] textarea')).not.toBeNull();
    expect(chat.dataset.chatActive).toBe('false');
    expect(isPhoneBtwScopeOpen(target)).toBe(true);
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    expect(mobileBackNavigationCoordinator.getTopRoute()?.id).toBe('mobile-secondary:chat-btw');

    await act(async () => { void useSessionBtwStore.getState().ask(target, 'Why?'); });
    const signal = api.generateSessionAside.mock.calls[0][0].signal as AbortSignal;
    await act(async () => {
      if (backKind === 'header') {
        pages[1].querySelector<HTMLButtonElement>('[aria-label="header.actions.backAria"]')!.click();
      } else if (backKind === 'system') {
        expect(systemBack?.()).toBe(true);
      } else {
        expect(mobileBackNavigationCoordinator.backImmediately('root')).toBe(true);
      }
    });

    expect(host.querySelectorAll('[data-mobile-secondary-page]')).toHaveLength(1);
    expect(host.querySelector('[data-chat-active]')).toBe(chat);
    expect(chat.dataset.chatActive).toBe('true');
    expect(useMobileNavigationStore.getState().secondary).toMatchObject({ kind: 'chat' });
    expect(isPhoneBtwScopeOpen(target)).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('leaving the chat page drops the btw page and clears its conversation', async () => {
    await act(async () => renderShell());
    await act(async () => {
      useMobileNavigationStore.getState().openSession(target);
      pushPhoneBtw(target);
      void useSessionBtwStore.getState().ask(target, 'Why?');
    });
    await act(async () => useMobileNavigationStore.getState().setActiveTab('projects'));
    expect(useSessionBtwStore.getState().entries).toEqual({});
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
