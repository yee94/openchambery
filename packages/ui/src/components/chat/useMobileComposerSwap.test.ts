import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { COMPOSER_SWAP_CSS_VAR, COMPOSER_SWAP_SNAP_MS } from './mobileComposerSwap';
import { useMobileComposerSwap } from './useMobileComposerSwap';

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 600;

const setDistance = (scrollEl: HTMLElement, distance: number) => {
    // distance = scrollHeight - scrollTop - clientHeight
    scrollEl.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT - distance;
};

const readSwap = (scopeEl: HTMLElement) => ({
    phase: scopeEl.dataset.ocComposerSwapPhase,
    rest: scopeEl.dataset.ocComposerSwapRest,
    progress: scopeEl.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR),
});

describe('useMobileComposerSwap gesture commit', () => {
    let container: HTMLElement;
    let root: Root;
    let scrollEl: HTMLElement;
    let scopeEl: HTMLElement;
    let scrollRef: React.RefObject<HTMLElement | null>;
    let scopeRef: React.RefObject<HTMLElement | null>;

    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        scrollEl = document.createElement('div');
        scopeEl = document.createElement('div');
        Object.defineProperty(scrollEl, 'scrollHeight', {
            configurable: true,
            get: () => SCROLL_HEIGHT,
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

    const fireTouch = async (type: 'touchstart' | 'touchend') => {
        await act(async () => {
            scrollEl.dispatchEvent(new Event(type));
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

    test('held finger never commits — flash regression', async () => {
        await mount();

        await fireTouch('touchstart');
        await fireScroll(30);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'tracking',
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

        await fireTouch('touchstart');
        await fireScroll(30);
        expect(readSwap(scopeEl).phase).toBe('tracking');
        expect(Number(readSwap(scopeEl).progress)).toBeCloseTo(0.375);

        await fireTouch('touchend');
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

        await fireTouch('touchstart');
        await fireScroll(100);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'rest',
            rest: 'compact',
            progress: '1',
        });

        await fireScroll(10);
        expect(readSwap(scopeEl).phase).toBe('tracking');
        expect(Number(readSwap(scopeEl).progress)).toBeCloseTo(0.125);

        await fireTouch('touchend');
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

    test('travel toward the bottom reveals the composer far from the live edge', async () => {
        await mount();

        await fireScroll(300);
        expect(readSwap(scopeEl)).toMatchObject({ rest: 'compact', progress: '1' });

        // One short downward step stays below the reveal threshold.
        await fireScroll(280);
        expect(readSwap(scopeEl).rest).toBe('compact');

        // Travel accumulates across events, so a slow scroll qualifies too.
        await fireScroll(270);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'snapping', rest: 'expanded' });
        await advance(COMPOSER_SWAP_SNAP_MS);
        expect(readSwap(scopeEl)).toMatchObject({ phase: 'rest', rest: 'expanded' });

        // Later events of the same gesture are still far from the bottom; the
        // reveal has to survive them instead of collapsing on absolute distance.
        await fireScroll(260);
        expect(readSwap(scopeEl).rest).toBe('expanded');

        // Scrolling back up hands the endpoint back to distance follow.
        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');
    });

    test('iOS top rubber-band spring-back is not downward travel', async () => {
        await mount();

        await fireScroll(300);
        expect(readSwap(scopeEl).rest).toBe('compact');

        // Overscroll past the top, then let the spring return to rest. The
        // second event is 60px of downward motion with no intent behind it.
        await fireScrollTop(-60);
        expect(scrollEl.scrollTop).toBe(-60);
        await fireScrollTop(0);
        expect(readSwap(scopeEl).rest).toBe('compact');
    });

    test('multi-touch counts until the last finger lifts', async () => {
        await mount();

        await fireTouch('touchstart');
        await fireTouch('touchstart');
        await fireScroll(30);
        expect(readSwap(scopeEl).phase).toBe('tracking');

        await fireTouch('touchend');
        await advance(500);
        expect(readSwap(scopeEl).phase).toBe('tracking');

        await fireTouch('touchend');
        await advance(120);
        expect(readSwap(scopeEl)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
        });
    });
});
