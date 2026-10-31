import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';
import { assistantAvatarArtboard } from '@/lib/assistant-avatar/engine';
import * as avatarEngine from '@/lib/assistant-avatar/engine';
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar';
import { ProceduralAssistantAvatar } from './ProceduralAssistantAvatar';
import { mountAvatarAnimation } from '@/lib/assistant-avatar/runtime';

const globalStyles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8');

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('motion', () => import('../../../../../scripts/test/motion-frame-mock'));
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

test('ordinary idle faces keep the reference static pose without frames, gaze listeners or pointer writes', async () => {
  const add = vi.spyOn(window, 'addEventListener');
  const create = vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer');
  await act(async () => root.render(<>{Array.from({ length: 20 }, (_, i) => <AssistantWorkingAvatar key={i} name={`rest-${i}`} working={false} />)}</>));
  const poses = () => [...host.querySelectorAll('svg path')].map((path) => path.getAttribute('d'));
  const initial = poses();
  await intersect(true);
  expect(frames.size).toBe(0);
  expect(create).not.toHaveBeenCalled();
  expect(add.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(0);
  const writes = vi.spyOn(Element.prototype, 'setAttribute');
  for (let i = 0; i < 500; i++) window.dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'mouse', clientX: i, clientY: i }));
  frame(performance.now() + 1000);
  expect(poses()).toEqual(initial);
  expect(writes).not.toHaveBeenCalled();
});

test('idle hover briefly animates then restores the exact static pose and releases its clock', async () => {
  await act(async () => root.render(<AssistantWorkingAvatar name="rest-hover" working={false} />));
  const paths = () => [...host.querySelectorAll('svg path')].map((path) => path.getAttribute('d'));
  const initial = paths();
  await intersect(true);
  const enter = () => host.querySelector('[data-avatar-motion]')!.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
  enter();
  const start = performance.now();
  frame(start + 34);
  expect(paths()).not.toEqual(initial);
  for (let i = 2; i < 30; i++) frame(start + i * 34);
  expect(paths()).toEqual(initial);
  expect(frames.size).toBe(0);
  enter();
  expect(frames.size).toBe(1);
  await intersect(false);
  expect(frames.size).toBe(0);
  expect(paths()).toEqual(initial);
});

test.each(['button', 'role-button'])('button resets exclude mask definitions used by non-round contacts inside a %s', async (kind) => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('button-mask'), shape: 'soft', color: 'sand' });
  const face = <><AssistantWorkingAvatar name="mask-contact" avatarSeed={seed} size={44} working={false} /><svg data-decoration=""><rect /></svg></>;
  await act(async () => root.render(<>
    {kind === 'button' ? <button>{face}</button> : <div role="button">{face}</div>}
  </>));
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(globalStyles);
  const clearingRules = [...sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule
    && rule.style.getPropertyValue('fill') === 'none' && rule.style.getPropertyPriority('fill') === 'important');
  const rect = host.querySelector<SVGRectElement>('mask rect')!;
  expect(rect).not.toBeNull();
  // happy-dom does not implement complex :not() matching or SVG mask painting.
  // Guard the real rule's exclusion here; browser pixel checks cover painting.
  const isCleared = (node: Element) => clearingRules.some((rule) => node.matches(rule.selectorText));
  expect(isCleared(host.querySelector('[data-decoration] rect')!)).toBe(true);
  expect(rect.getAttribute('fill')).toBe('#fff');
  expect(rect.closest('defs')).not.toBeNull();
  const rectClearingRules = clearingRules.filter((rule) => rule.selectorText.includes(' rect'));
  expect(rectClearingRules.length).toBeGreaterThan(0);
  rectClearingRules.forEach((rule) => rule.selectorText.split(',').forEach((selector) => expect(selector).toContain('rect:not(defs rect)')));
  await intersect(true);
  frame(performance.now() + 34);
  expect(rect.getAttribute('fill')).toBe('#fff');
});

test('only visible live faces animate; offscreen, hidden-tab and unmounted faces release their clock', async () => {
  await act(async () => root.render(<AgentAvatar kind="assistant" name="test" motion="thinking" />));
  expect(frames.size).toBe(0);
  await intersect(true);
  expect(frames.size).toBe(1);
  const body = host.querySelectorAll('path[fill-rule="evenodd"]')[1]!;
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
  await act(async () => root.render(<AgentAvatar kind="assistant" name="motion" motion="working" />));
  await intersect(true);
  expect(frames.size).toBe(1);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(0);
  Object.assign(media, { matches: false });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(1);
});

test('non-sphere live geometry restores the exact static body and eyes on reduced motion', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('test'), shape: 'star' });
  await act(async () => root.render(<AgentAvatar kind="assistant" name={seed} motion="thinking" />));
  const shape = () => [...host.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
  const still = shape();
  await intersect(true);
  frame(performance.now() + 1800);
  expect(shape()).not.toEqual(still);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(0);
  expect(shape()).toEqual(still);
});

test('saved motion-off and historical faces allocate no observers or animation frames', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), animate: false });
  await act(async () => root.render(<><AgentAvatar kind="assistant" name={seed} motion="thinking" /><AssistantWorkingAvatar name="history" /><ProceduralAssistantAvatar seed={seed} size={16} motion="idle" randomizeShape /></>));
  expect(observe).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  expect(host.querySelectorAll('img')).toHaveLength(3);
});

test('opaque eye colors survive live frames, theme changes and reduced motion without extra players', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('navigation-eyes'), shape: 'heart', color: 'sky' });
  const render = (eyeColor: 'white' | 'black') => root.render(<ProceduralAssistantAvatar seed={seed} size={23} motion="idle" randomizeShape eyeColor={eyeColor} />);
  const eyes = () => host.querySelector('svg path[fill="#ffffff"], svg path[fill="#000000"]');
  await act(async () => render('white'));
  expect(eyes()?.getAttribute('d')).toBeTruthy();
  await intersect(true);
  frame(performance.now() + 34);
  expect(eyes()?.getAttribute('fill')).toBe('#ffffff');
  await act(async () => render('black'));
  frame(performance.now() + 68);
  expect(eyes()?.getAttribute('fill')).toBe('#000000');
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  expect(frames.size).toBe(1);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(eyes()?.getAttribute('fill')).toBe('#000000');
  expect(frames.size).toBe(0);
});

test('motion-off navigation images keep opaque eye colors separate in the artwork cache', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('static-eyes'), shape: 'heart', animate: false, color: 'sky' });
  const render = (eyeColor?: 'white' | 'black') => root.render(<ProceduralAssistantAvatar seed={seed} size={23} motion="idle" eyeColor={eyeColor} />);
  for (const eyeColor of ['white', 'black', undefined] as const) {
    await act(async () => render(eyeColor));
    const svg = decodeURIComponent(host.querySelector('img')!.src);
    if (eyeColor) {
      expect(svg).toContain(`fill="${eyeColor === 'white' ? '#ffffff' : '#000000'}"`);
      expect(svg).not.toContain('mask="url(');
    } else expect(svg).toContain('mask="url(');
  }
  expect(observe).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

test('small static and live avatars share the fitted artboard without a rounding mask', async () => {
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('framing'), shape: 'square' });
  const expected = assistantAvatarArtboard(resolveAssistantAvatar(seed)).viewBox;
  for (const size of [16, 28, 36, 44]) {
    await act(async () => root.render(<AgentAvatar kind="assistant" name={seed} size={size} />));
    const container = host.querySelector<HTMLElement>('[data-procedural-avatar]')!;
    expect(container.className).not.toContain('rounded-');
    const image = host.querySelector('img')!;
    expect(decodeURIComponent(image.src)).toContain(`viewBox="${expected}"`);
    await act(async () => root.render(<AgentAvatar kind="assistant" name={seed} size={size} motion="idle" />));
    expect(host.querySelector('svg')?.getAttribute('viewBox')).toBe(expected);
  }
});

test('50 unrelated parent renders cause no new observers or frame writes; live state still changes', async () => {
  const render = (n: number, working = false) => root.render(<div data-draft={n}><AssistantWorkingAvatar name="active" avatarSeed="stable" size={44} working={working} /></div>);
  await act(async () => render(0));
  await intersect(true);
  const still = () => [...host.querySelectorAll('svg path')].map((path) => path.getAttribute('d'));
  const initial = still();
  const writes = vi.spyOn(Element.prototype, 'setAttribute');
  for (let i = 1; i <= 50; i++) await act(async () => render(i));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(disconnect).not.toHaveBeenCalled();
  expect(writes.mock.contexts.filter((node) => node instanceof Element && node.closest('[data-procedural-avatar]'))).toHaveLength(0);
  await act(async () => render(51, true));
  expect(host.querySelector('[data-avatar-motion]')?.getAttribute('data-avatar-motion')).toBe('working');
  expect(host.querySelector('[data-assistant-working-dot]')).not.toBeNull();
  expect(frames.size).toBe(1);
  frame(performance.now() + 34);
  await act(async () => render(52, false));
  expect(still()).toEqual(initial);
  expect(frames.size).toBe(0);
});

test('twenty visible production avatars share one clock and unique SVG definition IDs', async () => {
  const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener');
  await act(async () => root.render(<>{Array.from({ length: 20 }, (_, i) => <AgentAvatar key={i} kind="assistant" name={`many-${i}`} motion="working" />)}</>));
  await intersect(true);
  expect(frames.size).toBe(1);
  expect(host.querySelectorAll('svg')).toHaveLength(20);
  const ids = [...host.querySelectorAll('[id]')].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(add.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(1);
  const reads = [...host.querySelectorAll('[data-avatar-motion]')].map((node) => vi.spyOn(node, 'getBoundingClientRect'));
  for (let i = 0; i < 500; i++) window.dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'mouse', clientX: i, clientY: i }));
  reads.forEach((read) => expect(read).not.toHaveBeenCalled());
  frame(performance.now() + 34);
  reads.forEach((read) => expect(read).toHaveBeenCalledTimes(1));
  expect(frames.size).toBe(1);
  await act(async () => root.render(null));
  expect(frames.size).toBe(0);
  expect(remove.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(1);
});

test('Strict Mode and identity changes remove imperative renderers rather than stacking SVGs', async () => {
  await act(async () => root.render(<React.StrictMode><AgentAvatar kind="assistant" name="one" motion="working" /></React.StrictMode>));
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await intersect(true);
  expect(frames.size).toBe(1);
  await act(async () => root.render(<React.StrictMode><AgentAvatar kind="assistant" name="two" motion="happy" /></React.StrictMode>));
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  expect(frames.size).toBe(1);
  await act(async () => root.render(null));
  expect(host.querySelector('svg')).toBeNull();
  expect(frames.size).toBe(0);
});

test('mouse gaze follows outside the avatar, coalesces to frames and refreshes after layout moves', async () => {
  const original = avatarEngine.createAssistantAvatarPlayer;
  const gaze = vi.fn();
  vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer').mockImplementation((...args) => ({ ...original(...args), setGaze: gaze }));
  await act(async () => root.render(<AgentAvatar kind="assistant" name="gaze" motion="working" />));
  await intersect(true);
  const live = host.querySelector<HTMLElement>('[data-avatar-motion]')!;
  const bounds = vi.spyOn(live, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 44, height: 44 } as DOMRect);
  const move = (pointerType: string, clientX = 33, clientY = 11) => document.body.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { pointerType, clientX, clientY }));
  const now = performance.now();
  move('mouse');
  expect(gaze).not.toHaveBeenCalled();
  frame(now + 34);
  expect(gaze).toHaveBeenLastCalledWith([0.125, 0.125]);
  bounds.mockReturnValue({ left: 44, top: 0, width: 44, height: 44 } as DOMRect);
  frame(now + 68);
  expect(gaze).toHaveBeenLastCalledWith([-0.375, 0.125]);
  move('mouse', 600, -200);
  frame(now + 102);
  expect(gaze).toHaveBeenLastCalledWith([1, 1]);
  move('touch'); frame(now + 136);
  expect(gaze).toHaveBeenLastCalledWith(null);
});

test('mouse hover triggers one sway; touch and reduced-motion faces do not sway', async () => {
  const original = avatarEngine.createAssistantAvatarPlayer, hover = vi.fn();
  vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer').mockImplementation((...args) => ({ ...original(...args), hover }));
  await act(async () => root.render(<AgentAvatar kind="assistant" name="hover" motion="idle" />));
  await intersect(true);
  const enter = (pointerType: string) => host.querySelector('[data-avatar-motion]')!.dispatchEvent(Object.assign(
    new Event('pointerenter'), { pointerType },
  ));
  enter('touch'); expect(hover).not.toHaveBeenCalled();
  enter('mouse'); expect(hover).toHaveBeenCalledTimes(1);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  enter('mouse'); expect(hover).toHaveBeenCalledTimes(1);
});

test('contact-row hover targets text and whitespace without retriggering on avatar descendants or affecting other contacts', async () => {
  const original = avatarEngine.createAssistantAvatarPlayer, hover = vi.fn();
  const players = vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer').mockImplementation((...args) => ({ ...original(...args), hover }));
  const target = React.createRef<HTMLButtonElement>();
  const render = (draft: number, working = false) => root.render(<div data-draft={draft}>
    <button ref={target}>
      <AssistantWorkingAvatar name="row-hover" working={working} hoverTarget={target} />
      <span data-summary="">Preview text</span>
    </button>
    <button data-other=""><AssistantWorkingAvatar name="other-row" working={false} /></button>
  </div>);
  await act(async () => render(0));
  const row = target.current!;
  const enter = (node: Element, pointerType = 'mouse') => node.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType }));
  enter(row); expect(hover).not.toHaveBeenCalled();
  await intersect(true);
  enter(row, 'touch'); enter(row, 'pen'); expect(hover).not.toHaveBeenCalled();
  enter(row); expect(hover).toHaveBeenCalledTimes(1);
  enter(row.querySelector('[data-summary]')!);
  enter(row.querySelector('[data-avatar-motion]')!);
  enter(host.querySelector('[data-other]')!);
  expect(hover).toHaveBeenCalledTimes(1);
  const add = vi.spyOn(row, 'addEventListener'), remove = vi.spyOn(row, 'removeEventListener');
  for (let i = 1; i <= 50; i++) await act(async () => render(i));
  await act(async () => render(51, true));
  expect(players).toHaveBeenCalledTimes(2);
  expect(add.mock.calls.filter(([type]) => type === 'pointerenter')).toHaveLength(0);
  expect(remove.mock.calls.filter(([type]) => type === 'pointerenter')).toHaveLength(0);
  enter(row); expect(hover).toHaveBeenCalledTimes(2);
  await intersect(false);
  expect(remove.mock.calls.filter(([type]) => type === 'pointerenter')).toHaveLength(1);
  enter(row); expect(hover).toHaveBeenCalledTimes(2);
  await intersect(true);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  enter(row); expect(hover).toHaveBeenCalledTimes(2);
});

test('changing the row hover target moves one listener and unmount removes it without restarting the player', async () => {
  const original = avatarEngine.createAssistantAvatarPlayer, hover = vi.fn();
  const players = vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer').mockImplementation((...args) => ({ ...original(...args), hover }));
  const first = React.createRef<HTMLButtonElement>(), second = React.createRef<HTMLButtonElement>();
  const render = (target: typeof first) => root.render(<>
    <button ref={first} /><button ref={second} />
    <AssistantWorkingAvatar name="retarget" working={false} hoverTarget={target} />
  </>);
  await act(async () => render(first));
  await intersect(true);
  const a = first.current!, b = second.current!;
  const enter = (node: Element) => node.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
  enter(a); expect(hover).toHaveBeenCalledTimes(1);
  await act(async () => render(second));
  enter(a); expect(hover).toHaveBeenCalledTimes(1);
  enter(b); expect(hover).toHaveBeenCalledTimes(2);
  expect(players).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  enter(b); expect(hover).toHaveBeenCalledTimes(2);
});

test('navigation shape cycling shares the live clock and stays disabled offscreen or under reduced motion', async () => {
  const create = vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer');
  const render = (draft: number) => root.render(<div data-draft={draft}><ProceduralAssistantAvatar seed="navigation" size={16} motion="idle" randomizeShape /></div>);
  await act(async () => render(0));
  expect(create).not.toHaveBeenCalled();
  await intersect(true);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][4]).toEqual({ randomizeShape: true, resting: false });
  expect(frames.size).toBe(1);
  for (let i = 1; i <= 50; i++) await act(async () => render(i));
  expect(create).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(host.querySelector('svg')?.classList.contains('size-full')).toBe(true);
  await intersect(false);
  expect(frames.size).toBe(0);
  await intersect(true);
  Object.assign(media, { matches: true });
  await act(async () => media.dispatchEvent(new Event('change')));
  expect(frames.size).toBe(0);
});

test('imperative runtime updates in place, enforces saved motion-off, and disposes only its own DOM/resources', () => {
  const create = vi.spyOn(avatarEngine, 'createAssistantAvatarPlayer');
  const sibling = document.createElement('i');
  host.append(sibling);
  const animation = mountAvatarAnimation(host, { id: 'imperative', seed: 'runtime' });
  expect(create).not.toHaveBeenCalled();
  animation.update({ active: true, motion: 'idle', size: 44 });
  animation.update({ active: true, motion: 'working', size: 28 });
  expect(create).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(1);
  animation.dispose(); animation.dispose();
  animation.update({ active: true, motion: 'idle', size: 44 });
  animation.hover();
  expect(create).toHaveBeenCalledTimes(1);
  expect(host.querySelector('svg')).toBeNull();
  expect(sibling.parentElement).toBe(host);
  expect(frames.size).toBe(0);
  const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('off'), animate: false });
  const still = mountAvatarAnimation(host, { id: 'off', seed });
  still.update({ active: true, motion: 'working', size: 44 });
  expect(create).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  still.dispose();
});
