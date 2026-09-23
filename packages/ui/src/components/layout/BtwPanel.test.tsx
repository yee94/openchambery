import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ generateSessionAside: vi.fn() }));
const language = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    generateSessionAside: api.generateSessionAside,
    setDirectory: vi.fn(),
    applySendSelection: vi.fn(async () => {}),
  },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div> }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/ui/ModelLogo', () => ({ ModelLogo: () => <span data-model-logo /> }));
vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionModelSelection: () => null,
      getSessionAgentSelection: () => null,
      saveSessionModelSelection: vi.fn(),
      saveSessionAgentSelection: vi.fn(),
    }),
  },
}));
vi.mock('@/stores/useConfigStore', () => {
  const configState = {
    providers: [],
    getVisibleAgents: () => [],
    activeDirectoryKey: 'default',
    providerConfigLoadingByDirectory: {} as Record<string, boolean>,
    agentConfigLoadingByDirectory: {} as Record<string, boolean>,
    currentProviderId: 'provider-a',
    currentModelId: 'model-a',
    currentAgentName: undefined as string | undefined,
    currentVariant: null as string | null,
  };
  const useConfigStore = ((selector?: (state: typeof configState) => unknown) =>
    (selector ? selector(configState) : configState)) as {
    (selector: (state: typeof configState) => unknown): unknown;
    getState: () => typeof configState;
  };
  useConfigStore.getState = () => configState;
  return { useConfigStore };
});
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>();
  const { dict } = await import('@/lib/i18n/messages/en');
  const { dict: chinese } = await import('@/lib/i18n/messages/zh-CN');
  return { ...original, useI18n: () => ({ t: (key: keyof typeof dict) => (language.locale === 'zh-CN' ? chinese : dict)[key], locale: language.locale }) };
});

import { BtwComposerSurface, BtwPanel } from './BtwPanel';
import { useUIStore } from '@/stores/useUIStore';
import { getSessionBtwKey, resetSessionBtwStoreForRuntimeSwitch, useSessionBtwStore } from '@/stores/useSessionBtwStore';
import { copyTextToClipboard } from '@/lib/clipboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { sessionId: 'session-a', directory: '/repo' };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  language.locale = 'en';
  resetSessionBtwStoreForRuntimeSwitch();
  useUIStore.setState({ contextPanelByDirectory: {}, isMobile: true });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ finished: Promise.resolve(), cancel: () => {} }) });
  api.generateSessionAside.mockImplementation(() => new Promise(() => {}));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetSessionBtwStoreForRuntimeSwitch();
  document.body.innerHTML = '';
});

const button = (label: string) => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.includes(label) || node.getAttribute('aria-label') === label);
const turnsOf = (target = scope) => useSessionBtwStore.getState().entries[getSessionBtwKey(target)]?.turns ?? [];
const typeAndEnter = async (text: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
};

describe('Btw side conversation panel', () => {
  test('opens as an empty mini chat without requesting or loading anything', async () => {
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.textContent).toContain('Ask about the conversation while keeping its history unchanged.');
    expect(host.querySelector('[data-btw-composer] textarea')).toBeTruthy();
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('Enter in the panel composer sends; follow-ups append as a conversation', async () => {
    api.generateSessionAside.mockResolvedValueOnce({ text: 'First answer' }).mockResolvedValueOnce({ text: 'Second answer' });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    await typeAndEnter('Why?');
    await typeAndEnter('And then?');
    expect(api.generateSessionAside).toHaveBeenCalledTimes(2);
    expect(api.generateSessionAside.mock.calls[1][0].prompt).toContain('User: Why?\n\nAssistant: First answer');
    expect(Array.from(host.querySelectorAll('[data-markdown]')).map((node) => node.textContent)).toEqual(['First answer', 'Second answer']);
    expect(document.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea')!.value).toBe('');
  });

  test('staged selection quotes render as removable chips and ride along with the next question', async () => {
    useSessionBtwStore.getState().addQuote(scope, 'keep this');
    useSessionBtwStore.getState().addQuote(scope, 'drop this');
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(Array.from(host.querySelectorAll('[data-composer-quote-chip]')).map((node) => node.textContent)).toEqual(['keep this', 'drop this']);
    const removeButtons = host.querySelectorAll<HTMLButtonElement>('[data-composer-quote-chip] button[aria-label="Remove quote"]');
    await act(async () => removeButtons[1]!.click());
    expect(host.querySelectorAll('[data-composer-quote-chip]')).toHaveLength(1);
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    await typeAndEnter('Explain');
    expect(api.generateSessionAside.mock.calls[0][0].prompt).toContain('> keep this\n\nExplain');
    expect(api.generateSessionAside.mock.calls[0][0].prompt).not.toContain('drop this');
    expect(host.querySelectorAll('[data-btw-composer] [data-composer-quote-chip]')).toHaveLength(0);
  });

  test('localizes internal failures and retries the last turn through the same scope', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: '', error: 'empty response', pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Answer generation failed. Please retry.');
    language.locale = 'zh-CN';
    await act(async () => root.render(<BtwPanel scope={{ ...scope }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('生成回答失败，请重试。');
    await act(async () => button('重试')!.click());
    expect(api.generateSessionAside).toHaveBeenCalledWith(expect.objectContaining(scope));
  });

  test('copies an answer and hides other sessions’ turns', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { quotes: [], turns: [{ id: 't1', quotes: [], question: 'Why?', answer: 'Long answer', error: null, pending: false }] },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    await act(async () => button('Copy')!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith('Long answer');
    await act(async () => root.render(<BtwPanel scope={{ ...scope, sessionId: 'session-b' }} />));
    expect(host.textContent).not.toContain('Why?');
  });

  test('tab switching keeps the conversation; closing the btw tab clears it and leaves no composer chip', async () => {
    useUIStore.setState({ isMobile: false });
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile={false} />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0];
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'context' }));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(false);
    expect(turnsOf()).toHaveLength(1);
    await act(async () => useUIStore.getState().closeContextPanelTab('/repo', tab.id));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
    expect(host.querySelector('button')).toBeNull();
  });

  test('closing the mobile sheet closes the panel and clears the conversation', async () => {
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Why?');
    await act(async () => button('Close')!.click());
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('StrictMode keeps an accepted request; leaving its session cancels only that request', async () => {
    void useSessionBtwStore.getState().ask(scope, 'First?');
    await act(async () => root.render(<React.StrictMode><BtwComposerSurface scope={scope} active mobile={false} /></React.StrictMode>));
    const firstSignal = api.generateSessionAside.mock.calls[0][0].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    const nextScope = { ...scope, sessionId: 'session-b' };
    void useSessionBtwStore.getState().ask(nextScope, 'Second?');
    await act(async () => root.render(<React.StrictMode><BtwComposerSurface scope={nextScope} active mobile={false} /></React.StrictMode>));
    expect(firstSignal.aborted).toBe(true);
    expect(api.generateSessionAside.mock.calls[1][0].signal.aborted).toBe(false);
    await act(async () => root.render(<div />));
    expect(api.generateSessionAside.mock.calls[1][0].signal.aborted).toBe(true);
  });
});
