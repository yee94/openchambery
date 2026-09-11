import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AssistantSnapshot } from '@/queries/assistantQueries';

const state = vi.hoisted(() => ({ mark: vi.fn(), all: vi.fn(), toast: vi.fn(), total: 0, native: false, transport: 'a', generation: 1 }));
vi.mock('@/queries/assistantQueries', () => ({ markAssistantContactRead: state.mark, markAllAssistantsRead: state.all, useAssistantUnreadTotal: () => state.total }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => state.transport, getRuntimeGeneration: () => state.generation }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => state.native }));
vi.mock('sonner', () => ({ toast: { error: state.toast } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: { count: number }) => params ? `${key}:${params.count}` : key }) }));
import { AssistantReadMarker } from './AssistantReadMarker';
import { AssistantNavigationUnreadBadge, AssistantUnreadBadge } from './AssistantUnreadBadge';
import { AssistantMarkAllReadButton } from './AssistantMarkAllReadButton';
import { MobileTabBar } from '@/mobile/MobileTabBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let observerCallback: IntersectionObserverCallback;
const disconnect = vi.fn();
const position = { generation: 0, ordinal: 4, messageID: 'loaded-message' };
beforeEach(() => {
  state.mark.mockReset().mockResolvedValue({}); state.all.mockReset(); state.toast.mockReset();
  state.native = false; state.transport = 'a'; state.generation = 1; state.total = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
    observe() {} disconnect = disconnect;
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  document.documentElement.classList.remove('oc-native-app-active');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const intersect = async (visible = true) => {
  await act(async () => observerCallback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
};
const mountMarker = async () => {
  await render(<div data-assistant-contact-transcript=""><div data-message-id="loaded-message"><AssistantReadMarker assistantID="a" position={position} /></div></div>);
  const scroller = host.firstElementChild as HTMLElement;
  Object.defineProperties(scroller, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 500, configurable: true } });
  scroller.scrollTop = 500;
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  vi.spyOn(host.querySelector('[data-assistant-read-marker]')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 480, 1, 1));
  return scroller;
};

describe('Assistant unread UI', () => {
  test('per-assistant and navigation badges hide zero, cap at 99+ and retain the accessible exact count', async () => {
    await render(<AssistantUnreadBadge count={0} />); expect(host.textContent).toBe('');
    await render(<AssistantUnreadBadge count={99} />); expect(host.textContent).toBe('99');
    state.total = 123;
    await render(<AssistantNavigationUnreadBadge />);
    expect(host.textContent).toBe('99+');
    expect(host.firstElementChild?.getAttribute('aria-label')).toBe('assistants.unread.label:123');
    expect(host.firstElementChild?.className).toContain('bg-[var(--status-info)]');
    expect(host.firstElementChild?.className).toContain('text-[var(--status-info-foreground)]');
    expect(host.firstElementChild?.className).toContain('shadow-[inset_');
  });

  test('mobile dock displays and clears its assistant total', async () => {
    state.total = 150;
    await render(<MobileTabBar activeTab="assistant" onTabChange={() => undefined} />);
    expect(host.querySelector('[data-tab="assistant"] [data-assistant-unread-count]')?.textContent).toBe('99+');
    state.total = 0;
    await render(<MobileTabBar activeTab="assistant" onTabChange={() => undefined} />);
    expect(host.querySelector('[data-assistant-unread-count]')).toBeNull();
  });

  test('visible focused bottom row reports its loaded cursor once', async () => {
    await mountMarker();
    await intersect(false); expect(state.mark).not.toHaveBeenCalled();
    await intersect(); await intersect();
    expect(state.mark).toHaveBeenCalledExactlyOnceWith('a', position);
  });

  test('historical scroll position and background windows retain unread', async () => {
    const scroller = await mountMarker();
    scroller.scrollTop = 100;
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
    scroller.scrollTop = 500;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(state.mark).toHaveBeenCalledTimes(1);
  });

  test('inert underlays, occluded row geometry and runtime switches block marking', async () => {
    const scroller = await mountMarker();
    scroller.setAttribute('inert', '');
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
    scroller.removeAttribute('inert');
    const marker = host.querySelector('[data-assistant-read-marker]')!;
    vi.mocked(marker.getBoundingClientRect).mockReturnValue(new DOMRect(50, 600, 1, 1));
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
    vi.mocked(marker.getBoundingClientRect).mockReturnValue(new DOMRect(50, 480, 1, 1));
    state.generation += 1;
    await intersect(); expect(state.mark).not.toHaveBeenCalled();
  });

  test('Capacitor foreground uses the native active class and resumes from background', async () => {
    state.native = true;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await mountMarker(); await intersect(); expect(state.mark).not.toHaveBeenCalled();
    await act(async () => document.documentElement.classList.add('oc-native-app-active'));
    expect(state.mark).toHaveBeenCalledTimes(1);
  });

  test('failed mark retries after cooldown while visible and stops on unmount', async () => {
    vi.useFakeTimers();
    state.mark.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    await mountMarker(); await intersect(); await intersect();
    expect(state.mark).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(state.mark).toHaveBeenCalledTimes(2);
    await render(null);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(state.mark).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
  });

  test('mark-all serializes clicks and surfaces partial failure for retry', async () => {
    const snapshot = { enabled: true, revision: 1, assistants: [{ id: 'a', unreadCount: 1, readTip: position }] } as AssistantSnapshot;
    let finish!: (result: { failed: number }) => void;
    state.all.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(<AssistantMarkAllReadButton snapshot={snapshot} />);
    const button = host.querySelector('button')!;
    await act(async () => { button.click(); button.click(); });
    expect(state.all).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(button.disabled).toBe(true);
    await act(async () => finish({ failed: 1 }));
    expect(state.toast).toHaveBeenCalledWith('assistants.unread.markAllFailed');
    expect(button.disabled).toBe(false);
  });
});
