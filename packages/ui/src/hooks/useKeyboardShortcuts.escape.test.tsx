import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { setActiveChatInputSurface } from '@/components/chat/activeChatInputSurface';
import { PromptNavigatorRail } from '@/components/chat/components/PromptNavigatorRail';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return { abort: vi.fn(async () => {}) };
});
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/sync/session-actions', () => ({ abortCurrentOperation: mocks.abort }));
vi.mock('@/sync/queue-abort-optimistic', () => ({ promoteQueueHeadOnAbort: vi.fn() }));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));
vi.mock('@/hooks/useAssistantStatus', () => ({
  useAssistantStatus: () => ({ working: { canAbort: true } }),
}));

let root: Root | undefined;
beforeEach(() => {
  useUIStore.setState({ ...useUIStore.getInitialState(), activeMainTab: 'chat' });
  useSessionUIStore.setState({ ...useSessionUIStore.getInitialState(), currentSessionId: 'session-before' });
  setActiveChatInputSurface(null);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  setActiveChatInputSurface(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  mocks.abort.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

function Harness({ withRail }: { withRail: boolean }) {
  useKeyboardShortcuts();
  return <>
    <textarea data-chat-input="true" />
    {withRail && <PromptNavigatorRail
      turnIds={['turn-1', 'turn-2']}
      previewsByTurnId={new Map()}
      activeTurnId="turn-2"
      onSelectTurn={() => {}}
      canLoadEarlier={false}
      isLoadingOlder={false}
      onLoadEarlier={() => {}}
    />}
  </>;
}

const mountSwitchedConversation = async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness withRail={false} />));
  await act(async () => {
    useSessionUIStore.setState({ currentSessionId: 'session-after' });
    root!.render(<Harness withRail />);
  });
  const rail = host.querySelector<HTMLElement>('[role="listbox"]')!;
  // happy-dom has no layout; the real rail occupies a visible rectangle.
  vi.spyOn(rail, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 28, 24)] as unknown as DOMRectList);
  const textarea = host.querySelector('textarea')!;
  textarea.focus();
  expect(document.activeElement).toBe(textarea);
  return { textarea, rail };
};

const pressEscape = async (target: HTMLElement) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
};

test('double Escape aborts the focused session after switching to a conversation with a prompt rail', async () => {
  const { textarea } = await mountSwitchedConversation();
  await pressEscape(textarea);
  expect(useSessionUIStore.getState().abortPromptSessionId).toBe('session-after');
  expect(mocks.abort).not.toHaveBeenCalled();
  await pressEscape(textarea);
  expect(mocks.abort).toHaveBeenCalledExactlyOnceWith('session-after');
});

test.each(['select-content', 'dropdown-menu-content'])('an open %s keeps Escape ownership', async (slot) => {
  const { textarea } = await mountSwitchedConversation();
  const popup = document.createElement('div');
  popup.dataset.slot = slot;
  popup.setAttribute('role', slot === 'select-content' ? 'listbox' : 'menu');
  document.body.appendChild(popup);
  vi.spyOn(popup, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  await pressEscape(textarea);
  await pressEscape(textarea);
  expect(useSessionUIStore.getState().abortPromptSessionId).toBeNull();
  expect(mocks.abort).not.toHaveBeenCalled();
  popup.remove();
  await pressEscape(textarea);
  expect(mocks.abort).not.toHaveBeenCalled();
  await pressEscape(textarea);
  expect(mocks.abort).toHaveBeenCalledExactlyOnceWith('session-after');
});

test('Escape inside the prompt rail stays with the rail', async () => {
  const { rail } = await mountSwitchedConversation();
  await act(async () => rail.focus());
  await pressEscape(rail);
  await pressEscape(rail);
  expect(useSessionUIStore.getState().abortPromptSessionId).toBeNull();
  expect(mocks.abort).not.toHaveBeenCalled();
});

test('Escape closes prompt navigation before a fresh double Escape can abort', async () => {
  const { textarea, rail } = await mountSwitchedConversation();
  await act(async () => useUIStore.getState().setPromptNavigatorPanelOpen(true));
  await pressEscape(rail);
  expect(useUIStore.getState().isPromptNavigatorPanelOpen).toBe(false);
  expect(useSessionUIStore.getState().abortPromptSessionId).toBeNull();
  await act(async () => textarea.focus());
  await pressEscape(textarea);
  expect(mocks.abort).not.toHaveBeenCalled();
  await pressEscape(textarea);
  expect(mocks.abort).toHaveBeenCalledExactlyOnceWith('session-after');
});
