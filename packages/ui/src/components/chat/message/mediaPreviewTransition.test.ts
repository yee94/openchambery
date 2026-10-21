import { afterEach, expect, test, vi } from 'vitest';
import { animateMediaPreview } from './mediaPreviewTransition';

const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    if (original) Object.defineProperty(document, 'startViewTransition', original);
    else Reflect.deleteProperty(document, 'startViewTransition');
    if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(Element.prototype, 'animate');
});

function setup() {
    const source = document.createElement('div');
    const viewer = document.createElement('div');
    const target = document.createElement('div');
    viewer.append(target);
    document.body.append(source, viewer);
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 100, 80));
    source.style.viewTransitionName = 'original';
    target.style.viewTransitionName = '';
    let update!: () => void;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const skipTransition = vi.fn();
    const start = vi.fn((callback: () => void) => {
        update = callback;
        return { ready: Promise.resolve(), finished, skipTransition };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    return { source, target, viewer, start, update: () => update(), finish, skipTransition, finished };
}

test.each([false, true])('hands off one shared snapshot name and restores styles (closing=%s)', async (closing) => {
    const state = setup();
    const complete = vi.fn();
    animateMediaPreview(state.source, state.target, state.viewer, closing, complete);
    expect(state.source.style.viewTransitionName).toBe(closing ? 'none' : 'oc-media-preview');
    expect(state.target.style.viewTransitionName).toBe(closing ? 'oc-media-preview' : 'none');
    state.update();
    expect(state.source.style.viewTransitionName).toBe(closing ? 'oc-media-preview' : 'none');
    expect(state.target.style.viewTransitionName).toBe(closing ? 'none' : 'oc-media-preview');
    expect(complete).not.toHaveBeenCalled();
    state.finish();
    await state.finished;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(state.source.style.viewTransitionName).toBe('original');
    expect(state.target.style.viewTransitionName).toBe('');
    expect(state.viewer.style.visibility).toBe('');
});

test('unmount or an interrupted opening cancels stale updates and completion', async () => {
    const state = setup();
    const complete = vi.fn();
    const cancel = animateMediaPreview(state.source, state.target, state.viewer, false, complete);
    cancel();
    state.update();
    state.finish();
    await state.finished;
    expect(state.skipTransition).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(state.source.style.viewTransitionName).toBe('original');
    expect(state.viewer.style.visibility).toBe('');
});

test.each(['removed', 'offscreen', 'reduced-motion'] as const)('%s bypasses shared element animation', (mode) => {
    const state = setup();
    if (mode === 'removed') state.source.remove();
    if (mode === 'offscreen') vi.mocked(state.source.getBoundingClientRect).mockReturnValue(new DOMRect(0, -200, 100, 80));
    if (mode === 'reduced-motion') vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const complete = vi.fn();
    animateMediaPreview(state.source, state.target, state.viewer, true, complete);
    expect(state.start).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
});

test.each([[180, 600], [600, 180]])('image %s×%s returns through a square crop without snapshots and cleans up on cancellation', (width, height) => {
    const state = setup();
    const thumbnail = document.createElement('img');
    thumbnail.style.objectFit = 'cover';
    thumbnail.style.objectPosition = '50% 50%';
    state.source.append(thumbnail);
    vi.spyOn(thumbnail, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 100, 100));
    const full = document.createElement('img');
    state.viewer.append(full);
    Object.defineProperties(full, { complete: { value: true }, naturalWidth: { value: width }, naturalHeight: { value: height } });
    vi.spyOn(full, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, width, height));
    const cancelAnimation = vi.fn();
    const animate = vi.fn().mockReturnValue({
        finished: new Promise(() => {}), cancel: cancelAnimation,
    } as unknown as Animation);
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    const complete = vi.fn();
    const cancel = animateMediaPreview(state.source, full, state.viewer, true, complete);
    expect(state.start).not.toHaveBeenCalled();
    const frame = document.querySelector<HTMLElement>('[data-media-crop-animation]');
    expect(frame?.style.overflow).toBe('hidden');
    expect(frame?.style.contain).toBe('paint');
    expect(animate.mock.calls[0][0]).toEqual([
        expect.objectContaining({ width: `${width}px`, height: `${height}px` }),
        expect.objectContaining({ width: '100px', height: '100px', transform: 'translate(20px, 40px)' }),
    ]);
    expect(full.style.visibility).toBe('hidden');
    cancel();
    expect(document.querySelector('[data-media-crop-animation]')).toBeNull();
    expect(full.style.visibility).toBe('');
    expect(cancelAnimation).toHaveBeenCalledTimes(3);
    expect(complete).not.toHaveBeenCalled();
});
