// Upward-intent detection for chat history pagination.
//
// Loading earlier history has two triggers: an ordinary `scroll` event, and an
// explicit upward gesture. The second one is not redundant — once scrollTop is
// already 0 no further scroll event fires, so a user who keeps pulling up at
// the top would otherwise get nothing.
//
// These helpers used to be private to `useChatAutoFollow`, which meant the
// trigger disappeared wherever auto-follow was switched off. They live here so
// a timeline that owns its own scroll position can subscribe to the same
// gesture semantics without adopting the auto-follow machinery.

import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';

/** Finger travel (px, downward positive) that counts as deliberate upward intent. */
export const TOUCH_FINGER_DOWN_THRESHOLD = 2;

export const isReleaseKey = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
            return true;
        default:
            return false;
    }
};

// Wheel/touch upward intent must not fire while a nested scroller inside the
// chat root can still consume the gesture. Walk ancestors from event.target to
// (but not including) root; geometry alone — no selectors, no getComputedStyle.
export const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    let node: Element | null = target instanceof Element
        ? target
        : target instanceof Node
            ? target.parentElement
            : null;
    while (node && node !== root) {
        if (node instanceof HTMLElement) {
            if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1) {
                return true;
            }
        }
        node = node.parentElement;
    }
    return false;
};

type UseHistoryUpwardIntentOptions = {
    scrollRef: React.RefObject<HTMLElement | null>;
    enabled?: boolean;
    onUpwardIntent: () => void;
};

/**
 * Fires `onUpwardIntent` on explicit upward wheel/touch/key gestures over the
 * scroll container. Purely a notifier: it never touches the scroll position, so
 * it is safe on a timeline whose scroll position belongs to the list.
 */
export const useHistoryUpwardIntent = ({
    scrollRef,
    enabled = true,
    onUpwardIntent,
}: UseHistoryUpwardIntentOptions): void => {
    const touchLastYRef = React.useRef<number | null>(null);

    const notify = useEvent(() => {
        onUpwardIntent();
    });

    const handleWheel = useEvent((event: WheelEvent) => {
        const container = scrollRef.current;
        if (!container) return;
        if (event.deltaY >= 0) return;
        if (!(container instanceof HTMLElement)) return;
        if (nestedScrollableCanConsumeUp(container, event.target)) return;
        notify();
    });

    const handleTouchStart = useEvent((event: TouchEvent) => {
        const touch = event.touches.item(0);
        touchLastYRef.current = touch ? touch.clientY : null;
    });

    const handleTouchMove = useEvent((event: TouchEvent) => {
        const container = scrollRef.current;
        const touch = event.touches.item(0);
        if (!touch) {
            touchLastYRef.current = null;
            return;
        }
        const previousY = touchLastYRef.current;
        touchLastYRef.current = touch.clientY;
        if (previousY === null) return;
        const fingerDelta = touch.clientY - previousY;
        if (fingerDelta <= TOUCH_FINGER_DOWN_THRESHOLD) return;
        if (!container || !(container instanceof HTMLElement)) return;
        if (nestedScrollableCanConsumeUp(container, event.target)) return;
        notify();
    });

    const handleTouchEnd = useEvent(() => {
        touchLastYRef.current = null;
    });

    const handleKeyDown = useEvent((event: KeyboardEvent) => {
        if (!isReleaseKey(event)) return;
        notify();
    });

    // The element only exists after the list mounts its scroller, so the target
    // is resolved lazily on every bind. `useEventListener` falls back to window
    // for a null target — resolve to undefined instead so we attach nowhere
    // until the container is real.
    const [containerEl, setContainerEl] = React.useState<HTMLElement | null>(null);
    React.useEffect(() => {
        const next = scrollRef.current ?? null;
        setContainerEl((current) => (current === next ? current : next));
    });

    const noEventTarget = React.useMemo(() => () => undefined, []);
    const target = enabled && containerEl ? containerEl : noEventTarget;
    const passive = React.useMemo(() => ({ passive: true } as const), []);

    useEventListener('wheel', handleWheel, target, passive);
    useEventListener('touchstart', handleTouchStart, target, passive);
    useEventListener('touchmove', handleTouchMove, target, passive);
    useEventListener('touchend', handleTouchEnd, target, passive);
    useEventListener('touchcancel', handleTouchEnd, target, passive);
    useEventListener('keydown', handleKeyDown, target);
};
