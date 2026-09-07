import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';

import {
    COMPOSER_SWAP_COMPACT_SETTLE_MS,
    COMPOSER_SWAP_FULL_RANGE_PX,
    COMPOSER_SWAP_IDLE_MS,
    COMPOSER_SWAP_NOISE_PX,
    COMPOSER_SWAP_REVEAL_TRAVEL_PX,
    COMPOSER_SWAP_SNAP_MS,
    COMPOSER_SWAP_USER_SCROLL_WINDOW_MS,
    applyComposerSwapCommit,
    applyComposerSwapForce,
    applyComposerSwapPin,
    applyComposerSwapScroll,
    applyComposerSwapSnapDone,
    clearComposerSwap,
    createComposerSwapState,
    publishComposerSwap,
    publishNativeComposerDock,
    type ComposerSwapState,
} from './mobileComposerSwap';
import {
    readTimelineParkEndOffset,
    resolveScrollDistanceFromLiveEdge,
    TIMELINE_ANCHORING_ATTRIBUTE,
} from './lib/scroll/timelineScrollAnchoring';

const readScrollGeometry = (el: HTMLElement) => ({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
});

type TouchGesturePoint = {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
};

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
    const publishedDockRef = React.useRef<{ progress: string; rest: string } | undefined>(undefined);
    const idleTimerRef = React.useRef<number | null>(null);
    const snapTimerRef = React.useRef<number | null>(null);
    /** Until this timestamp, compact→expand follow is suppressed (momentum only). */
    const compactSettleUntilRef = React.useRef(0);
    /** Once the user leaves the bottom band after compact, settle ends early. */
    const compactSettleArmedRef = React.useRef(false);
    /** Active touches on the scroller; commits wait for the finger to lift. */
    const touchActiveRef = React.useRef(0);
    /** Active touch positions, rebased whenever program anchoring owns geometry. */
    const touchPointsRef = React.useRef(new Map<number, TouchGesturePoint>());
    /** A vertical touchmove claimed the current gesture and its momentum. */
    const verticalTouchIntentRef = React.useRef(false);
    /** Last moment claimed touch motion could hand off to momentum. */
    const lastTouchAtRef = React.useRef(0);
    /** Previous distance from the bottom, so scrolls carry a direction. */
    const lastDistanceRef = React.useRef<number | null>(null);
    /** Previous dimensions separate size-driven geometry from scroll travel. */
    const lastGeometryRef = React.useRef<ReturnType<typeof readScrollGeometry> | null>(null);
    /** Travel since the last direction change, accumulated in each direction. */
    const downwardTravelRef = React.useRef(0);
    const upwardTravelRef = React.useRef(0);
    /** A scroll reveal owns the expanded endpoint until the user scrolls up. */
    const holdExpandedRef = React.useRef(false);
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

    const rebaseTouchIntent = useEvent(() => {
        verticalTouchIntentRef.current = false;
        lastTouchAtRef.current = 0;
        for (const point of touchPointsRef.current.values()) {
            point.startX = point.currentX;
            point.startY = point.currentY;
        }
    });

    const handleTouchMove = useEvent((event: TouchEvent) => {
        if (!enabledRef.current) return;
        let hasVerticalMove = false;
        for (let index = 0; index < event.changedTouches.length; index += 1) {
            const touch = event.changedTouches[index];
            if (!touch) continue;
            const point = touchPointsRef.current.get(touch.identifier);
            if (!point) {
                touchPointsRef.current.set(touch.identifier, {
                    startX: touch.clientX,
                    startY: touch.clientY,
                    currentX: touch.clientX,
                    currentY: touch.clientY,
                });
                continue;
            }
            point.currentX = touch.clientX;
            point.currentY = touch.clientY;
            const horizontalTravel = Math.abs(point.currentX - point.startX);
            const verticalTravel = Math.abs(point.currentY - point.startY);
            if (verticalTravel > 0 && verticalTravel > horizontalTravel) {
                hasVerticalMove = true;
            }
        }
        if (!hasVerticalMove && !verticalTouchIntentRef.current) return;
        verticalTouchIntentRef.current = true;
        lastTouchAtRef.current = Date.now();
        compactSettleArmedRef.current = false;
        compactSettleUntilRef.current = 0;
    });

    const handleTouchStart = useEvent((event: TouchEvent) => {
        if (!enabledRef.current) return;
        const startsGesture = touchActiveRef.current === 0;
        if (startsGesture) {
            touchPointsRef.current.clear();
            rebaseTouchIntent();
            downwardTravelRef.current = 0;
            upwardTravelRef.current = 0;
            const scrollEl = args.scrollRef.current;
            if (scrollEl) {
                const geometry = readScrollGeometry(scrollEl);
                lastGeometryRef.current = geometry;
                lastDistanceRef.current = resolveScrollDistanceFromLiveEdge(
                    geometry,
                    readTimelineParkEndOffset(scrollEl),
                );
            }
        }
        for (let index = 0; index < event.changedTouches.length; index += 1) {
            const touch = event.changedTouches[index];
            if (!touch) continue;
            touchPointsRef.current.set(touch.identifier, {
                startX: touch.clientX,
                startY: touch.clientY,
                currentX: touch.clientX,
                currentY: touch.clientY,
            });
        }
        touchActiveRef.current = touchPointsRef.current.size;
        // A held finger owns the commit lifecycle, so an earlier idle commit
        // waits even while this gesture is still deciding its axis.
        clearTimer(idleTimerRef);
    });

    const handleScroll = useEvent(() => {
        if (!enabledRef.current) return;
        const scrollEl = args.scrollRef.current;
        const scope = args.scopeRef.current;
        if (!scrollEl || !scope) return;
        const pinned = isComposerPinned(scope);
        const geometry = readScrollGeometry(scrollEl);
        const distance = resolveScrollDistanceFromLiveEdge(
            geometry,
            readTimelineParkEndOffset(scrollEl),
        );
        const previousDistance = lastDistanceRef.current;
        const previousGeometry = lastGeometryRef.current;
        lastDistanceRef.current = distance;
        lastGeometryRef.current = geometry;

        // A history prepend is absorbed by the list, not the user: it grows the
        // content and moves the scroll position to match, and the correction
        // lands over several frames. Each of those frames is a distance change
        // with no gesture behind it — and the transients read as travel in both
        // directions, so the composer would flash open (or collapse) in the
        // middle of loading older history. The baseline above still advances,
        // so the first frame after the anchor settles measures from where the
        // transcript actually is.
        if (scrollEl.hasAttribute(TIMELINE_ANCHORING_ATTRIBUTE)) {
            downwardTravelRef.current = 0;
            upwardTravelRef.current = 0;
            rebaseTouchIntent();
            return;
        }

        // Dock follows raw distance on every frame. Swap can rest expanded far
        // from the live edge; accessories have no background and must not.
        publishedDockRef.current = publishNativeComposerDock(
            scope,
            distance,
            publishedDockRef.current,
        );

        // The transcript scrolls for two very different reasons on this path:
        // the user dragging, and the list following its own streaming growth.
        // Only the former may move the composer.
        const gestureOwnsScroll = verticalTouchIntentRef.current
            && (touchActiveRef.current > 0
                || Date.now() - lastTouchAtRef.current <= COMPOSER_SWAP_USER_SCROLL_WINDOW_MS);
        const sizeChanged = previousGeometry !== null
            && (previousGeometry.scrollHeight !== geometry.scrollHeight
                || previousGeometry.clientHeight !== geometry.clientHeight);
        const userDriven = gestureOwnsScroll && !sizeChanged;

        // Direction comes from the change in distance rather than scrollTop:
        // history prepends move scrollTop and scrollHeight together, and tail
        // growth moves scrollHeight alone, so neither reads as user travel.
        // iOS top rubber-band springs a negative scrollTop back to 0, which is
        // real downward travel with no intent behind it — excluded here.
        const delta = previousDistance === null ? 0 : previousDistance - distance;
        if (!userDriven) {
            // Growth and glide frames are not travel in either direction. Zero
            // the accumulators so the next real gesture starts from its own
            // first pixel instead of inheriting the stream's motion.
            downwardTravelRef.current = 0;
            upwardTravelRef.current = 0;
        } else if (delta > 0) {
            upwardTravelRef.current = 0;
            if (geometry.scrollTop > 0) {
                downwardTravelRef.current += delta;
            }
        } else if (delta < 0) {
            downwardTravelRef.current = 0;
            upwardTravelRef.current += -delta;
            if (upwardTravelRef.current >= COMPOSER_SWAP_REVEAL_TRAVEL_PX) {
                holdExpandedRef.current = false;
            }
        }
        if (userDriven && distance <= COMPOSER_SWAP_NOISE_PX) {
            holdExpandedRef.current = false;
        }

        const previousState = stateRef.current;
        let next = applyComposerSwapPin(previousState, pinned);
        if (!pinned) {
            const wasCompact = next.rest === 'compact';
            next = applyComposerSwapScroll(next, distance, {
                suppressReturn: userDriven && resolveSuppressReturn(distance),
                towardBottom: downwardTravelRef.current >= COMPOSER_SWAP_REVEAL_TRAVEL_PX,
                holdExpanded: holdExpandedRef.current,
                userDriven,
            });
            if (wasCompact && next.rest === 'expanded' && distance > COMPOSER_SWAP_NOISE_PX) {
                holdExpandedRef.current = true;
                downwardTravelRef.current = 0;
            }
        }
        replaceState(next);
        if (!userDriven) return;
        clearTimer(idleTimerRef);
        // A scroll-driven reveal snaps from inside the scroll handler, so the
        // settle timer has to be armed here too or the phase would never rest.
        if (next.phase === 'snapping') {
            if (previousState.phase !== 'snapping'
                || previousState.rest !== next.rest
                || previousState.progress !== next.progress) {
                armSnapDone();
            }
            return;
        }
        if (previousState.phase === 'snapping') {
            clearTimer(snapTimerRef);
        }
        if (next.phase === 'tracking' && touchActiveRef.current === 0) {
            idleTimerRef.current = window.setTimeout(() => {
                idleTimerRef.current = null;
                commitIdle();
            }, COMPOSER_SWAP_IDLE_MS);
        }
    });

    const handleScrollEnd = useEvent(() => {
        const gestureOwnsScroll = verticalTouchIntentRef.current
            && (touchActiveRef.current > 0
                || Date.now() - lastTouchAtRef.current <= COMPOSER_SWAP_USER_SCROLL_WINDOW_MS);
        if (!gestureOwnsScroll) return;
        commitIdle();
    });

    const finishTouch = useEvent((event: TouchEvent, allowMomentum: boolean) => {
        if (!enabledRef.current) return;
        for (let index = 0; index < event.changedTouches.length; index += 1) {
            const touch = event.changedTouches[index];
            if (touch) touchPointsRef.current.delete(touch.identifier);
        }
        touchActiveRef.current = touchPointsRef.current.size;
        if (touchActiveRef.current > 0) return;
        touchPointsRef.current.clear();
        if (allowMomentum && verticalTouchIntentRef.current) {
            lastTouchAtRef.current = Date.now();
        } else {
            rebaseTouchIntent();
        }
        // iOS often omits scrollend; arm the same idle commit after the finger
        // lifts. Momentum scroll events keep deferring it until quiescence.
        if (stateRef.current.phase !== 'tracking') return;
        clearTimer(idleTimerRef);
        idleTimerRef.current = window.setTimeout(() => {
            idleTimerRef.current = null;
            commitIdle();
        }, COMPOSER_SWAP_IDLE_MS);
    });

    const handleTouchEnd = useEvent((event: TouchEvent) => {
        finishTouch(event, true);
    });

    const handleTouchCancel = useEvent((event: TouchEvent) => {
        finishTouch(event, false);
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
        // Focus/keyboard normally pins expanded, but a tap that never lands
        // focus would otherwise be collapsed again by the next scroll event.
        holdExpandedRef.current = true;
        downwardTravelRef.current = 0;
        upwardTravelRef.current = 0;
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
        publishedDockRef.current = undefined;
        compactSettleArmedRef.current = false;
        compactSettleUntilRef.current = 0;
        touchActiveRef.current = 0;
        touchPointsRef.current.clear();
        verticalTouchIntentRef.current = false;
        lastTouchAtRef.current = 0;
        lastDistanceRef.current = null;
        lastGeometryRef.current = null;
        downwardTravelRef.current = 0;
        upwardTravelRef.current = 0;
        holdExpandedRef.current = false;
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
    useEventListener('touchmove', handleTouchMove, scrollTarget, passive);
    useEventListener('touchend', handleTouchEnd, scrollTarget, passive);
    useEventListener('touchcancel', handleTouchCancel, scrollTarget, passive);
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
