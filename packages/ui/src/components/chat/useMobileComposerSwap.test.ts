import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    TIMELINE_ANCHORING_ATTRIBUTE,
    TIMELINE_PARK_END_ATTRIBUTE,
} from './lib/scroll/timelineScrollAnchoring';
import {
    COMPOSER_SWAP_CSS_VAR,
    COMPOSER_SWAP_SNAP_MS,
    COMPOSER_SWAP_USER_SCROLL_WINDOW_MS,
    NATIVE_COMPOSER_DOCK_CSS_VAR,
} from './mobileComposerSwap';
import { useMobileComposerSwap } from './useMobileComposerSwap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 600;

/** Mutable so a test can append content the way a streaming tail does. */
let scrollHeight = SCROLL_HEIGHT;

const setDistance = (scrollEl: HTMLElement, distance: number) => {
    // distance = scrollHeight - scrollTop - clientHeight
    scrollEl.scrollTop = scrollHeight - CLIENT_HEIGHT - distance;
};

const readSwap = (scopeEl: HTMLElement) => ({
    phase: scopeEl.dataset.ocComposerSwapPhase,
    rest: scopeEl.dataset.ocComposerSwapRest,
    progress: scopeEl.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR),
});

const readDock = (scopeEl: HTMLElement) => ({
    rest: scopeEl.dataset.ocNativeComposerDock,
    progress: scopeEl.style.getPropertyValue(NATIVE_COMPOSER_DOCK_CSS_VAR),
});

describe('useMobileComposerSwap gesture commit', () => {
    let container: HTMLElement;
    let root: Root;
    let scrollEl: HTMLElement;
    let scopeEl: HTMLElement;
    let scrollRef: React.RefObject<HTMLElement | null>;
    let scopeRef: React.RefObject<HTMLElement | null>;
    let activeTouches: Map<number, { clientX: number; clientY: number }>;

    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'Date'],
        });
        vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
        container = document.createElement('div');
        document.body.appendChild(container);
        scrollEl = document.createElement('div');
        scopeEl = document.createElement('div');
        activeTouches = new Map();
        scrollHeight = SCROLL_HEIGHT;
        Object.defineProperty(scrollEl, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        });
        Object.defineProperty(scrollEl, 'clientHeight', {
            configurable: true,
            get: () => CLIENT_HEIGHT,
        });
        scrollEl.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT;
        scrollRef = { current: scrollEl };
        scopeRef = { current: scopeEl };
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    const mount = async () => {
        const Probe = () => {
            useMobileComposerSwap({
                enabled: true,
                scrollRef,
                scopeRef,
            });
            return null;
        };
        await act(async () => {
            root.render(React.createElement(Probe));
        });
        // Layout effect binds listeners; flush one frame of timers if needed.
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
    };

    const fireScroll = async (distance: number) => {
        await act(async () => {
            setDistance(scrollEl, distance);
            scrollEl.dispatchEvent(new Event('scroll'));
        });
    };

    const fireTouch = async (
        type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
        clientY: number,
        identifier = 1,
        clientX = 24,
    ) => {
        await act(async () => {
            if (type === 'touchstart' || type === 'touchmove') {
                activeTouches.set(identifier, { clientX, clientY });
            } else {
                activeTouches.delete(identifier);
            }
            const createTouch = (
                touchIdentifier: number,
                touchClientX: number,
                touchClientY: number,
            ) => new Touch({
                identifier: touchIdentifier,
                target: scrollEl,
                clientX: touchClientX,
                clientY: touchClientY,
                screenX: touchClientX,
                screenY: touchClientY,
                pageX: touchClientX,
                pageY: touchClientY,
            });
            const touches = Array.from(activeTouches, ([touchIdentifier, point]) => (
                createTouch(touchIdentifier, point.clientX, point.clientY)
            ));
            const event = new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches,
                targetTouches: touches,
                changedTouches: [createTouch(identifier, clientX, clientY)],
            });
            Object.defineProperty(event, 'timeStamp', {
                configurable: true,
                value: Date.now(),
            });
            scrollEl.dispatchEvent(event);
        });
    };

    // Overscroll cannot be expressed as a distance: iOS drives scrollTop below
    // zero, so these tests set it directly.
    const fireScrollTop = async (scrollTop: number) => {
        await act(async () => {
            scrollEl.scrollTop = scrollTop;
            scrollEl.dispatchEvent(new Event('scroll'));
        });
    };

    const advance = async (ms: number) => {
        await act(async () => {
            vi.advanceTimersByTime(ms);
        });
    };

    const beginSwipe = async (fromY = 520, toY = 420, identifier = 1) => {
        await fireTouch('touchstart', fromY, identifier);
        await advance(16);
        await fireTouch('touchmove', toY, identifier);
    };

    test('held finger never commits — flash regression', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(30);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'tracking',
            progress: '0.375',
        });
        expect(readDock(scopeEl)).toMatchObject({
            rest: 'bottom',
            progress: '0.375',
        });

        await advance(500);
        expect(readSwap(scopeEl).phase).toBe('tracking');

        await fireScroll(30);
        await advance(200);
        await fireScroll(28);
        await advance(200);
        await fireScroll(32);
        await advance(200);
        expect(readSwap(scopeEl).phase).toBe('tracking');
    });

    test('lift commits by progress threshold then settles', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(30);
        expect(readSwap(scopeEl).phase).toBe('tracking');
        expect(Number(readSwap(scopeEl).progress)).toBeCloseTo(0.375);

        await fireTouch('touchend', 420);
        await advance(120);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
        });

        await advance(COMPOSER_SWAP_SNAP_MS);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'rest',
            rest: 'expanded',
        });
    });

    test('full follow lands compact at rest without snapping', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(100);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });

        await fireScroll(10);
        expect(readSwap(scopeEl).phase).toBe('tracking');
        expect(Number(readSwap(scopeEl).progress)).toBeCloseTo(0.125);

        await fireTouch('touchend', 420);
        await advance(120);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
        });

        await advance(COMPOSER_SWAP_SNAP_MS);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'rest',
            rest: 'expanded',
        });
    });

    /**
     * The list follows its own streaming growth: the tail appends, the end
     * jumps away from the viewport, and end maintenance glides back over
     * several frames. Every one of those frames reports a large distance from
     * the bottom, which used to flash the composer into its compact form even
     * though the user never touched the screen.
     */
    test('streaming growth and the glide back never collapse the composer', async () => {
        await mount();

        // The tail appends 300px: scrollTop is untouched, so the end moves away.
        scrollHeight += 300;
        await act(async () => {
            scrollEl.dispatchEvent(new Event('scroll'));
        });
        expect(readSwap(scopeEl).rest).not.toBe('compact');

        // Animated end maintenance glides back over several frames, each one
        // reporting a large distance from the bottom.
        for (const distance of [240, 180, 120, 60, 12, 0]) {
            await fireScroll(distance);
            expect(readSwap(scopeEl).rest).not.toBe('compact');
        }
        // Streaming keeps the composer expanded, but accessories still hide
        // until the glide actually reaches the live edge.
        await fireScroll(240);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'away', progress: '1' });
        await fireScroll(0);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'bottom', progress: '0' });

        await advance(500);
        expect(readSwap(scopeEl).rest).not.toBe('compact');

        // Not vacuous: the same scroller, with the same geometry, still
        // collapses the moment a finger is behind the motion.
        await beginSwipe();
        await fireScroll(300);
        expect(readSwap(scopeEl)).toMatchObject({ rest: 'compact', progress: '1' });
    });

    test('a held tap or horizontal touch leaves program geometry unable to move compact', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        await fireTouch('touchend', 420);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });

        await fireTouch('touchstart', 520);
        await advance(COMPOSER_SWAP_USER_SCROLL_WINDOW_MS + 20);
        await fireScroll(260);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });

        await fireTouch('touchmove', 510, 1, 140);
        await fireScroll(220);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });

        await fireTouch('touchend', 510, 1, 140);
        await fireScroll(180);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });
    });

    test('touch cancellation clears claimed intent before later geometry frames', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        await fireTouch('touchend', 420);

        await fireTouch('touchstart', 520);
        await fireTouch('touchmove', 420);
        await fireTouch('touchcancel', 420);
        await fireScroll(260);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });
    });

    test('travel toward the bottom reveals the composer far from the live edge', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });
        await fireTouch('touchend', 420);

        // One short downward step stays below the reveal threshold.
        await fireScroll(280);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });

        // Travel accumulates across events, so a slow scroll qualifies too.
        await fireScroll(270);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'snapping',
            rest: 'expanded',
            progress: '0',
        });
        await advance(COMPOSER_SWAP_SNAP_MS);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'expanded',
            progress: '0',
        });

        // Later events of the same gesture are still far from the bottom; the
        // reveal has to survive them instead of collapsing on absolute distance.
        await fireScroll(260);
        expect(readSwap(scopeEl).rest).toBe('expanded');
        // Accessories have no background: stay hidden even while swap is expanded,
        // and a short approach toward the edge must not fade them in.
        expect(readDock(scopeEl)).toMatchObject({ rest: 'away', progress: '1' });
        await fireScroll(20);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'away', progress: '1' });
        await fireScroll(0);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'bottom', progress: '0' });

        // Scrolling back up hands the endpoint back to distance follow.
        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');
    });

    test('direction reversals restart reveal travel from the latest turn', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        await fireScroll(285);
        expect(readSwap(scopeEl).rest).toBe('compact');

        await fireScroll(310);
        await fireScroll(295);
        expect(readSwap(scopeEl).rest).toBe('compact');

        await fireScroll(284);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'snapping', rest: 'expanded' });
    });

    test('iOS top rubber-band spring-back is not downward travel', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');

        // Overscroll past the top, then let the spring return to rest. The
        // second event is 60px of downward motion with no intent behind it.
        await fireScrollTop(-60);
        expect(scrollEl.scrollTop).toBe(-60);
        await fireScrollTop(0);
        expect(readSwap(scopeEl).rest).toBe('compact');
    });

    /**
     * Loading older history prepends content and the list moves the scroll
     * position to keep the read position: content growth and the correction
     * land in separate frames, so the distance from the bottom leaps away and
     * back. That return leg is indistinguishable from a fast scroll toward the
     * live edge, and it flashed the composer open in the middle of a load.
     */
    test('a reserved send treats the parked offset as the live edge', async () => {
        await mount();

        // Parked with 200px of composer inset still below the hole. Raw
        // scrollHeight distance is 200, which would hide Changes; the park
        // attribute is the real end.
        const parkOffset = SCROLL_HEIGHT - CLIENT_HEIGHT - 200;
        scrollEl.setAttribute(TIMELINE_PARK_END_ATTRIBUTE, String(parkOffset));
        await beginSwipe();
        await fireScrollTop(parkOffset);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'bottom', progress: '0' });
        expect(readSwap(scopeEl).rest).not.toBe('compact');

        await fireScrollTop(parkOffset - 90);
        expect(readDock(scopeEl)).toMatchObject({ rest: 'away', progress: '1' });
    });

    test('the transcript re-anchoring a prepend never moves the composer', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');

        scrollEl.setAttribute(TIMELINE_ANCHORING_ATTRIBUTE, 'true');
        // The prepend lands: 2000px of older history above the viewport, then
        // the list's correction puts the read position back where it was.
        scrollHeight += 2000;
        await fireScroll(2300);
        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');

        // The released anchor cleared the previous swipe. A fresh vertical move
        // takes ownership immediately and can reveal from the corrected baseline.
        scrollEl.removeAttribute(TIMELINE_ANCHORING_ATTRIBUTE);
        await fireTouch('touchmove', 380);
        await fireScroll(270);
        expect(readSwap(scopeEl).rest).toBe('expanded');
    });

    test('load-older tap cannot turn released anchor compensation into a composer reveal', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(300);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });
        await fireTouch('touchend', 420);

        await advance(16);
        await fireTouch('touchstart', 48);
        await advance(16);
        await fireTouch('touchend', 48);
        const loadTapEndedAt = Date.now();

        scrollEl.setAttribute(TIMELINE_ANCHORING_ATTRIBUTE, 'true');
        scrollHeight += 2000;
        await fireScroll(2300);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });

        scrollEl.removeAttribute(TIMELINE_ANCHORING_ATTRIBUTE);
        await advance(16);
        expect(Date.now() - loadTapEndedAt).toBeLessThan(COMPOSER_SWAP_USER_SCROLL_WINDOW_MS);
        await fireScroll(300);
        expect.soft(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });
        await advance(COMPOSER_SWAP_SNAP_MS);
        expect(readSwap(scopeEl)).toEqual({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });
    });

    test('multi-touch counts until the last finger lifts', async () => {
        await mount();

        await fireTouch('touchstart', 520, 1);
        await fireTouch('touchstart', 500, 2);
        await advance(16);
        await fireTouch('touchmove', 420, 1);
        await fireScroll(30);
        expect(readSwap(scopeEl).phase).toBe('tracking');

        await fireTouch('touchend', 420, 1);
        await advance(500);
        expect(readSwap(scopeEl).phase).toBe('tracking');

        await fireTouch('touchend', 500, 2);
        await advance(120);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
        });
    });

    test('non-user frames preserve tracking while its existing idle timer commits', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(30);
        await fireTouch('touchend', 420);
        await advance(60);

        scrollEl.setAttribute(TIMELINE_ANCHORING_ATTRIBUTE, 'true');
        await fireScroll(300);
        scrollEl.removeAttribute(TIMELINE_ANCHORING_ATTRIBUTE);
        await fireScroll(20);
        await act(async () => {
            scrollEl.dispatchEvent(new Event('scrollend'));
        });
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'tracking',
            rest: 'expanded',
            progress: '0.375',
        });

        await advance(60);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'snapping', rest: 'expanded' });
    });

    test('a non-user size frame preserves snapping and its original settle timer', async () => {
        await mount();

        await beginSwipe();
        await fireScroll(60);
        await fireTouch('touchend', 420);
        await advance(120);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'snapping', rest: 'compact' });

        await advance(COMPOSER_SWAP_SNAP_MS / 2);
        scrollHeight += 200;
        await fireScroll(0);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'snapping', rest: 'compact' });

        await advance(COMPOSER_SWAP_SNAP_MS / 2);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'compact', progress: '1' });
    });
});
