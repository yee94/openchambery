import type { CSSProperties } from 'react';

import { createInitialMarkdownHydratedKeys } from './markdownHydrationWindow';

/**
 * Cold-open / jump-to-latest pin debounce.
 *
 * Seeded Markdown rows still settle their real heights after the first paint
 * (sync parse → decorate → async highlight). If the list is visible while that
 * happens, end-anchored pin and `maintainScrollAtEnd` chase every resize.
 * Hide the timeline with `visibility: hidden` (layout and measure still run),
 * wait until the seed-window rows report ready, then reveal once.
 *
 * Streaming live-tail growth must not re-arm this: those rows already paint
 * rich (`data-markdown-ready` on first commit) and hiding them would flash.
 */

export const MARKDOWN_READY_ATTR = 'data-markdown-ready';
export const MARKDOWN_HYDRATION_ATTR = 'data-markdown-hydration';
export const MARKDOWN_PIN_REVEAL_ATTR = 'data-markdown-pin-reveal';
export const MARKDOWN_PIN_REVEAL_TIMEOUT_MS = 600;

export type MarkdownPinRevealReason = 'session-open' | 'jump-to-latest';

export type MarkdownPinRevealKeysInput = {
    entryKeys: readonly string[];
    seedCount?: number;
    restore?: ReadonlySet<string> | null;
};

/** Bottom-entering keys the pin must wait on — same set the hydration seed paints rich. */
export const resolveMarkdownPinRevealKeys = (
    input: MarkdownPinRevealKeysInput,
): string[] => [...createInitialMarkdownHydratedKeys(input.entryKeys, {
    seedCount: input.seedCount,
    restore: input.restore,
})];

export const shouldArmMarkdownPinReveal = (input: {
    reason: MarkdownPinRevealReason;
    alreadyRevealedForScope: boolean;
}): boolean => {
    if (input.reason === 'jump-to-latest') return true;
    return !input.alreadyRevealedForScope;
};

export const isTurnMarkdownReady = (turn: Element): boolean => {
    if (turn.querySelector(`[${MARKDOWN_HYDRATION_ATTR}="deferred"]`)) {
        return false;
    }
    const contents = turn.querySelectorAll('[data-markdown-content]');
    if (contents.length === 0) {
        return true;
    }
    for (const node of contents) {
        if (!node.closest(`[${MARKDOWN_READY_ATTR}="true"]`)) {
            return false;
        }
    }
    return true;
};

/**
 * True when every *mounted* seed-window row is ready.
 *
 * Unmounted seed keys are ignored: the virtualizer only measures what it
 * mounted, and a timeout still covers a seed row that never appears.
 * An empty seed (empty transcript) is ready immediately.
 */
export const areMountedRelevantMarkdownRowsReady = (
    root: ParentNode,
    relevantKeys: ReadonlySet<string>,
): boolean => {
    if (relevantKeys.size === 0) {
        return true;
    }
    const turns = root.querySelectorAll('[data-turn-entry]');
    let sawRelevant = false;
    for (const turn of turns) {
        const key = turn.getAttribute('data-turn-entry');
        if (!key || !relevantKeys.has(key)) {
            continue;
        }
        sawRelevant = true;
        if (!isTurnMarkdownReady(turn)) {
            return false;
        }
    }
    return sawRelevant;
};

export const applyMarkdownPinRevealVisibility = (
    element: HTMLElement | null | undefined,
    hidden: boolean,
): void => {
    if (!element) return;
    if (hidden) {
        element.style.visibility = 'hidden';
        element.setAttribute(MARKDOWN_PIN_REVEAL_ATTR, 'pending');
        return;
    }
    element.style.removeProperty('visibility');
    element.setAttribute(MARKDOWN_PIN_REVEAL_ATTR, 'ready');
};

export const mergeMarkdownPinRevealStyle = (
    style: CSSProperties | undefined,
    hidden: boolean,
): CSSProperties | undefined => {
    if (!hidden) return style;
    return { ...style, visibility: 'hidden' };
};

type ObserveMarkdownPinRevealInput = {
    root: ParentNode;
    relevantKeys: ReadonlySet<string>;
    onReady: () => void;
    timeoutMs?: number;
    signal?: AbortSignal;
};

/**
 * Watch the timeline root until seeded Markdown is ready, then fire `onReady`
 * once. A timeout guarantees the list cannot stay hidden if a row never marks
 * ready (worker failure, empty mount).
 */
export const observeMarkdownPinReveal = ({
    root,
    relevantKeys,
    onReady,
    timeoutMs = MARKDOWN_PIN_REVEAL_TIMEOUT_MS,
    signal,
}: ObserveMarkdownPinRevealInput): () => void => {
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        onReady();
    };

    const check = () => {
        if (signal?.aborted) {
            finish();
            return;
        }
        if (areMountedRelevantMarkdownRowsReady(root, relevantKeys)) {
            finish();
        }
    };

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(check);
        const target = root instanceof Element
            ? root
            : root instanceof Document
                ? root.documentElement
                : null;
        if (target) {
            observer.observe(target, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: [MARKDOWN_READY_ATTR, MARKDOWN_HYDRATION_ATTR, 'data-turn-entry'],
            });
        }
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
        timeoutId = setTimeout(finish, timeoutMs);
    }

    const onAbort = () => finish();
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
        observer?.disconnect();
        observer = null;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        signal?.removeEventListener('abort', onAbort);
    };

    check();
    // happy-dom (and some WebKit builds) deliver childList records on a
    // microtask; a second look covers a commit that already landed.
    queueMicrotask(check);
    return () => {
        if (settled) return;
        settled = true;
        cleanup();
    };
};
