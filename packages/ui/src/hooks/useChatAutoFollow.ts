import React from 'react';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { resolveChatBottomZoneThresholdPx } from '@/components/chat/lib/scroll/chatTailSpacer';
import {
    TOUCH_FINGER_DOWN_THRESHOLD,
    isReleaseKey,
    nestedScrollableCanConsumeUp,
} from '@/hooks/lib/chatUpwardIntent';
import { getViewportSessionMemory, useViewportStore, type SessionMemoryState } from '@/sync/viewport-store';

type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission' | 'animation';

export type ViewportIdentity = {
    sessionId: string | null;
    viewportKey?: string;
};

export const createViewportIdentity = (sessionId: string | null, viewportKey?: string): ViewportIdentity => ({ sessionId, viewportKey });

export const isSameViewportIdentity = (left: ViewportIdentity | null, right: ViewportIdentity | null): boolean => (
    left?.sessionId === right?.sessionId && left?.viewportKey === right?.viewportKey
);

export const shouldReplayViewportRestore = (pending: ViewportIdentity | null, current: ViewportIdentity): boolean => (
    isSameViewportIdentity(pending, current)
);

export type ViewportSnapshotSave = {
    identity: ViewportIdentity;
    anchor: number;
    scrollPosition: NonNullable<SessionMemoryState['scrollPosition']>;
};

export const createViewportSnapshotSave = (
    identity: ViewportIdentity,
    anchor: number,
    scrollPosition: NonNullable<SessionMemoryState['scrollPosition']>,
): ViewportSnapshotSave => ({ identity, anchor, scrollPosition });

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

interface UseChatAutoFollowOptions {
    enabled?: boolean;
    currentSessionId: string | null;
    viewportKey?: string;
    sessionMessageCount: number;
    sessionIsWorking: boolean;
    isMobile: boolean;
    onActiveTurnChange?: (turnId: string | null) => void;
    /** Desktop history: fired after release on explicit upward wheel/touch/key intent. Not used for scrollbar pointer. */
    onUpwardUserIntent?: () => void;
}

export interface UseChatAutoFollowResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    state: AutoFollowState;
    isPinned: boolean;
    isOverflowing: boolean;
    isFollowingProgrammatically: boolean;
    showScrollButton: boolean;
    notifyContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    scrollToBottomOnSend: () => void;
    releaseAutoFollow: () => void;
    beginHistoryViewportPreservation: () => void;
    endHistoryViewportPreservation: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────────
// Chat auto-follow. The model is deliberately simple, which is what makes it
// flicker-free:
//
//   • Auto-follow is on unless the user scrolled up (`released`). While
//     `following`, content growth (cold history paint, virtualizer remeasure,
//     async tool/code height) must silently re-pin to the bottom — including
//     idle sessions. History load must not strand a bottom-pinned viewport
//     mid-timeline. User wheel/touch/key gestures release immediately and are
//     never fought.
//   • Following the bottom is INSTANT — `scrollTop = scrollHeight` inside the
//     content ResizeObserver, which fires after layout and before paint. There
//     is NO easing loop and NO settle burst, so there are never two writers
//     racing for `scrollTop` (the root cause of the old jiggle/double-scroll).
//   • A short-lived "auto" marker (position + 1500ms) lets the scroll handler
//     distinguish our own programmatic writes from genuine user scrolling, so
//     a scroll event that lands at our just-written bottom never trips a false
//     release.
//
// Explicit history pagination holds auto-follow released until its keyed viewport
// restoration completes, so virtualizer measurement scroll events cannot claim
// bottom ownership during that transaction.
// ──────────────────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 150;
// How long an "auto" (programmatic) scroll position stays trusted. Browsers can
// dispatch the `scroll` event for our write asynchronously, after newer content
// has already changed the geometry; the window keeps us from reading that lag as
// a user scroll.
const AUTO_MARK_TTL_MS = 1500;
const AUTO_MATCH_TOLERANCE_PX = 2;
// While a tracked height animation runs (e.g. a Thinking block auto-collapsing
// mid-stream), the timeline shrinks/grows over a couple hundred ms and the
// virtualizer re-measures, producing transient geometry. Browsers dispatch the
// resulting `scroll` events asynchronously, so a stale event can land after we
// have already re-pinned — its position matching neither the bottom zone nor the
// freshly-moved auto marker — and be misread as a user scroll-away. During this
// guard window we treat any `following`-state scroll event as our own and never
// release via the heuristic. GENUINE user gestures still release instantly
// through releaseFromUserIntent, so this is not glue. Sized to the reasoning
// animation (200ms) plus headroom for trailing async scroll events.
const ANIMATION_GUARD_MS = 350;
// Entry-stick window. On the FIRST open of a session, late async data (most
// visibly a task/subagent tool whose nested rows are fetched from the child
// session after entry — see useEnsureSessionMessages in ToolPart.tsx) grows the
// timeline a beat or two AFTER we have already pinned to the bottom. Steady-state
// `following` already re-pins on growth; entry-stick FORCE-pins even if a false
// `released` slipped in before the first gesture. It ends QUIESCENCE_MS after
// growth stops (capped by MAX_MS), or instantly on any real user scroll gesture.
const ENTRY_STICK_QUIESCENCE_MS = 600;
const ENTRY_STICK_MAX_MS = 8000;
const FORCE_BOTTOM_WATCHDOG_FRAMES = 24;
const FORCE_BOTTOM_TOLERANCE_PX = 2;
// Opening a session on iOS delivers the list-row tap onto the newly mounted
// transcript (same finger, often a 2px+ move). That leftover gesture used to
// trip releaseFromUserIntent / cancel the force-bottom watchdog — the pin
// flashed at the latest message, then hydration grew rows above an already
// released viewport and stranded the user mid-timeline.
export const SESSION_OPEN_PIN_GRACE_MS = 450;

export const isWithinSessionOpenPinGrace = (nowMs: number, graceUntilMs: number): boolean => (
    nowMs < graceUntilMs
);

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// The empty spacer at the bottom of the chat is exactly how far above
// scrollHeight the user can be while still looking at "empty" space, so its
// height is also the threshold for re-pinning auto-follow and for showing the
// scroll-to-bottom button — see chat/lib/scroll/chatTailSpacer, which owns both
// readings.
// One scroll event used to read scrollTop/scrollHeight/clientHeight five times
// through the helpers below, with React writes interleaved between the reads —
// every read after a write is a forced layout, and it showed up as the single
// largest reflow source while scrolling. Read the box once and pass the snapshot
// to the geometry helpers instead.
type ScrollGeometry = {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
};

const readScrollGeometry = (el: HTMLElement): ScrollGeometry => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
});

const distanceFromBottomOf = (geometry: ScrollGeometry): number => {
    return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
};

const distanceFromBottom = (el: HTMLElement): number => {
    return distanceFromBottomOf(readScrollGeometry(el));
};

const canScrollGeometry = (geometry: ScrollGeometry): boolean => {
    return geometry.scrollHeight - geometry.clientHeight > 1;
};

const isNearBottomOf = (geometry: ScrollGeometry, isMobile: boolean): boolean => {
    return distanceFromBottomOf(geometry) <= resolveChatBottomZoneThresholdPx(isMobile, geometry.clientHeight);
};

export const useChatAutoFollow = ({
    enabled = true,
    currentSessionId,
    viewportKey,
    sessionMessageCount,
    sessionIsWorking,
    isMobile,
    onActiveTurnChange,
    onUpwardUserIntent,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
    const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

    const [state, setState] = React.useState<AutoFollowState>('following');
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);

    // `stateRef` is the single source of truth for follow vs released; the React
    // state above is a mirror for rendering. `released` means the user scrolled
    // up and away from the bottom.
    const stateRef = React.useRef<AutoFollowState>('following');
    const isMobileRef = React.useRef(isMobile);
    isMobileRef.current = isMobile;
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentViewportIdentityRef = React.useRef(createViewportIdentity(currentSessionId, viewportKey));
    currentViewportIdentityRef.current = createViewportIdentity(currentSessionId, viewportKey);
    const lastViewportIdentityRef = React.useRef<ViewportIdentity | null>(null);

    // Programmatic-scroll marker: the bottom position we last
    // wrote and when. A scroll event whose scrollTop matches `top` within a few
    // px while still inside the TTL is OUR write, not the user's.
    const autoRef = React.useRef<{ top: number; time: number } | null>(null);
    const autoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const forceBottomGenerationRef = React.useRef(0);
    const forceBottomFrameRef = React.useRef<number | null>(null);
    const forceBottomTouchCleanupRef = React.useRef<(() => void) | null>(null);

    // Timestamp until which a tracked height animation is in flight (see
    // ANIMATION_GUARD_MS). 0 = no animation guard active.
    const animationGuardUntilRef = React.useRef(0);

    // True while the native (Capacitor) keyboard geometry is changing or the
    // keyboard is open. Composer expand + IME resize must not chase the chat
    // scroller to the bottom — the message list keeps its scrollTop (IM-style
    // stable main view); only the composer/shell follow the keyboard.
    // Content-growth follow (streaming, notifyContentChange) stays independent.
    const keyboardGeometryFreezeRef = React.useRef(false);
    // Settled keyboard open (from oc:keyboard-settled). Distinct from freeze:
    // expand freezes provisionally before willShow; only settled open keeps the
    // freeze for the whole IME session.
    const keyboardOpenRef = React.useRef(false);
    const keyboardExpandFreezeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sessionOpenPinGraceUntilRef = React.useRef(0);

    const armSessionOpenPinGrace = useEvent(() => {
        sessionOpenPinGraceUntilRef.current = now() + SESSION_OPEN_PIN_GRACE_MS;
    });

    // Last observed scrollTop, used to derive scroll DIRECTION in the scroll
    // handler so the bottom-zone re-engage only fires when arriving at the bottom
    // by scrolling down — never when a user scrolling UP merely lands in the zone.
    const lastScrollTopRef = React.useRef(0);

    // Entry-stick window state (see ENTRY_STICK_* above).
    const entryStickRef = React.useRef(false);
    const entryStickQuietTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const entryStickCapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const entryStickLastHeightRef = React.useRef(0);
    const historyViewportPreservationRef = React.useRef(false);

    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = React.useRef<ViewportSnapshotSave | null>(null);
    // When restoreSnapshot is invoked while ChatViewport is still hydrating
    // (skeleton rendered, no scroll container yet), we record the session here
    // so a follow-up effect can replay the restore once the container mounts.
    const pendingInitialRestoreRef = React.useRef<ViewportIdentity | null>(null);

    const updateViewportAnchor = useViewportStore((s) => s.updateViewportAnchor);

    // Detect when the scroll container DOM element changes (mount, unmount, remount).
    // Without this, listener-attach effects would only ever bind to the element that
    // existed at the hook's first render, missing later mounts (e.g. after first send
    // promotes a draft session to a real chat with messages).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useLayoutEffect(() => {
        if (scrollRef.current !== lastSeenContainerRef.current) {
            lastSeenContainerRef.current = scrollRef.current;
            setContainerEl(scrollRef.current);
        }
    });

    const setStateValue = useEvent((next: AutoFollowState) => {
        if (stateRef.current === next) return;
        stateRef.current = next;
        setState(next);
    });

    // ── auto marker ────────────────────────────────────────────────────────
    const markAuto = useEvent((el: HTMLElement) => {
        autoRef.current = {
            top: Math.max(0, el.scrollHeight - el.clientHeight),
            time: now(),
        };
        if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
        autoTimerRef.current = setTimeout(() => {
            autoRef.current = null;
            autoTimerRef.current = null;
        }, AUTO_MARK_TTL_MS);
    });

    const isAuto = useEvent((el: HTMLElement): boolean => {
        const a = autoRef.current;
        if (!a) return false;
        if (now() - a.time > AUTO_MARK_TTL_MS) {
            autoRef.current = null;
            return false;
        }
        return Math.abs(el.scrollTop - a.top) < AUTO_MATCH_TOLERANCE_PX;
    });

    const isAnimationGuardActive = useEvent((): boolean => {
        return now() < animationGuardUntilRef.current;
    });

    // ── entry-stick window ───────────────────────────────────────────────────
    const endEntryStick = useEvent(() => {
        entryStickRef.current = false;
        if (entryStickQuietTimerRef.current) {
            clearTimeout(entryStickQuietTimerRef.current);
            entryStickQuietTimerRef.current = null;
        }
        if (entryStickCapTimerRef.current) {
            clearTimeout(entryStickCapTimerRef.current);
            entryStickCapTimerRef.current = null;
        }
    });

    // (Re)arm the quiescence timer: the window closes this long after the last
    // growth. Called once on begin and again on every growth-driven re-pin.
    const armEntryStickQuiet = useEvent(() => {
        if (entryStickQuietTimerRef.current) {
            clearTimeout(entryStickQuietTimerRef.current);
        }
        entryStickQuietTimerRef.current = setTimeout(() => {
            entryStickQuietTimerRef.current = null;
            endEntryStick();
        }, ENTRY_STICK_QUIESCENCE_MS);
    });

    const beginEntryStick = useEvent(() => {
        const el = scrollRef.current;
        if (!el) return;
        entryStickRef.current = true;
        entryStickLastHeightRef.current = el.scrollHeight;
        armEntryStickQuiet();
        // Reset the absolute cap fresh on every entry (e.g. session switch) so a
        // stale cap from a previous open can't cut this window short.
        if (entryStickCapTimerRef.current) {
            clearTimeout(entryStickCapTimerRef.current);
        }
        entryStickCapTimerRef.current = setTimeout(() => {
            entryStickCapTimerRef.current = null;
            endEntryStick();
        }, ENTRY_STICK_MAX_MS);
    });

    // ── overflow / scroll-to-bottom button ──────────────────────────────────
    const updateOverflowAndButton = useEvent((geometry?: ScrollGeometry) => {
        const container = scrollRef.current;
        if (!container) {
            setIsOverflowing(false);
            setShowScrollButton(false);
            return;
        }
        const box = geometry ?? readScrollGeometry(container);
        const overflowing = canScrollGeometry(box);
        setIsOverflowing(overflowing);
        if (!overflowing) {
            setShowScrollButton(false);
            return;
        }
        const showButton = stateRef.current === 'released' && !isNearBottomOf(box, isMobileRef.current);
        setShowScrollButton(showButton);
    });

    // ── core scroll primitives ───────────────────────────────────────────────
    const cancelForcedBottom = useEvent(() => {
        forceBottomGenerationRef.current += 1;
        if (forceBottomFrameRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(forceBottomFrameRef.current);
            forceBottomFrameRef.current = null;
        }
        forceBottomTouchCleanupRef.current?.();
        forceBottomTouchCleanupRef.current = null;
    });

    // containerEl identity is the real rebind condition; cancelForcedBottom is useEvent.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelForcedBottom is useEvent-stable; identity must not control this effect.
    React.useEffect(() => () => cancelForcedBottom(), [containerEl]);

    const forceBottomDefeatingMomentum = useEvent(() => {
        if (!enabled) return;
        const el = scrollRef.current;
        if (!el) return;

        cancelForcedBottom();
        const generation = forceBottomGenerationRef.current;
        const previousOverflow = el.style.overflow;
        const previousScrollBehavior = el.style.scrollBehavior;
        el.style.scrollBehavior = 'auto';
        el.style.overflow = 'hidden';
        el.scrollTop = el.scrollHeight;
        void el.scrollHeight;
        el.style.overflow = previousOverflow;
        el.style.scrollBehavior = previousScrollBehavior;

        const pin = () => {
            markAuto(el);
            el.scrollTop = el.scrollHeight;
            lastScrollTopRef.current = el.scrollTop;
        };
        pin();
        updateOverflowAndButton();

        if (typeof window === 'undefined') return;
        let frames = 0;
        const cancelOnUserTouch = () => {
            if (isWithinSessionOpenPinGrace(now(), sessionOpenPinGraceUntilRef.current)) return;
            cancelForcedBottom();
        };
        el.addEventListener('touchstart', cancelOnUserTouch, { passive: true, once: true });
        forceBottomTouchCleanupRef.current = () => el.removeEventListener('touchstart', cancelOnUserTouch);

        const watch = () => {
            if (generation !== forceBottomGenerationRef.current) return;
            if (distanceFromBottom(el) > FORCE_BOTTOM_TOLERANCE_PX) pin();
            frames += 1;
            if (frames >= FORCE_BOTTOM_WATCHDOG_FRAMES) {
                forceBottomFrameRef.current = null;
                forceBottomTouchCleanupRef.current?.();
                forceBottomTouchCleanupRef.current = null;
                updateOverflowAndButton();
                return;
            }
            forceBottomFrameRef.current = window.requestAnimationFrame(watch);
        };
        forceBottomFrameRef.current = window.requestAnimationFrame(watch);
    });

    const scrollToBottomNow = useEvent((behavior: ScrollBehavior) => {
        const el = scrollRef.current;
        if (!el) return;
        markAuto(el);
        if (behavior === 'smooth') {
            el.scrollTo({ top: el.scrollHeight, behavior });
            return;
        }
        // Direct `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`
        // and lands in the same frame — no visible catch-up animation.
        el.scrollTop = el.scrollHeight;
    });

    // `force` true = user-intent jump (clears released and always scrolls).
    // `force` false = passive follow (only while still following — idle ok).
    const scrollToBottom = useEvent((force: boolean, behavior: ScrollBehavior = 'auto') => {
        if (!enabled) return;
        const el = scrollRef.current;

        if (force && stateRef.current !== 'following') {
            setStateValue('following');
        }
        if (!el) return;
        // Passive follow never runs after the user scrolled away. Forced jumps
        // (send, go-to-bottom, session restore, entry-stick) always proceed.
        if (!force && stateRef.current !== 'following') return;

        const distance = distanceFromBottom(el);
        if (distance < AUTO_MATCH_TOLERANCE_PX) {
            // Already at the bottom; just refresh the auto marker so the next
            // scroll event is recognised as ours.
            markAuto(el);
            return;
        }
        scrollToBottomNow(force ? behavior : 'auto');
    });

    // User left the bottom — release auto-follow.
    const stop = useEvent((geometry?: ScrollGeometry) => {
        const el = scrollRef.current;
        if (!el) return;
        const box = geometry ?? readScrollGeometry(el);
        if (!canScrollGeometry(box)) {
            setStateValue('following');
            return;
        }
        if (stateRef.current === 'released') return;
        setStateValue('released');
        updateOverflowAndButton(box);
    });

    // ── public scroll API (mapped onto the primitives) ───────────────────────
    const goToBottom = useEvent((mode: 'instant' | 'smooth' = 'instant') => {
        historyViewportPreservationRef.current = false;
        setStateValue('following');
        endEntryStick();
        if (mode === 'instant') {
            forceBottomDefeatingMomentum();
            return;
        }
        cancelForcedBottom();
        scrollToBottom(true, 'smooth');
        updateOverflowAndButton();
    });

    const scrollToBottomOnSend = useEvent(() => {
        historyViewportPreservationRef.current = false;
        // Single movement to the just-sent message. Force re-pins to the bottom
        // whether we were following or scrolled up; the content ResizeObserver
        // keeps us pinned as the optimistic message and its reply stream in.
        scrollToBottom(true);
    });

    const releaseAutoFollow = useEvent(() => {
        cancelForcedBottom();
        endEntryStick();
        setStateValue('released');
        updateOverflowAndButton();
    });

    const beginHistoryViewportPreservation = useEvent(() => {
        historyViewportPreservationRef.current = true;
        releaseAutoFollow();
    });

    const endHistoryViewportPreservation = useEvent(() => {
        historyViewportPreservationRef.current = false;
    });

    const onUpwardUserIntentRef = React.useRef(onUpwardUserIntent);
    onUpwardUserIntentRef.current = onUpwardUserIntent;

    const releaseFromUserIntent = useEvent(() => {
        // A genuine user gesture (wheel/touch/key/scrollbar) cancels the entry
        // window immediately so we never fight the user's read position.
        // The session-open grace absorbs the leftover list-row tap on iOS.
        if (isWithinSessionOpenPinGrace(now(), sessionOpenPinGraceUntilRef.current)) return;
        cancelForcedBottom();
        endEntryStick();
        stop();
    });

    // After release, notify desktop history loading. Scrollbar pointer uses
    // releaseFromUserIntent only — it must not fire this callback.
    const notifyUpwardUserIntent = useEvent(() => {
        releaseFromUserIntent();
        onUpwardUserIntentRef.current?.();
    });

    // ── per-session snapshot persistence (kept; restore still goes to bottom) ─
    const flushSave = useEvent(() => {
        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        if (!pending) return;
        if (!pending.identity.sessionId) {
            pendingSaveRef.current = null;
            return;
        }
        updateViewportAnchor(
            pending.identity.sessionId,
            pending.anchor,
            pending.scrollPosition,
            pending.identity.viewportKey,
        );
        pendingSaveRef.current = null;
    });

    const queueSave = useEvent(() => {
        const identity = currentViewportIdentityRef.current;
        if (!identity.sessionId) return;
        const container = scrollRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const anchorRatio = scrollHeight > 0
            ? (scrollTop + clientHeight / 2) / scrollHeight
            : 0;
        const anchor = Math.floor(anchorRatio * sessionMessageCountRef.current);

        pendingSaveRef.current = createViewportSnapshotSave(
            identity,
            anchor,
            { scrollTop, scrollHeight, clientHeight },
        );
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            flushSave();
        }, SAVE_DEBOUNCE_MS);
    });

    const saveSnapshotNow = useEvent(() => {
        flushSave();
    });

    const restoreSnapshot = useEvent(async (identity = currentViewportIdentityRef.current): Promise<boolean> => {
        if (!identity.sessionId) return false;
        historyViewportPreservationRef.current = false;
        const snapshot = getViewportSessionMemory(identity.sessionId, identity.viewportKey);

        const container = scrollRef.current;
        if (!container) {
            // ChatViewport not mounted yet (e.g., session still hydrating).
            // Record the request so the container-attach effect can replay it.
            pendingInitialRestoreRef.current = identity;
            setStateValue('following');
            return false;
        }
        pendingInitialRestoreRef.current = null;
        lastScrollTopRef.current = snapshot?.scrollPosition?.scrollTop ?? 0;

        // Always return to the bottom on session switch. The content
        // ResizeObserver re-pins instantly as late
        // history measures in, so there is no smooth scroll-from-mid artifact.
        setStateValue('following');
        armSessionOpenPinGrace();
        // iOS overwrites a single scrollTop write while the opening tap's
        // momentum / leftover touch is still settling. The force-bottom
        // watchdog holds the pin across that window; desktop stays one-shot.
        if (isMobileRef.current) {
            forceBottomDefeatingMomentum();
        } else {
            scrollToBottom(true);
        }
        // Hold the bottom across late async growth (e.g. task/subagent child
        // session data landing a beat after entry) until content quiesces or the
        // user scrolls.
        beginEntryStick();
        updateOverflowAndButton();
        return false;
    });

    // ── session change ───────────────────────────────────────────────────────
    React.useEffect(() => {
        const identity = currentViewportIdentityRef.current;
        const previousIdentity = lastViewportIdentityRef.current;
        if (isSameViewportIdentity(identity, previousIdentity)) {
            return;
        }
        flushSave();
        cancelForcedBottom();
        armSessionOpenPinGrace();
        lastViewportIdentityRef.current = identity;
        autoRef.current = null;
        lastScrollTopRef.current = 0;
        endEntryStick();
        historyViewportPreservationRef.current = false;
        setStateValue('following');
        pendingInitialRestoreRef.current = null;
        if (currentSessionId && currentSessionId !== previousIdentity?.sessionId) {
            MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- viewport identity is the real input; cancelForcedBottom/endEntryStick/flushSave/setStateValue are useEvent-stable.
    }, [currentSessionId, viewportKey]);

    // When work begins and we are still following, pin to the bottom so the
    // first streaming frame does not paint mid-history.
    React.useEffect(() => {
        if (
            sessionIsWorking
            && !historyViewportPreservationRef.current
            && stateRef.current === 'following'
        ) {
            scrollToBottom(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionIsWorking is the real input; scrollToBottom is useEvent-stable.
    }, [sessionIsWorking]);

    // Suppress the overlay scrollbar thumb only while we are actively following a
    // live stream (the thumb would otherwise jump on every instant re-pin). When
    // idle or released the scrollbar behaves normally. Stable: changes only when
    // follow-state or working-state flips, not on every frame.
    React.useEffect(() => {
        setIsFollowingProgrammatically(state === 'following' && sessionIsWorking);
    }, [state, sessionIsWorking]);

    // Replay a deferred restoreSnapshot once ChatViewport mounts.
    // useLayoutEffect ensures scroll position is set before the browser paints,
    // preventing a visible flash of content at the wrong scroll position.
    React.useLayoutEffect(() => {
        if (!containerEl) return;
        const pendingIdentity = pendingInitialRestoreRef.current;
        if (pendingIdentity && shouldReplayViewportRestore(pendingIdentity, currentViewportIdentityRef.current)) {
            void restoreSnapshot(pendingIdentity);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- container/session identity is the real input; restoreSnapshot is useEvent-stable.
    }, [containerEl, currentSessionId, viewportKey]);

    // ── scroll event handling ────────────────────────────────────────────────
    const handleScrollEvent = useEvent(() => {
        const el = scrollRef.current;
        if (!el) return;

        const geometry = readScrollGeometry(el);
        const previousTop = lastScrollTopRef.current;
        lastScrollTopRef.current = geometry.scrollTop;
        const scrollingDown = geometry.scrollTop > previousTop + 0.5;
        // Pure content growth (history paint / remeasure) often fires `scroll`
        // without changing scrollTop. That must re-pin, not release — otherwise
        // a cold load leaves following stranded mid-timeline.
        const scrollTopUnchanged = Math.abs(geometry.scrollTop - previousTop) < 0.5;

        updateOverflowAndButton(geometry);

        if (historyViewportPreservationRef.current) {
            queueSave();
            return;
        }

        if (!canScrollGeometry(geometry)) {
            setStateValue('following');
            return;
        }

        // Within the bottom zone → (re-)pin to following. This is how scrolling
        // back DOWN to the bottom resumes auto-follow. Crucially, re-engage only
        // when the user arrives by scrolling down (or is already following, or is
        // essentially at the true bottom). A user scrolling UP that merely lands
        // in the bottom spacer zone must NOT be yanked back into follow — that is
        // the dead-zone fight that made small upward scrolls impossible while
        // content streams.
        if (isNearBottomOf(geometry, isMobileRef.current)) {
            const atTrueBottom = distanceFromBottomOf(geometry) <= AUTO_MATCH_TOLERANCE_PX;
            if (scrollingDown || stateRef.current === 'following' || atTrueBottom) {
                setStateValue('following');
            }
            queueSave();
            return;
        }

        // Our own geometry change (programmatic write, height animation, or
        // content growth that left scrollTop alone) — keep following, re-pin.
        // Keyboard geometry freeze is the exception: keep scrollTop stable so
        // the main chat does not jump when the IME or composer resizes.
        if (
            stateRef.current === 'following'
            && (isAuto(el) || isAnimationGuardActive() || scrollTopUnchanged)
        ) {
            if (!keyboardGeometryFreezeRef.current) {
                scrollToBottom(false);
            }
            queueSave();
            return;
        }

        // Genuine user scroll away from the bottom.
        stop(geometry);
        queueSave();
    });

    // Seed lastScrollTop when the scroller attaches so the first scroll event
    // has a real previousTop baseline (direction / unchanged detection).
    React.useEffect(() => {
        if (!enabled || !containerEl) return;
        lastScrollTopRef.current = containerEl.scrollTop;
    }, [containerEl, enabled]);

    const touchLastYRef = React.useRef<number | null>(null);

    const handleWheel = useEvent((event: WheelEvent) => {
        const container = scrollRef.current;
        if (!container) return;
        if (event.deltaY >= 0) return;
        if (nestedScrollableCanConsumeUp(container, event.target)) return;
        notifyUpwardUserIntent();
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
        if (!container) return;
        if (nestedScrollableCanConsumeUp(container, event.target)) return;
        notifyUpwardUserIntent();
    });

    const handleTouchEnd = useEvent(() => {
        touchLastYRef.current = null;
    });

    const handleKeyDown = useEvent((event: KeyboardEvent) => {
        if (!isReleaseKey(event)) return;
        notifyUpwardUserIntent();
    });

    const handlePointerDownIntent = useEvent((event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest('[data-overlay-scrollbar-thumb]')) return;
        // Scrollbar drag releases follow but is not an upward-intent load signal.
        releaseFromUserIntent();
    });

    // Target is the real attach/detach condition; handlers are useEvent so they
    // must not appear in effect-style rebind deps (useEventListener already
    // keeps the latest handler via useLatest).
    // useEventListener falls back to window when the target is null/undefined —
    // pass a getter that resolves to undefined so we attach nowhere until ready.
    const noEventTarget = React.useMemo(() => () => undefined, []);
    const scrollListenerTarget = enabled && containerEl ? containerEl : noEventTarget;
    const passiveScrollOptions = React.useMemo(() => ({ passive: true } as const), []);
    useEventListener('scroll', handleScrollEvent, scrollListenerTarget, passiveScrollOptions);
    useEventListener('wheel', handleWheel, scrollListenerTarget, passiveScrollOptions);
    useEventListener('touchstart', handleTouchStart, scrollListenerTarget, passiveScrollOptions);
    useEventListener('touchmove', handleTouchMove, scrollListenerTarget, passiveScrollOptions);
    useEventListener('touchend', handleTouchEnd, scrollListenerTarget, passiveScrollOptions);
    useEventListener('touchcancel', handleTouchEnd, scrollListenerTarget, passiveScrollOptions);
    useEventListener('keydown', handleKeyDown, scrollListenerTarget);
    useEventListener(
        'pointerdown',
        handlePointerDownIntent,
        enabled && typeof window !== 'undefined' ? window : noEventTarget,
        true,
    );

    // The heart of the follow behaviour: the content ResizeObserver fires after
    // layout and before paint, so re-pinning to the bottom here is invisible —
    // there is no "jump up then catch up". Observe both the container (composer
    // growth shrinks the viewport) and the inner content (streaming growth).
    const handleContentResize = useEvent(() => {
        // Keyboard open / animating / composer expand: viewport and composer
        // height changes must not re-pin the message list. Keeping scrollTop
        // leaves the main chat stable while the keyboard and input ride up.
        //
        // Read geometry once. Streaming shell/tool growth used to hit
        // canScroll → updateOverflowAndButton → distanceFromBottom as three
        // separate layout reads in the same ResizeObserver callback, which
        // showed up as full-document Layout (dirty hundreds) right next to
        // programmatic ScrollLayer in Performance traces.
        const el = scrollRef.current;
        if (keyboardGeometryFreezeRef.current) {
            updateOverflowAndButton(el ? readScrollGeometry(el) : undefined);
            return;
        }
        if (historyViewportPreservationRef.current) {
            updateOverflowAndButton(el ? readScrollGeometry(el) : undefined);
            return;
        }
        if (!el) {
            updateOverflowAndButton(undefined);
            return;
        }
        const geometry = readScrollGeometry(el);
        if (!canScrollGeometry(geometry)) {
            setStateValue('following');
            updateOverflowAndButton(geometry);
            return;
        }
        updateOverflowAndButton(geometry);
        // Entry-stick window: on first session open, FORCE the bottom on
        // every growth so late async data (task/subagent child rows, code
        // highlight, mermaid) can't strand the viewport mid-history. Force
        // overrides any false `released` from the growth itself; a real user
        // gesture or explicit navigation release clears the window.
        if (entryStickRef.current) {
            const grew = geometry.scrollHeight > entryStickLastHeightRef.current + 1;
            entryStickLastHeightRef.current = geometry.scrollHeight;
            // Already at bottom within tolerance — only refresh the auto marker.
            // A second scrollTop write here races virtualizer measurement and
            // paints as a full-viewport flash (Trace-20260805 shell tool window).
            if (distanceFromBottomOf(geometry) <= AUTO_MATCH_TOLERANCE_PX) {
                markAuto(el);
            } else {
                scrollToBottom(true);
            }
            if (grew) armEntryStickQuiet();
            return;
        }
        // Still following (including idle): re-pin on any content growth so
        // cold history / async measure cannot leave the viewport mid-list.
        // Released users are left alone — their gesture already opted out.
        if (stateRef.current !== 'following') return;
        if (distanceFromBottomOf(geometry) <= AUTO_MATCH_TOLERANCE_PX) {
            markAuto(el);
            return;
        }
        scrollToBottom(false);
    });

    const canObserveResize = typeof ResizeObserver !== 'undefined';
    const resizeContainerTarget = canObserveResize && enabled ? containerEl : null;
    const resizeContentTarget = (
        canObserveResize
        && enabled
        && containerEl
        && containerEl.firstElementChild instanceof Element
    )
        ? containerEl.firstElementChild
        : null;
    useResizeObserver(resizeContainerTarget, handleContentResize);
    useResizeObserver(resizeContentTarget, handleContentResize);

    // ── native keyboard transitions (Capacitor choreography) ────────────────
    // The chat scroller gets NO transforms and NO auto re-pin for keyboard
    // geometry. Transforming the scroller rebuilds WebKit compositing layers
    // on long chats; re-pinning to the bottom on show/hide is the IM anti-pattern
    // (main view jumps while the keyboard rises). Contract:
    //   show / open: freeze geometry-driven chase; keep scrollTop; composer and
    //                shell follow the keyboard on their own paths.
    //   hide / close: keep freeze through the reverse transition, then clear.
    // Streaming / send still pin via notifyContentChange and scrollToBottomOnSend.
    // These events never fire outside the Capacitor app (except intent from
    // composer expand, which only freezes chase).
    const clearExpandFreezeTimer = useEvent(() => {
        if (keyboardExpandFreezeTimerRef.current === null) return;
        clearTimeout(keyboardExpandFreezeTimerRef.current);
        keyboardExpandFreezeTimerRef.current = null;
    });

    const freezeGeometry = useEvent((durationMs?: number) => {
        keyboardGeometryFreezeRef.current = true;
        // Clamp/resize can dispatch scroll events away from the auto marker —
        // never read those as a user scroll-away while the keyboard moves.
        if (typeof durationMs === 'number' && durationMs > 0) {
            animationGuardUntilRef.current = now() + durationMs + ANIMATION_GUARD_MS;
        } else {
            animationGuardUntilRef.current = Math.max(
                animationGuardUntilRef.current,
                now() + ANIMATION_GUARD_MS,
            );
        }
    });

    const handleKeyboardIntent = useEvent((event: Event) => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail;
        if (!detail) return;
        // Expand path: freeze before the pill→full composer DOM swap so the
        // ResizeObserver does not chase the bottom on the first jump. This
        // is provisional — if the IME never opens, drop the freeze so
        // streaming / history growth can re-pin again.
        if (detail.open === true) {
            freezeGeometry();
            clearExpandFreezeTimer();
            keyboardExpandFreezeTimerRef.current = setTimeout(() => {
                keyboardExpandFreezeTimerRef.current = null;
                if (!keyboardOpenRef.current) {
                    keyboardGeometryFreezeRef.current = false;
                }
            }, 1500);
            return;
        }
        // Collapse path still freezes through the hide transition; settled
        // (open:false) clears the freeze when the keyboard is fully gone.
        clearExpandFreezeTimer();
        freezeGeometry();
    });

    const handleKeyboardAnim = useEvent((event: Event) => {
        const detail = (event as CustomEvent<{ phase: 'show' | 'hide'; slide: number; durationMs: number; easing: string }>).detail;
        if (!detail) return;
        clearExpandFreezeTimer();
        freezeGeometry(detail.durationMs);
    });

    const handleKeyboardSettled = useEvent((event: Event) => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail;
        clearExpandFreezeTimer();
        // Keep freeze while the keyboard remains open so residual layout
        // (SystemBars, safe-area, late composer measure) cannot re-pin.
        // Only unfreeze after hide has settled.
        if (detail?.open === true) {
            keyboardOpenRef.current = true;
            keyboardGeometryFreezeRef.current = true;
        } else {
            keyboardOpenRef.current = false;
            // Keep freeze briefly after hide so residual shell/composer
            // ResizeObserver callbacks cannot re-pin when the viewport grows.
            keyboardGeometryFreezeRef.current = true;
            keyboardExpandFreezeTimerRef.current = setTimeout(() => {
                keyboardExpandFreezeTimerRef.current = null;
                if (!keyboardOpenRef.current) {
                    keyboardGeometryFreezeRef.current = false;
                }
            }, ANIMATION_GUARD_MS);
        }
        // Never re-pin on keyboard settle — scrollTop stays where the user
        // left it; overflow UI still needs a refresh for the new viewport.
        updateOverflowAndButton();
    });

    const keyboardListenerTarget = enabled && typeof window !== 'undefined' ? window : noEventTarget;
    useEventListener('oc:keyboard-intent', handleKeyboardIntent, keyboardListenerTarget);
    useEventListener('oc:keyboard-anim', handleKeyboardAnim, keyboardListenerTarget);
    useEventListener('oc:keyboard-settled', handleKeyboardSettled, keyboardListenerTarget);

    React.useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        return () => {
            clearExpandFreezeTimer();
            keyboardGeometryFreezeRef.current = false;
            keyboardOpenRef.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- enabled controls the freeze lifecycle; clearExpandFreezeTimer is useEvent-stable.
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled) return;
        updateOverflowAndButton();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- enabled/sessionMessageCount are the real inputs; updateOverflowAndButton is useEvent-stable.
    }, [enabled, sessionMessageCount]);

    const notifyContentChange = useEvent((reason?: ContentChangeReason) => {
        if (!enabled) return;
        // A tracked height animation (e.g. Thinking auto-collapse) opens a guard
        // window so its transient geometry / async scroll events are not misread
        // as a user scroll-away. Real gestures still release through
        // releaseFromUserIntent, so the user can always scroll up freely.
        if (reason === 'animation') {
            animationGuardUntilRef.current = now() + ANIMATION_GUARD_MS;
        }
        updateOverflowAndButton();
        // Entry-stick window: late structural growth (notably the task/subagent
        // summary landing from the child session — ToolPart emits 'structural'
        // here) must keep us pinned and refresh the quiescence timer, even though
        // the session is idle.
        if (entryStickRef.current) {
            scrollToBottom(true);
            armEntryStickQuiet();
            return;
        }
        if (stateRef.current === 'following') {
            scrollToBottom(false);
        }
    });

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = useEvent((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            if (!enabled) return;
            if (stateRef.current === 'following') {
                scrollToBottom(false);
            }
        };

        const handlers: AnimationHandlers = {
            onChunk: kick,
            onComplete: () => {
                if (!enabled) return;
                updateOverflowAndButton();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: kick,
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };
        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    });

    React.useEffect(() => {
        return () => {
            if (autoTimerRef.current) {
                clearTimeout(autoTimerRef.current);
                autoTimerRef.current = null;
            }
            cancelForcedBottom();
            endEntryStick();
            flushSave();
            if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only; cancelForcedBottom/endEntryStick/flushSave are useEvent-stable.
    }, []);

    // onActiveTurnChange is a call-site callback; keep latest via useEvent so the
    // spy effect rebinds only when the scroller, enablement, or listener presence changes.
    const onActiveTurnChangeEvent = useEvent((turnId: string | null) => {
        onActiveTurnChange?.(turnId);
    });
    const hasActiveTurnListener = Boolean(onActiveTurnChange);

    React.useEffect(() => {
        if (!enabled || !hasActiveTurnListener) return;
        const container = containerEl;
        if (!container) return;

        let lastActiveTurnId: string | null = null;
        const spy = createScrollSpy({
            onActive: (turnId) => {
                if (turnId === lastActiveTurnId) return;
                lastActiveTurnId = turnId;
                onActiveTurnChangeEvent(turnId);
            },
        });
        spy.setContainer(container);

        const elementByTurnId = new Map<string, HTMLElement>();
        const registerTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };
        const unregisterTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            if (elementByTurnId.get(turnId) !== node) return false;
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };
        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) return [];
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) collected.push(node);
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => collected.push(el));
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(registerTurnNode);
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;
            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) changed = true;
                    });
                });
                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) changed = true;
                    });
                });
            });
            if (changed) spy.markDirty();
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const onScroll = () => spy.onScroll();
        container.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', onScroll);
            mutationObserver.disconnect();
            spy.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- container/enabled/listener presence control lifecycle; onActiveTurnChangeEvent is useEvent-stable.
    }, [containerEl, enabled, hasActiveTurnListener]);

    return {
        scrollRef,
        state,
        isPinned: state === 'following',
        isOverflowing,
        isFollowingProgrammatically,
        showScrollButton,
        notifyContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        beginHistoryViewportPreservation,
        endHistoryViewportPreservation,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
