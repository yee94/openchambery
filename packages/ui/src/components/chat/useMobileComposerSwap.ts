import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';

import {
    COMPOSER_SWAP_COMPACT_SETTLE_MS,
    COMPOSER_SWAP_FULL_RANGE_PX,
    COMPOSER_SWAP_IDLE_MS,
    COMPOSER_SWAP_SNAP_MS,
    applyComposerSwapCommit,
    applyComposerSwapForce,
    applyComposerSwapPin,
    applyComposerSwapScroll,
    applyComposerSwapSnapDone,
    clearComposerSwap,
    createComposerSwapState,
    distanceFromBottomOf,
    publishComposerSwap,
    type ComposerSwapState,
} from './mobileComposerSwap';

const readScrollGeometry = (el: HTMLElement) => ({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
});

const isKeyboardPinned = (): boolean => {
    const root = document.documentElement;
    return root.classList.contains('oc-keyboard-open')
        || root.classList.contains('oc-kb-animating');
};

const isComposerPinned = (scope: HTMLElement): boolean => {
    if (isKeyboardPinned()) return true;
    if (scope.querySelector('[data-oc-composer-dictation-active="true"]')) return true;
    const active = document.activeElement;
    return active instanceof HTMLElement
        && active.matches('textarea[data-chat-input="true"]')
        && scope.contains(active);
};

export const useMobileComposerSwap = (args: {
    enabled: boolean;
    scrollRef: React.RefObject<HTMLElement | null>;
    scopeRef: React.RefObject<HTMLElement | null>;
}): void => {
    const stateRef = React.useRef<ComposerSwapState>(createComposerSwapState());
    const publishedRef = React.useRef<{ progress: string; phase: string; rest: string } | undefined>(undefined);
    const idleTimerRef = React.useRef<number | null>(null);
    const snapTimerRef = React.useRef<number | null>(null);
    /** Until this timestamp, compact→expand follow is suppressed (momentum only). */
    const compactSettleUntilRef = React.useRef(0);
    /** Once the user leaves the bottom band after compact, settle ends early. */
    const compactSettleArmedRef = React.useRef(false);
    /** Active touches on the scroller; commits wait for the finger to lift. */
    const touchActiveRef = React.useRef(0);
    const enabledRef = React.useRef(args.enabled);
    enabledRef.current = args.enabled;

    const clearTimer = (ref: React.MutableRefObject<number | null>) => {
        if (ref.current === null) return;
        window.clearTimeout(ref.current);
        ref.current = null;
    };

    const publish = useEvent((state: ComposerSwapState) => {
        const scope = args.scopeRef.current;
        if (!scope) return;
        publishedRef.current = publishComposerSwap(scope, state, publishedRef.current);
    });

    const replaceState = useEvent((next: ComposerSwapState) => {
        if (next === stateRef.current) return;
        stateRef.current = next;
        publish(next);
    });

    const armSnapDone = useEvent(() => {
        clearTimer(snapTimerRef);
        if (stateRef.current.phase !== 'snapping') return;
        const snapRest = stateRef.current.rest;
        snapTimerRef.current = window.setTimeout(() => {
            snapTimerRef.current = null;
            const done = applyComposerSwapSnapDone(stateRef.current);
            replaceState(done);
            if (done.rest === 'compact' && snapRest === 'compact') {
                compactSettleUntilRef.current = Date.now() + COMPOSER_SWAP_COMPACT_SETTLE_MS;
                compactSettleArmedRef.current = true;
            }
        }, COMPOSER_SWAP_SNAP_MS);
    });

    const syncPin = useEvent(() => {
        const scope = args.scopeRef.current;
        if (!scope || !enabledRef.current) return;
        replaceState(applyComposerSwapPin(stateRef.current, isComposerPinned(scope)));
    });

    const resolveSuppressReturn = useEvent((distance: number): boolean => {
        if (!compactSettleArmedRef.current) return false;
        if (Date.now() >= compactSettleUntilRef.current) {
            compactSettleArmedRef.current = false;
            return false;
        }
        // Leaving the bottom band ends settle early so the next return can track.
        if (distance >= COMPOSER_SWAP_FULL_RANGE_PX) {
            compactSettleArmedRef.current = false;
            compactSettleUntilRef.current = 0;
            return false;
        }
        return true;
    });

    const commitIdle = useEvent(() => {
        clearTimer(idleTimerRef);
        if (!enabledRef.current) return;
        if (touchActiveRef.current > 0) return;
        if (stateRef.current.phase !== 'tracking') return;
        const next = applyComposerSwapCommit(stateRef.current);
        replaceState(next);
        armSnapDone();
    });

    const handleTouchStart = useEvent(() => {
        if (!enabledRef.current) return;
        touchActiveRef.current += 1;
        // A held finger owns the gesture; pending idle commits from prior
        // touch-less scrolls (wheel/trackpad/programmatic) must not fire now.
        clearTimer(idleTimerRef);
    });

    const handleScroll = useEvent(() => {
        if (!enabledRef.current) return;
        const scrollEl = args.scrollRef.current;
        const scope = args.scopeRef.current;
        if (!scrollEl || !scope) return;
        const pinned = isComposerPinned(scope);
        const distance = distanceFromBottomOf(readScrollGeometry(scrollEl));
        let next = applyComposerSwapPin(stateRef.current, pinned);
        if (!pinned) {
            next = applyComposerSwapScroll(next, distance, {
                suppressReturn: resolveSuppressReturn(distance),
            });
        }
        replaceState(next);
        clearTimer(idleTimerRef);
        if (next.phase === 'tracking' && touchActiveRef.current === 0) {
            idleTimerRef.current = window.setTimeout(() => {
                idleTimerRef.current = null;
                commitIdle();
            }, COMPOSER_SWAP_IDLE_MS);
        }
    });

    const handleScrollEnd = useEvent(() => {
        commitIdle();
    });

    const handleTouchEnd = useEvent(() => {
        if (!enabledRef.current) return;
        touchActiveRef.current = Math.max(0, touchActiveRef.current - 1);
        if (touchActiveRef.current > 0) return;
        // iOS often omits scrollend; arm the same idle commit after the finger
        // lifts. Momentum scroll events keep deferring it until quiescence.
        if (stateRef.current.phase !== 'tracking') return;
        clearTimer(idleTimerRef);
        idleTimerRef.current = window.setTimeout(() => {
            idleTimerRef.current = null;
            commitIdle();
        }, COMPOSER_SWAP_IDLE_MS);
    });

    const armExpandFocusShield = useEvent(() => {
        const scope = args.scopeRef.current;
        if (!scope || typeof window === 'undefined') return;
        const swallow = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        // Compact goes pointer-events:none mid-gesture; the synthesized click then
        // lands on the transcript and steals focus. Swallow the rest of this tap.
        scope.addEventListener('pointerup', swallow, true);
        scope.addEventListener('click', swallow, true);
        window.setTimeout(() => {
            scope.removeEventListener('pointerup', swallow, true);
            scope.removeEventListener('click', swallow, true);
        }, COMPOSER_SWAP_SNAP_MS);
    });

    const handleCompactActivate = useEvent((event: Event) => {
        if (!enabledRef.current) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const compact = target.closest('[data-oc-composer-compact-surface="true"]');
        if (!compact) return;
        if (target.closest('[data-composer-action="true"]')) return;
        if ('preventDefault' in event) event.preventDefault();
        if ('stopPropagation' in event) event.stopPropagation();
        replaceState(applyComposerSwapForce(stateRef.current, 'expanded'));
        armSnapDone();
        armExpandFocusShield();
        const textarea = args.scopeRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
        textarea?.focus({ preventScroll: true });
    });

    const [scrollEl, setScrollEl] = React.useState<HTMLElement | null>(null);
    const [scopeEl, setScopeEl] = React.useState<HTMLElement | null>(null);
    const lastScopeRef = React.useRef<HTMLElement | null>(null);
    const releaseScope = useEvent((scope: HTMLElement | null) => {
        if (scope) clearComposerSwap(scope);
        publishedRef.current = undefined;
        compactSettleArmedRef.current = false;
        compactSettleUntilRef.current = 0;
        touchActiveRef.current = 0;
        replaceState(createComposerSwapState());
    });
    React.useLayoutEffect(() => {
        const nextScroll = args.enabled ? args.scrollRef.current : null;
        const nextScope = args.enabled ? args.scopeRef.current : null;
        if (lastScopeRef.current && lastScopeRef.current !== nextScope) {
            releaseScope(lastScopeRef.current);
        }
        lastScopeRef.current = nextScope;
        setScrollEl((prev) => (prev === nextScroll ? prev : nextScroll));
        setScopeEl((prev) => (prev === nextScope ? prev : nextScope));
    });

    const noEventTarget = React.useMemo(() => () => undefined, []);
    const scrollTarget = args.enabled && scrollEl ? scrollEl : noEventTarget;
    const scopeTarget = args.enabled && scopeEl ? scopeEl : noEventTarget;
    const windowTarget = args.enabled && typeof window !== 'undefined' ? window : noEventTarget;
    const passive = React.useMemo(() => ({ passive: true } as const), []);

    useEventListener('scroll', handleScroll, scrollTarget, passive);
    useEventListener('scrollend', handleScrollEnd, scrollTarget, passive);
    useEventListener('touchstart', handleTouchStart, scrollTarget, passive);
    useEventListener('touchend', handleTouchEnd, scrollTarget, passive);
    useEventListener('touchcancel', handleTouchEnd, scrollTarget, passive);
    useEventListener('pointerdown', handleCompactActivate, scopeTarget);
    useEventListener('focusin', syncPin, scopeTarget);
    useEventListener('focusout', syncPin, scopeTarget);
    useEventListener('oc:keyboard-intent', syncPin, windowTarget);
    useEventListener('oc:keyboard-anim', syncPin, windowTarget);
    useEventListener('oc:keyboard-settled', syncPin, windowTarget);

    React.useEffect(() => {
        if (!args.enabled) {
            releaseScope(lastScopeRef.current);
            lastScopeRef.current = null;
            return;
        }
        syncPin();
        handleScroll();
        return () => {
            clearTimer(idleTimerRef);
            clearTimer(snapTimerRef);
        };
        // enabled is the semantic rebind; handlers are useEvent and must not
        // control this effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [args.enabled, scrollEl, scopeEl]);
};
