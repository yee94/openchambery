import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ generateSessionAside: vi.fn() }));
const language = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: api }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div> }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
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

describe('Btw presentation and ownership', () => {
  test.each(['empty response', 'session.btw failed'])('localizes internal fallback %s and keeps retry available', async (error) => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { question: 'Why?', answer: '', error, pending: false },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Answer generation failed. Please retry.');
    expect(button('Retry')?.disabled).toBe(false);
    language.locale = 'zh-CN';
    await act(async () => root.render(<BtwPanel scope={{ ...scope }} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('生成回答失败，请重试。');
    await act(async () => button('重试')!.click());
    expect(api.generateSessionAside).toHaveBeenCalledWith(expect.objectContaining(scope));
  });

  test('fresh equal scope objects preserve pending ownership; a directory switch cancels the captured scope', async () => {
    void useSessionBtwStore.getState().ask(scope, 'Why?');
    await act(async () => root.render(<BtwComposerSurface scope={{ ...scope }} active mobile={false} />));
    const signal = api.generateSessionAside.mock.calls[0][0].signal as AbortSignal;
    for (let index = 0; index < 3; index += 1) {
      await act(async () => root.render(<BtwComposerSurface scope={{ ...scope }} active mobile={false} />));
      expect(signal.aborted).toBe(false);
      expect(useSessionBtwStore.getState().entries[getSessionBtwKey(scope)].pending).toBe(true);
    }
    await act(async () => root.render(<BtwComposerSurface scope={{ ...scope, directory: '/other' }} active mobile={false} />));
    expect(signal.aborted).toBe(true);
  });

  test('narrow mobile opens the real resizable sheet, shows pending, closes and allows reopening', async () => {
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Why?');
    expect(document.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(document.querySelector('.overflow-y-auto')).toBeTruthy();
    await act(async () => button('Close')!.click());
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => button('Side question')!.click());
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(true);
    expect(document.body.textContent).toContain('Answer cancelled');
  });

  test('StrictMode initial mount preserves an accepted request; leaving its scope cancels only that request', async () => {
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

  test('tab switching keeps the request; closing its tab cancels it', async () => {
    await act(async () => root.render(<BtwComposerSurface scope={scope} active mobile={false} />));
    await act(async () => {
      void useSessionBtwStore.getState().ask(scope, 'Why?');
      useUIStore.getState().openContextPanelTab('/repo', { mode: 'btw' });
    });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0];
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'context' }));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(false);
    await act(async () => useUIStore.getState().closeContextPanelTab('/repo', tab.id));
    expect(api.generateSessionAside.mock.calls[0][0].signal.aborted).toBe(true);
  });

  test('shows scoped answer and errors, copies answer and retries through the same scope', async () => {
    useSessionBtwStore.setState({ entries: {
      [getSessionBtwKey(scope)]: { question: 'Why?', answer: 'Long answer\n'.repeat(200), error: null, pending: false },
    } });
    await act(async () => root.render(<BtwPanel scope={scope} />));
    expect(host.querySelector('[data-markdown]')?.textContent).toContain('Long answer');
    await act(async () => button('Copy')!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith('Long answer\n'.repeat(200));
    api.generateSessionAside.mockRejectedValueOnce(new Error('Provider unavailable'));
    await act(async () => button('Retry')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
    expect(api.generateSessionAside).toHaveBeenCalledWith(expect.objectContaining(scope));
    await act(async () => root.render(<BtwPanel scope={{ ...scope, sessionId: 'session-b' }} />));
    expect(host.textContent).not.toContain('Why?');
    expect(host.querySelector('[data-markdown]')).toBeNull();
  });
});
