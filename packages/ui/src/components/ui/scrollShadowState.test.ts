import { describe, expect, test } from 'vitest';

import { applyVerticalScrollShadow, prepareScrollShadowElement } from './scrollShadowState';

const makeScroller = (metrics: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
}): HTMLElement => {
    const el = document.createElement('div');
    Object.defineProperties(el, {
        scrollTop: { configurable: true, get: () => metrics.scrollTop },
        clientHeight: { configurable: true, get: () => metrics.clientHeight },
        scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    });
    return el;
};

describe('applyVerticalScrollShadow', () => {
    test('marks the top fade after leaving the start', () => {
        const el = makeScroller({ scrollTop: 40, clientHeight: 200, scrollHeight: 200 });
        expect(applyVerticalScrollShadow(el)).toBe('top');
        expect(el.getAttribute('data-top-scroll')).toBe('true');
        expect(el.getAttribute('data-bottom-scroll')).toBe('false');
    });

    test('marks the bottom fade while content remains below', () => {
        const el = makeScroller({ scrollTop: 0, clientHeight: 200, scrollHeight: 400 });
        expect(applyVerticalScrollShadow(el)).toBe('bottom');
        expect(el.getAttribute('data-bottom-scroll')).toBe('true');
        expect(el.getAttribute('data-top-scroll')).toBe('false');
    });

    test('marks both edges while clipped on both sides', () => {
        const el = makeScroller({ scrollTop: 40, clientHeight: 200, scrollHeight: 400 });
        expect(applyVerticalScrollShadow(el)).toBe('both');
        expect(el.getAttribute('data-top-bottom-scroll')).toBe('true');
        expect(el.hasAttribute('data-top-scroll')).toBe(false);
        expect(el.hasAttribute('data-bottom-scroll')).toBe(false);
    });

    test('hides the bottom fade when requested even if content remains', () => {
        const el = makeScroller({ scrollTop: 0, clientHeight: 200, scrollHeight: 400 });
        expect(applyVerticalScrollShadow(el, { hideBottomShadow: true })).toBe('none');
        expect(el.getAttribute('data-bottom-scroll')).toBe('false');
    });

    test('treats a subpixel remainder at the end as settled', () => {
        const el = makeScroller({ scrollTop: 199.6, clientHeight: 200, scrollHeight: 400 });
        expect(applyVerticalScrollShadow(el)).toBe('top');
        expect(el.getAttribute('data-bottom-scroll')).toBe('false');
    });
});

describe('prepareScrollShadowElement', () => {
    test('stamps the mask contract the CSS selectors read', () => {
        const el = document.createElement('div');
        prepareScrollShadowElement(el, 48);
        expect(el.dataset.scrollShadow).toBe('true');
        expect(el.dataset.orientation).toBe('vertical');
        expect(el.style.getPropertyValue('--scroll-shadow-size')).toBe('48px');
    });
});
