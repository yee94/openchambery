/**
 * History viewport anchor keeper — keeps a keyed message's viewport offset
 * stable across DOM mutations that land outside React's renderedMessages
 * dependency (slim→full materialization, markdown hydration, etc.).
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
    /** Quiet period after the last DOM mutation before auto-dispose. */
    quiesceMs?: number;
    /** Hard lifetime cap to prevent leaks. */
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

    const correct = () => {
        if (disposed) return;

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
        }

        const containerRect = container.getBoundingClientRect();
        const elementTop = element.getBoundingClientRect().top;
        const delta = elementTop - containerRect.top - anchor.offsetTop;
        if (Math.abs(delta) > CORRECT_EPSILON_PX) {
            container.scrollTop += delta;
        }
    };

    const scheduleCorrect = () => {
        if (disposed || microtaskScheduled) return;
        microtaskScheduled = true;
        queueMicrotask(() => {
            microtaskScheduled = false;
            correct();
        });
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
    };

    const onScroll = () => {
        rebase();
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

    maxLifetimeTimer = setTimeout(() => {
        maxLifetimeTimer = null;
        dispose();
    }, maxLifetimeMs);

    resetQuiesceTimer();

    return { rebase, dispose };
};
