import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { assistantAvatarStillScene, encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let nextID = 0;
let visible = 'visible';
let reduced = false;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<{ callback: IntersectionObserverCallback; observer: IntersectionObserver }>();
const media = new EventTarget();
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  visible = 'visible';
  reduced = false;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible as DocumentVisibilityState);
  vi.stubGlobal('matchMedia', vi.fn(() => Object.assign(media, { matches: reduced, media: '(prefers-reduced-motion: reduce)' })));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observers.add({ callback, observer: this as unknown as IntersectionObserver }); }
    observe = observe;
    disconnect = disconnect;
    unobserve() {}
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextID, callback); return nextID; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  observers.clear();
  frames.clear();
  observe.mockClear();
  disconnect.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function intersect(isIntersecting: boolean) {
  await act(async () => observers.forEach(({ callback, observer }) => callback([{ isIntersecting } as IntersectionObserverEntry], observer)));
}
function frame(timestamp: number) {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(timestamp));
}

test('only visible live faces animate; offscreen, hidden-tab and unmounted faces release their clock', async () => {
  await act(async () => root.render(<AgentAvatar kind="assistant" name="test" motion="thinking" />));
  expect(frames.size).toBe(0);
  await intersect(true);
  expect(frames.size).toBe(1);
  const body = host.querySelector('path')!;
  const initial = body.getAttribute('d');
  frame(performance.now() + 1800);
  expect(body.getAttribute('d')).not.toBe(initial);
  await intersect(false);
  expect(frames.size).toBe(0);
  await intersect(true);
  expect(frames.size).toBe(1);
  visible = 'hidden';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(frames.size).toBe(0);
  visible = 'visible';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(frames.size).toBe(1);
  await act(async () => root.render(null));
  expect(frames.size).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});

test('system reduced motion switches dynamically to a static pose', async () => {
  await act(async () => root.render(<AgentAvatar kind="assistant" name="motion" motion="idle" />));
  await intersect(true);
  expect(frames.size).toBe(1);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(0);
  Object.assign(media, { matches: false });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(1);
});

test('new silhouettes keep eyes attached during motion and restore the exact static shape when reduced motion turns on', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('test'), shape: 'star' });
  const still = assistantAvatarStillScene(seed);
  await act(async () => root.render(<AgentAvatar kind="assistant" name={seed} motion="thinking" />));
  const group = host.querySelector('svg g')!;
  const paths = group.querySelectorAll('path');
  expect(paths).toHaveLength(3);
  expect(paths[0].getAttribute('d')).toBe(still.blob.path);
  expect(group.getAttribute('transform')).toBe(still.transform);
  await intersect(true);
  frame(performance.now() + 1800);
  expect(group.getAttribute('transform')).not.toBe(still.transform);
  expect(paths[0].getAttribute('d')).toBe(still.blob.path);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(0);
  expect(group.getAttribute('transform')).toBe(still.transform);
  expect(paths[1].getAttribute('d')).toBe(still.eyes[0].path);
});

test('saved motion-off and historical faces allocate no observers or animation frames', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), animate: false });
  await act(async () => root.render(<><AgentAvatar kind="assistant" name={seed} motion="thinking" /><AssistantWorkingAvatar name="history" /></>));
  expect(observe).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  expect(host.querySelectorAll('img')).toHaveLength(2);
});

test('50 unrelated parent renders cause no new observers or frame writes; live state still changes', async () => {
  const render = (n: number, working = false) => root.render(<div data-draft={n}><AssistantWorkingAvatar name="active" avatarSeed="stable" size={44} working={working} /></div>);
  await act(async () => render(0));
  await intersect(true);
  const writes = vi.spyOn(host.querySelector('path')!, 'setAttribute');
  for (let i = 1; i <= 50; i++) await act(async () => render(i));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(disconnect).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  await act(async () => render(51, true));
  expect(host.querySelector('[data-avatar-motion]')?.getAttribute('data-avatar-motion')).toBe('thinking');
  expect(host.querySelector('[data-assistant-working-dot]')).not.toBeNull();
  expect(frames.size).toBe(1);
});
