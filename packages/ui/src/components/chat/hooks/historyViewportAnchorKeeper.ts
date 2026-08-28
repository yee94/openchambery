/**
 * History viewport anchor keeper — keeps a keyed message's viewport offset
 * stable across DOM mutations that land outside React's renderedMessages
 * dependency (slim→full materialization, markdown hydration, etc.).
 *
 * External scrollTop writes (user / virtualizer) win over mutation correction:
 * if scrollTop changed since the last keeper write/rebase, correct() rebases
 * and skips compensation so a mutation microtask cannot roll back the user.
 *
 * Pure DOM module. Callers gate mobile / virtualized paths.
 */

export interface HistoryViewportAnchor {
    messageId: string;
    /** Offset of the anchor element's top relative to the container viewport top. */
    offsetTop: number;
}

export interface HistoryViewportAnchorKeeper {
    /** After user scroll: rebase expected offset to the live offset (do not fight the user). */
    rebase(): void;
    /** Stop keeping; disconnect observers and clear timers. Idempotent. */
    dispose(): void;
}

const DEFAULT_QUIESCE_MS = 600;
const DEFAULT_MAX_LIFETIME_MS = 6000;
const CORRECT_EPSILON_PX = 0.5;

type MutableAnchor = {
    messageId: string;
    offsetTop: number;
};

const findAnchorElement = (
    container: HTMLElement,
    messageId: string,
): HTMLElement | null => {
    return container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
    );
};

const findFirstVisibleMessage = (container: HTMLElement): HTMLElement | null => {
    const containerRect = container.getBoundingClientRect();
    const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const node of nodes) {
        if (node.getBoundingClientRect().bottom > containerRect.top) {
            return node;
        }
    }
    return null;
};

const resolveLiveAnchor = (
    container: HTMLElement,
    preferredMessageId: string,
): HistoryViewportAnchor | null => {
    let element = findAnchorElement(container, preferredMessageId);
    if (!element) {
        element = findFirstVisibleMessage(container);
    }
    if (!element) return null;
    const messageId = element.dataset.messageId;
    if (!messageId) return null;
    const containerRect = container.getBoundingClientRect();
    return {
        messageId,
        offsetTop: element.getBoundingClientRect().top - containerRect.top,
    };
};

export const createHistoryViewportAnchorKeeper = (input: {
    container: HTMLElement;
    anchor: HistoryViewportAnchor;
    /** Quiet period after the last DOM mutation / scroll before auto-dispose. */
    quiesceMs?: number;
    /**
     * Idle hard cap: longest survival with no scroll activity after arming.
     * User scroll re-arms it. Leak prevention when the reading session goes idle.
     */
    maxLifetimeMs?: number;
}): HistoryViewportAnchorKeeper => {
    const {
        container,
        quiesceMs = DEFAULT_QUIESCE_MS,
        maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
    } = input;

    const anchor: MutableAnchor = {
        messageId: input.anchor.messageId,
        offsetTop: input.anchor.offsetTop,
    };

    let disposed = false;
    let quiesceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;
    let microtaskScheduled = false;
    /** Last scrollTop observed after our own write or an accepted rebase. */
    let lastKnownScrollTop = container.scrollTop;

    const clearQuiesceTimer = () => {
        if (quiesceTimer !== null) {
            clearTimeout(quiesceTimer);
            quiesceTimer = null;
        }
    };

    const clearMaxLifetimeTimer = () => {
        if (maxLifetimeTimer !== null) {
            clearTimeout(maxLifetimeTimer);
            maxLifetimeTimer = null;
        }
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        container.removeEventListener('scroll', onScroll);
        clearQuiesceTimer();
        clearMaxLifetimeTimer();
    };

    const resetQuiesceTimer = () => {
        clearQuiesceTimer();
        if (disposed) return;
        quiesceTimer = setTimeout(() => {
            quiesceTimer = null;
            dispose();
        }, quiesceMs);
    };

    /** User scroll re-arms the idle cap; the keeper lives while the reading session is active. */
    const resetMaxLifetimeTimer = () => {
        clearMaxLifetimeTimer();
        if (disposed) return;
        maxLifetimeTimer = setTimeout(() => {
            maxLifetimeTimer = null;
            dispose();
        }, maxLifetimeMs);
    };

    const rebase = () => {
        if (disposed) return;
        const live = resolveLiveAnchor(container, anchor.messageId);
        if (!live) {
            dispose();
            return;
        }
        anchor.messageId = live.messageId;
        anchor.offsetTop = live.offsetTop;
        lastKnownScrollTop = container.scrollTop;
    };

    const correct = () => {
        if (disposed) return;

        // External scrollTop write landed before this mutation microtask
        // (user scroll / virtualizer). Accept reality — never correct against
        // a stale offsetTop or we roll the user's scroll back.
        if (Math.abs(container.scrollTop - lastKnownScrollTop) > CORRECT_EPSILON_PX) {
            rebase();
            return;
        }

        let element = findAnchorElement(container, anchor.messageId);
        if (!element) {
            const replacement = findFirstVisibleMessage(container);
            if (!replacement) {
                dispose();
                return;
            }
            const messageId = replacement.dataset.messageId;
            if (!messageId) {
                dispose();
                return;
            }
            const containerRect = container.getBoundingClientRect();
            anchor.messageId = messageId;
            anchor.offsetTop = replacement.getBoundingClientRect().top - containerRect.top;
            element = replacement;
            lastKnownScrollTop = container.scrollTop;
        }

        const containerRect = container.getBoundingClientRect();
        const elementTop = element.getBoundingClientRect().top;
        const delta = elementTop - containerRect.top - anchor.offsetTop;
        if (Math.abs(delta) > CORRECT_EPSILON_PX) {
            container.scrollTop += delta;
        }
        lastKnownScrollTop = container.scrollTop;
    };

    const scheduleCorrect = () => {
        if (disposed || microtaskScheduled) return;
        microtaskScheduled = true;
        queueMicrotask(() => {
            microtaskScheduled = false;
            correct();
        });
    };

    const onScroll = () => {
        rebase();
        // Scrolling means the keeper is still needed: later hydration /
        // materialization batches keep landing while the user reads history.
        // Rebase first (accept the new position), then stay armed for the
        // quiet window after scrolling stops.
        resetQuiesceTimer();
        resetMaxLifetimeTimer();
    };

    const observer = new MutationObserver(() => {
        if (disposed) return;
        scheduleCorrect();
        resetQuiesceTimer();
    });

    observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
    });

    container.addEventListener('scroll', onScroll, { passive: true });

    resetMaxLifetimeTimer();
    resetQuiesceTimer();

    return { rebase, dispose };
};
