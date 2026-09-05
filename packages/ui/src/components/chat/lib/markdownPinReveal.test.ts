import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    MARKDOWN_PIN_REVEAL_ATTR,
    MARKDOWN_PIN_REVEAL_TIMEOUT_MS,
    applyMarkdownPinRevealVisibility,
    areMountedRelevantMarkdownRowsReady,
    isTurnMarkdownReady,
    mergeMarkdownPinRevealStyle,
    observeMarkdownPinReveal,
    resolveMarkdownPinRevealKeys,
    shouldArmMarkdownPinReveal,
} from './markdownPinReveal';

const turn = (key: string, inner: string): string => (
    `<div data-turn-entry="${key}">${inner}</div>`
);

const host = (html: string): HTMLElement => {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
};

describe('markdown pin reveal keys', () => {
    test('seeds the same bottom window the hydration planner paints rich', () => {
        const keys = Array.from({ length: 20 }, (_, index) => `turn-${index}`);
        expect(resolveMarkdownPinRevealKeys({ entryKeys: keys, seedCount: 4 })).toEqual([
            'turn-16', 'turn-17', 'turn-18', 'turn-19',
        ]);
        expect(resolveMarkdownPinRevealKeys({ entryKeys: [] })).toEqual([]);
    });

    test('restore keys beyond the seed still count as pin-relevant', () => {
        const keys = Array.from({ length: 10 }, (_, index) => `turn-${index}`);
        const resolved = resolveMarkdownPinRevealKeys({
            entryKeys: keys,
            seedCount: 2,
            restore: new Set(['turn-1', 'turn-gone']),
        });
        expect(resolved).toContain('turn-1');
        expect(resolved).toContain('turn-8');
        expect(resolved).toContain('turn-9');
        expect(resolved).not.toContain('turn-gone');
    });
});

describe('shouldArmMarkdownPinReveal', () => {
    test('session-open arms only until the scope has revealed once', () => {
        expect(shouldArmMarkdownPinReveal({
            reason: 'session-open',
            alreadyRevealedForScope: false,
        })).toBe(true);
        expect(shouldArmMarkdownPinReveal({
            reason: 'session-open',
            alreadyRevealedForScope: true,
        })).toBe(false);
    });

    test('jump-to-latest re-arms after the first reveal', () => {
        expect(shouldArmMarkdownPinReveal({
            reason: 'jump-to-latest',
            alreadyRevealedForScope: true,
        })).toBe(true);
    });
});

describe('mounted markdown readiness', () => {
    test('a row with no markdown is ready', () => {
        const root = host(turn('turn-1', '<span>plain</span>'));
        const row = root.querySelector('[data-turn-entry]')!;
        expect(isTurnMarkdownReady(row)).toBe(true);
    });

    test('deferred hydration blocks readiness', () => {
        const root = host(turn(
            'turn-1',
            '<div data-markdown-hydration="deferred"></div>',
        ));
        expect(isTurnMarkdownReady(root.querySelector('[data-turn-entry]')!)).toBe(false);
    });

    test('content without a ready ancestor is pending', () => {
        const root = host(turn(
            'turn-1',
            '<div data-markdown-content></div>',
        ));
        expect(isTurnMarkdownReady(root.querySelector('[data-turn-entry]')!)).toBe(false);
    });

    test('ready attribute on the renderer root settles the row', () => {
        const root = host(turn(
            'turn-1',
            '<div data-markdown-ready="true"><div data-markdown-content></div></div>',
        ));
        expect(isTurnMarkdownReady(root.querySelector('[data-turn-entry]')!)).toBe(true);
    });

    test('only mounted seed keys must be ready; missing keys do not pass', () => {
        const root = host([
            turn('turn-8', '<div data-markdown-ready="true"><div data-markdown-content></div></div>'),
        ].join(''));
        expect(areMountedRelevantMarkdownRowsReady(root, new Set(['turn-8', 'turn-9']))).toBe(true);
        expect(areMountedRelevantMarkdownRowsReady(root, new Set(['turn-9']))).toBe(false);
        expect(areMountedRelevantMarkdownRowsReady(root, new Set())).toBe(true);
    });

    test('one pending seed row keeps the pin hidden', () => {
        const root = host([
            turn('turn-8', '<div data-markdown-ready="true"><div data-markdown-content></div></div>'),
            turn('turn-9', '<div data-markdown-hydration="deferred"></div>'),
        ].join(''));
        expect(areMountedRelevantMarkdownRowsReady(root, new Set(['turn-8', 'turn-9']))).toBe(false);
    });
});

describe('pin visibility helpers', () => {
    test('hidden style still allows layout by using visibility rather than display', () => {
        expect(mergeMarkdownPinRevealStyle({ opacity: 1 }, true)).toEqual({
            opacity: 1,
            visibility: 'hidden',
        });
        expect(mergeMarkdownPinRevealStyle({ opacity: 1 }, false)).toEqual({ opacity: 1 });
    });

    test('applies and clears the pin attribute on the scroller', () => {
        const node = document.createElement('div');
        applyMarkdownPinRevealVisibility(node, true);
        expect(node.style.visibility).toBe('hidden');
        expect(node.getAttribute(MARKDOWN_PIN_REVEAL_ATTR)).toBe('pending');
        applyMarkdownPinRevealVisibility(node, false);
        expect(node.style.visibility).toBe('');
        expect(node.getAttribute(MARKDOWN_PIN_REVEAL_ATTR)).toBe('ready');
    });
});

describe('observeMarkdownPinReveal', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('fires immediately when the seed window is already ready', () => {
        const root = host(turn(
            'turn-1',
            '<div data-markdown-ready="true"><div data-markdown-content></div></div>',
        ));
        const onReady = vi.fn();
        observeMarkdownPinReveal({
            root,
            relevantKeys: new Set(['turn-1']),
            onReady,
        });
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    test('reveals once when a deferred seed row becomes ready', async () => {
        const root = host(turn(
            'turn-1',
            '<div data-markdown-hydration="deferred"></div>',
        ));
        const onReady = vi.fn();
        observeMarkdownPinReveal({
            root,
            relevantKeys: new Set(['turn-1']),
            onReady,
        });
        expect(onReady).not.toHaveBeenCalled();

        const row = root.querySelector('[data-turn-entry]')!;
        const ready = document.createElement('div');
        ready.setAttribute('data-markdown-ready', 'true');
        ready.innerHTML = '<div data-markdown-content></div>';
        row.replaceChildren(ready);
        await Promise.resolve();
        await Promise.resolve();
        expect(onReady).toHaveBeenCalledTimes(1);

        const again = document.createElement('div');
        again.setAttribute('data-markdown-ready', 'true');
        again.innerHTML = '<div data-markdown-content></div>';
        row.replaceChildren(again);
        await Promise.resolve();
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    test('timeout reveals even if markdown never marks ready', () => {
        vi.useFakeTimers();
        const root = host(turn(
            'turn-1',
            '<div data-markdown-hydration="deferred"></div>',
        ));
        const onReady = vi.fn();
        observeMarkdownPinReveal({
            root,
            relevantKeys: new Set(['turn-1']),
            onReady,
            timeoutMs: MARKDOWN_PIN_REVEAL_TIMEOUT_MS,
        });
        expect(onReady).not.toHaveBeenCalled();
        vi.advanceTimersByTime(MARKDOWN_PIN_REVEAL_TIMEOUT_MS);
        expect(onReady).toHaveBeenCalledTimes(1);
    });
});
