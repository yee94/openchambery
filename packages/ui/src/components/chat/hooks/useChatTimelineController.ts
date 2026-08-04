import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import {
    buildTurnWindowModel,
    updateTurnWindowModelIncremental,
    type TurnWindowModel,
} from '../lib/turns/windowTurns';
import type { TurnHistorySignals } from '../lib/turns/historySignals';
import { getMemoryLimits, type SessionHistoryMeta } from '@/stores/types/sessionTypes';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

type ViewportAnchor = { messageId: string; offsetTop: number };

type PrePrependSnapshot = {
    sessionId: string | null;
    height: number;
    top: number;
    anchor: ViewportAnchor | null;
    oldestId: string | null;
    newestId: string | null;
};

type PendingScrollRequest = {
    sessionId: string;
    kind: 'turn' | 'message';
    id: string;
    behavior: ScrollBehavior;
    turnId: string | null;
    resolve: (value: boolean) => void;
};

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    messages: ChatMessageEntry[];
    historyMeta: SessionHistoryMeta | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    isPinned: boolean;
    showScrollButton: boolean;
    /** Active desktop transcript only (not expanded-input). Mobile stays false. */
    autoFillEnabled?: boolean;
}

export interface UseChatTimelineControllerResult {
    turnIds: string[];
    turnStart: number;
    renderedMessages: ChatMessageEntry[];
    historySignals: TurnHistorySignals;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
    activeTurnId: string | null;
    showScrollToBottom: boolean;
    turnWindowModel: TurnWindowModel;
    loadEarlier: (options?: { userInitiated?: boolean }) => Promise<void>;
    revealBufferedTurns: () => Promise<boolean>;
    resumeToBottom: () => void;
    resumeToBottomInstant: () => Promise<void>;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    handleHistoryScroll: () => void;
    handleHistoryUpwardIntent: () => void;
    captureViewportAnchor: () => ViewportAnchor | null;
    restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
    handleActiveTurnChange: (turnId: string | null) => void;
}

const TURN_MODEL_CACHE_MAX = 30
// Desktop load-older lead distance. Trigger well before the top: the fetch
// then completes and the prepend lands ABOVE the viewport, where key-anchored
// compensation is exact and invisible. A short lead (the old 200px) let the
// user reach the estimated-height region near the absolute top mid-fetch,
// where the post-insert restore is least precise and reads as a small jump.
const HISTORY_SCROLL_THRESHOLD_MIN_PX = 1200
const HISTORY_SCROLL_VIEWPORT_FACTOR = 1.5
const resolveHistoryScrollThreshold = (clientHeight: number): number => Math.max(
    HISTORY_SCROLL_THRESHOLD_MIN_PX,
    clientHeight * HISTORY_SCROLL_VIEWPORT_FACTOR,
)
const VSCODE_TURN_MODEL_CACHE_MAX = 4
const VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
const MOBILE_TURN_MODEL_CACHE_MAX = 4
const MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
const HISTORY_RENDER_WAIT_TIMEOUT_MS = 250
const HISTORY_INTERACTION_GUARD_MS = 2000
// Long smooth scrolls across a big session can take a couple of seconds;
// the pin releases early as soon as the spy reports the target turn.
const SCROLL_PIN_TIMEOUT_MS = 2500
const turnModelCache = new Map<string, { messages: ChatMessageEntry[]; model: TurnWindowModel }>()
const getTurnModelCacheMax = () => {
    if (isVSCodeRuntime()) return VSCODE_TURN_MODEL_CACHE_MAX
    if (isMobileSurfaceRuntime()) return MOBILE_TURN_MODEL_CACHE_MAX
    return TURN_MODEL_CACHE_MAX
}

const shouldCacheTurnModelMessages = (messages: ChatMessageEntry[]): boolean => {
    if (isVSCodeRuntime()) return messages.length <= VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES
    if (isMobileSurfaceRuntime()) return messages.length <= MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES
    return true
}

const rememberTurnModel = (key: string, value: { messages: ChatMessageEntry[]; model: TurnWindowModel }) => {
    turnModelCache.delete(key)
    if (!shouldCacheTurnModelMessages(value.messages)) {
        return
    }
    const max = getTurnModelCacheMax()
    while (turnModelCache.size >= max) {
        const oldest = turnModelCache.keys().next().value
        if (typeof oldest !== 'string') break
        turnModelCache.delete(oldest)
    }
    turnModelCache.set(key, value)
}

export const isOlderHistoryPrependCommit = (input: {
    previousOldestId: string | null;
    previousNewestId: string | null;
    currentOldestId: string | null;
    currentNewestId: string | null;
}): boolean => Boolean(
    input.previousOldestId
    && input.currentOldestId
    && input.currentOldestId !== input.previousOldestId
    && input.previousNewestId
    && input.currentNewestId
    && input.currentNewestId === input.previousNewestId,
);

export const resolveHistoryPrependCompensation = (
    historyVirtualized: boolean,
): {
    owner: 'tanstack-core' | 'controller';
} => historyVirtualized
    ? { owner: 'tanstack-core' }
    : { owner: 'controller' };

export type HistoryLoadSource = 'scroll' | 'upward-intent';

export const shouldLoadEarlierHistory = (input: {
    source: HistoryLoadSource;
    isMobile: boolean;
    isPinned: boolean;
    scrollTop: number;
    clientHeight: number;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
}): boolean => {
    if (input.isMobile) return false;
    if (input.isLoadingOlder || input.pendingRevealWork) return false;
    if (!input.canLoadEarlier) return false;
    // Ordinary scroll must not fight auto-follow while pinned. Explicit
    // upward-intent (wheel/touch/key) may bypass a stale pin so history can
    // load even when scrollTop is already 0 and no scroll event fires.
    if (input.source === 'scroll' && input.isPinned) return false;
    if (input.scrollTop >= resolveHistoryScrollThreshold(input.clientHeight)) return false;
    return true;
};

export type HistoryPageDecision =
    | 'continue'
    | 'stop-visible'
    | 'stop-no-growth'
    | 'stop-exhausted'
    | 'stop-bounded';

// Collapsed turns can absorb a full page without growing scrollHeight. Keep
// paging while message/oldest/limit grew but visible height did not, until
// height grows, history is complete, the page is empty, or the interaction
// hits its page bound.
export const resolveHistoryPageDecision = (input: {
    scrollHeightBefore: number;
    scrollHeightAfter: number;
    messageCountBefore: number;
    messageCountAfter: number;
    oldestIdBefore: string | null;
    oldestIdAfter: string | null;
    limitBefore: number;
    limitAfter: number;
    hasMoreAbove: boolean;
    pagesLoaded: number;
    maxPages: number;
}): HistoryPageDecision => {
    if (input.pagesLoaded >= input.maxPages) return 'stop-bounded';
    if (!input.hasMoreAbove) return 'stop-exhausted';

    const heightGrowth = input.scrollHeightAfter - input.scrollHeightBefore;
    if (heightGrowth > 1) return 'stop-visible';

    const dataGrowth =
        input.messageCountAfter > input.messageCountBefore
        || (
            typeof input.oldestIdBefore === 'string'
            && typeof input.oldestIdAfter === 'string'
            && input.oldestIdBefore !== input.oldestIdAfter
        )
        || input.limitAfter > input.limitBefore;

    if (!dataGrowth) return 'stop-no-growth';
    return 'continue';
};

// One Host 3-turn page per user interaction (single server turn-page request).
const HISTORY_INTERACTION_MAX_PAGES = 1;

/**
 * Auto-fill only on a short first paint: message count must stay at or below
 * this bound so a later trim / reverse load cannot re-trigger fill.
 */
const AUTO_FILL_MAX_FIRST_PAINT_MESSAGES = 38;

/** Short first paint: auto-fill earlier history once while still pinned at bottom. */
export const shouldAutoFillEarlierHistory = (input: {
    enabled: boolean;
    isMobile: boolean;
    sessionReady: boolean;
    messageReady: boolean;
    historyLoading: boolean;
    canLoadEarlier: boolean;
    isPinned: boolean;
    alreadyAttempted: boolean;
    scrollHeight: number;
    clientHeight: number;
    pendingRevealWork: boolean;
    isLoadingOlder: boolean;
    hasMessages: boolean;
    /** First-paint message count; auto-fill only when <= 38. */
    messageCount: number;
}): boolean => {
    if (!input.enabled) return false;
    if (input.isMobile) return false;
    if (!input.sessionReady || !input.messageReady) return false;
    if (input.historyLoading) return false;
    if (!input.canLoadEarlier) return false;
    if (!input.isPinned) return false;
    if (input.alreadyAttempted) return false;
    if (input.pendingRevealWork || input.isLoadingOlder) return false;
    if (!input.hasMessages) return false;
    // Avoid auto-fill after the first paint has already grown past the short
    // window (e.g. after trim reverse-loading would otherwise re-arm fill).
    if (input.messageCount > AUTO_FILL_MAX_FIRST_PAINT_MESSAGES) return false;
    if (input.scrollHeight > input.clientHeight + 48) return false;
    return true;
};

/** Multi-frame anchor hold only when virtualized geometry actually grew. */
export const shouldHoldHistoryViewportAnchor = (input: {
    historyVirtualized: boolean;
    anchorRestored: boolean;
    heightDelta: number;
    messages: readonly unknown[];
    heldForMessages: readonly unknown[] | null;
}): boolean => {
    if (!input.historyVirtualized) return false;
    if (!input.anchorRestored) return false;
    if (input.heightDelta <= 1) return false;
    if (input.heldForMessages === input.messages) return false;
    return true;
};

// iOS WKWebView ignores programmatic scrollTop writes while a touch drag or
// momentum (fling) scroll is active: the native scroll animation keeps running
// and overwrites the value on the next frame. The mobile history threshold is
// large enough that the prepend commit almost always lands mid-fling, so a
// plain `container.scrollTop = target` never sticks. Toggling overflow kills
// the native scroll synchronously (pre-paint, invisible inside a layout
// effect); a short post-paint watchdog re-asserts the target if residual
// momentum still drags the viewport upward.
const MOMENTUM_WATCHDOG_FRAMES = 20;
const MOMENTUM_WATCHDOG_TOLERANCE_PX = 4;

const setScrollTopDefeatingMomentum = (container: HTMLElement, target: number) => {
    const previousOverflow = container.style.overflow;
    container.style.overflow = 'hidden';
    container.scrollTop = target;
    void container.scrollHeight;
    container.style.overflow = previousOverflow;
    container.scrollTop = target;

    if (typeof window === 'undefined') return;
    let cancelled = false;
    let frames = 0;
    const cancelOnUserTouch = () => {
        cancelled = true;
    };
    container.addEventListener('touchstart', cancelOnUserTouch, { passive: true, once: true });
    const watch = () => {
        if (cancelled) return;
        // Only correct upward drift (residual momentum). Downward movement or
        // content growth above the viewport must not be fought here.
        if (container.scrollTop < target - MOMENTUM_WATCHDOG_TOLERANCE_PX) {
            container.scrollTop = target;
        }
        frames += 1;
        if (frames < MOMENTUM_WATCHDOG_FRAMES) {
            window.requestAnimationFrame(watch);
        } else {
            container.removeEventListener('touchstart', cancelOnUserTouch);
        }
    };
    window.requestAnimationFrame(watch);
};

const hasInsertedBeforeKnownOldest = (
    previousOldestId: string | null,
    currentOldestId: string | null,
    messages: ChatMessageEntry[],
): boolean => {
    if (!previousOldestId || !currentOldestId || currentOldestId === previousOldestId) {
        return false;
    }

    return messages.some((message) => message.info.id === previousOldestId);
};

export const useChatTimelineController = ({
    sessionId,
    messages,
    historyMeta,
    scrollRef,
    messageListRef,
    loadMoreMessages,
    goToBottom,
    releaseAutoFollow,
    isPinned,
    showScrollButton,
    autoFillEnabled = false,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
    const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const turnWindowModel = React.useMemo(() => {
        const key = sessionId ?? ""
        const cached = key ? turnModelCache.get(key) : undefined
        if (cached && cached.messages === messages) {
            rememberTurnModel(key, cached)
            previousTurnWindowModelRef.current = cached.model
            previousMessagesRef.current = messages
            return cached.model
        }

        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;

        if (key && messages.length > 0) {
            rememberTurnModel(key, { messages, model: nextModel })
        }

        return nextModel;
    }, [messages, sessionId]);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const initializedSessionRef = React.useRef<string | null>(null);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const scrollPinRef = React.useRef<{ turnId: string; expiresAt: number } | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);
    // One auto-fill attempt per session: written before the fetch so a failed
    // page does not storm retries (sync failure state remains authoritative).
    const autoFillAttemptedSessionsRef = React.useRef<Set<string>>(new Set());

    const historySignals = React.useMemo(() => {
        const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
        const hasBufferedTurns = false;
        const hasMoreAboveTurns = historyMeta
            ? !historyMeta.complete
            : messages.length >= defaultLimit;
        const historyLoading = Boolean(historyMeta?.loading);
        return {
            hasBufferedTurns,
            hasMoreAboveTurns,
            historyLoading,
            canLoadEarlier: hasMoreAboveTurns,
        };
    }, [historyMeta, messages.length]);

    const historySignalsRef = React.useRef(historySignals);

    turnModelRef.current = turnWindowModel;
    isPinnedRef.current = isPinned;
    // isLoadingOlderRef is armed/cleared synchronously inside fetchOlderHistory
    // (and session reset) so concurrent gestures cannot race React state.
    pendingRevealWorkRef.current = pendingRevealWork;
    historySignalsRef.current = historySignals;
    sessionIdRef.current = sessionId;
    messagesRef.current = messages;
    historyMetaRef.current = historyMeta;

    const beginHistoryInteraction = React.useCallback(() => {
        historyInteractionRef.current = true;
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
    }, []);

    const settleHistoryInteraction = React.useCallback(() => {
        if (typeof window === 'undefined') {
            historyInteractionRef.current = false;
            return;
        }

        if (historyInteractionTimerRef.current !== null) {
            window.clearTimeout(historyInteractionTimerRef.current);
        }
        historyInteractionTimerRef.current = window.setTimeout(() => {
            historyInteractionTimerRef.current = null;
            historyInteractionRef.current = false;
        }, HISTORY_INTERACTION_GUARD_MS);
    }, []);

    React.useLayoutEffect(() => {
        if (initializedSessionRef.current === sessionId) {
            return;
        }
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        historyInteractionRef.current = false;
        initializedSessionRef.current = sessionId;
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        scrollPinRef.current = null;
        setActiveTurnId(null);
    }, [sessionId]);

    const resolvePendingRenderWaiters = React.useCallback(() => {
        const resolvers = pendingRenderResolversRef.current;
        if (resolvers.length === 0) {
            return;
        }
        pendingRenderResolversRef.current = [];
        resolvers.forEach((resolve) => resolve());
    }, []);

    const waitForNextRenderCommitOrTimeout = React.useCallback((): Promise<void> => {
        return new Promise<void>((resolve) => {
            if (typeof window === 'undefined') {
                resolve();
                return;
            }

            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve();
            };
            pendingRenderResolversRef.current.push(finish);
            const timer = window.setTimeout(finish, HISTORY_RENDER_WAIT_TIMEOUT_MS);
        });
    }, []);

    const resolvePendingScrollRequest = React.useCallback((value: boolean) => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }
        pendingScrollRequestRef.current = null;
        pending.resolve(value);
    }, []);

    const attemptPendingScrollRequest = React.useCallback(() => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }

        if (pending.sessionId !== sessionIdRef.current) {
            resolvePendingScrollRequest(false);
            return;
        }

        const didScroll = pending.kind === 'turn'
            ? (messageListRef.current?.scrollToTurnId(pending.id, { behavior: pending.behavior }) ?? false)
            : (messageListRef.current?.scrollToMessageId(pending.id, { behavior: pending.behavior }) ?? false);

        if (didScroll) {
            if (pending.turnId) {
                // Pin the indicator to the target so the scroll spy's
                // intermediate reports during the smooth scroll don't drag
                // it backwards before the animation lands.
                scrollPinRef.current = {
                    turnId: pending.turnId,
                    expiresAt: Date.now() + SCROLL_PIN_TIMEOUT_MS,
                };
                setActiveTurnId(pending.turnId);
            }
            resolvePendingScrollRequest(true);
            return;
        }

        const targetIndex = pending.kind === 'turn'
            ? turnModelRef.current.turnIndexById.get(pending.id)
            : turnModelRef.current.messageToTurnIndex.get(pending.id);

        if (typeof targetIndex === 'number') {
            resolvePendingScrollRequest(false);
        }
    }, [messageListRef, resolvePendingScrollRequest]);

    React.useEffect(() => {
        return () => {
            if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(historyInteractionTimerRef.current);
                historyInteractionTimerRef.current = null;
            }
            resolvePendingRenderWaiters();
            resolvePendingScrollRequest(false);
        };
    }, [resolvePendingRenderWaiters, resolvePendingScrollRequest]);

    const renderedMessages = messages;

    React.useLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory stores a snapshot here before triggering the fetch and
    // keeps it armed for the whole load. useLayoutEffect re-asserts it after
    // every commit React makes in between — before the browser paints.
    const prePrependScrollRef = React.useRef<PrePrependSnapshot | null>(null);
    // The snapshot whose anchor already has a post-commit hold running, so a
    // settling virtualized list gets one hold per page instead of one per
    // render.
    const heldAnchorMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    // Tracks the timeline edges + height of the previous commit so a prepend
    // that did NOT go through fetchOlderHistory (e.g. the background history
    // prepend dispatched from useSync) can be compensated too. With
    // overflow-anchor:none the browser leaves scrollTop unchanged when content
    // is inserted above, so without this the viewport visibly jumps and
    // auto-follow yanks it back on the next frame — a one-shot up/down judder.
    const prependTrackingRef = React.useRef<{
        oldestId: string | null;
        newestId: string | null;
        scrollHeight: number;
    } | null>(null);

    React.useLayoutEffect(() => {
        prePrependScrollRef.current = null;
        prependTrackingRef.current = null;
        heldAnchorMessagesRef.current = null;
        messageListRef.current?.cancelViewportAnchorHold();
    }, [messageListRef, sessionId]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let snap = prePrependScrollRef.current;
        const prev = prependTrackingRef.current;
        const currentOldestId = renderedMessages[0]?.info?.id ?? null;
        const currentNewestId = renderedMessages[renderedMessages.length - 1]?.info?.id ?? null;
        // A prepend = content inserted ABOVE the viewport: either the newest
        // stayed fixed, or the old first message still exists below a new first
        // message. The latter keeps preservation alive if a tail append lands in
        // the same commit as the history page.
        const isPrepend = prev
            ? isOlderHistoryPrependCommit({
                previousOldestId: prev.oldestId,
                previousNewestId: prev.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(prev.oldestId, currentOldestId, renderedMessages)
            : false;

        if (snap && snap.sessionId !== sessionIdRef.current) {
            prePrependScrollRef.current = null;
            snap = null;
        }

        const isSnapshotPrepend = snap
            ? isOlderHistoryPrependCommit({
                previousOldestId: snap.oldestId,
                previousNewestId: snap.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(snap.oldestId, currentOldestId, renderedMessages)
            : false;
        const didPrepend = isPrepend || isSnapshotPrepend;

        const updateTracking = () => {
            prependTrackingRef.current = {
                oldestId: currentOldestId,
                newestId: currentNewestId,
                scrollHeight: container.scrollHeight,
            };
        };

        if (isPinnedRef.current) {
            // Bottom-pinned. Only content inserted ABOVE (a prepend / history load)
            // needs an explicit re-pin: with overflow-anchor:none the browser leaves
            // scrollTop unchanged, so the viewport would visibly jump. Route that
            // through goToBottom — the single programmatic writer.
            //
            // A normal bottom APPEND (a sent message, a streaming part) must NOT
            // re-pin here. Auto-follow already owns the bottom: its content
            // ResizeObserver re-pins instantly (scrollTop = scrollHeight, before
            // paint) on every append. Re-pinning again from here would just be a
            // second writer chasing the same target a frame later — redundant at
            // best, and the source of the old up/down jiggle on send / from the
            // queue / while streaming. So for an append we do nothing and let
            // auto-follow own it.
            if (didPrepend) {
                prePrependScrollRef.current = null;
                goToBottom('instant');
            }
            updateTracking();
            return;
        }

        const historyVirtualized = messageListRef.current?.isHistoryVirtualized() ?? false;

        // A history load owns the read position for its whole duration, so the
        // armed snapshot is re-asserted on EVERY commit it produces: the
        // loading row, the page itself, and any virtualizer remeasure after it.
        // Restoration is absolute — it measures where the anchor message sits
        // now and corrects the residual — so repeating it cannot
        // double-compensate, and it stays exact even when the virtualizer
        // already moved the offset itself.
        //
        // Edge-id heuristics are blind to most of these commits. A multi-step
        // assistant turn spans pages, so an older page routinely carries only
        // more rows for the turn that is already on screen: they land BELOW the
        // current first message and leave both timeline edges untouched. That
        // is content added above the viewport all the same, and TanStack cannot
        // see it either (neither the item count nor the first/last item key
        // changes, so its key anchoring never runs).
        if (snap) {
            const heightDelta = container.scrollHeight - snap.height;

            // iOS overwrites plain scrollTop writes while a fling runs, so
            // mobile keeps the momentum-defeating writer and its height delta.
            if (isMobileSurfaceRuntime()) {
                if (heightDelta > 0) {
                    setScrollTopDefeatingMomentum(container, snap.top + heightDelta);
                }
                updateTracking();
                return;
            }

            const anchor = snap.anchor;
            const restoredAnchor = Boolean(anchor && restoreViewportAnchor(anchor));
            if (!restoredAnchor) {
                if (heightDelta > 0) {
                    container.scrollTop = snap.top + heightDelta;
                }
            } else if (
                anchor
                && shouldHoldHistoryViewportAnchor({
                    historyVirtualized,
                    anchorRestored: restoredAnchor,
                    heightDelta,
                    messages: renderedMessages,
                    heldForMessages: heldAnchorMessagesRef.current,
                })
            ) {
                // Virtualized rows measure in over the frames that follow the
                // commit, each one moving geometry above the viewport. Hold the
                // anchor until that settles; the hold releases itself on the
                // user's next gesture. Collapsed pages that restore without
                // real height growth skip the hold.
                heldAnchorMessagesRef.current = renderedMessages;
                messageListRef.current?.holdViewportAnchor(anchor);
            }
            updateTracking();
            return;
        }

        // Background prepends (a history page dispatched from useSync rather
        // than from loadEarlier) arrive without a snapshot. TanStack core owns
        // those when virtualized: stable keys preserve the visible item and
        // core batches iOS momentum writes with later measurements.
        if (isPrepend && prev && resolveHistoryPrependCompensation(historyVirtualized).owner === 'controller') {
            // Released viewport: preserve the read position by compensating for the
            // exact height the non-virtualized prepend added above, with no
            // intermediate frame for auto-follow to fight.
            const delta = container.scrollHeight - prev.scrollHeight;
            if (delta > 0) {
                const target = container.scrollTop + delta;
                if (isMobileSurfaceRuntime()) {
                    setScrollTopDefeatingMomentum(container, target);
                } else {
                    container.scrollTop = target;
                }
            }
        }

        updateTracking();
    }, [messageListRef, renderedMessages, scrollRef, restoreViewportAnchor, goToBottom]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => false, []);

        const fetchOlderHistory = React.useCallback(async (input: {
        preserveViewport: boolean;
    }): Promise<boolean> => {
        if (!sessionIdRef.current || isLoadingOlderRef.current) {
            return false;
        }
        if (historySignalsRef.current.historyLoading) {
            return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
            return false;
        }

        const container = scrollRef.current;
        const beforeMessages = messagesRef.current;
        const beforeMessageCount = beforeMessages.length;
        const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;
        const beforeLimit = historyMetaRef.current?.limit ?? getMemoryLimits().HISTORICAL_MESSAGES;

        // Store scroll snapshot BEFORE the fetch so useLayoutEffect can
        // compensate synchronously when React commits the new messages.
        let armedSnapshot: PrePrependSnapshot | null = null;
        if (input.preserveViewport && container) {
            armedSnapshot = {
                sessionId: sessionIdRef.current,
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
                oldestId: beforeOldestMessageId,
                newestId: beforeMessages[beforeMessages.length - 1]?.info?.id ?? null,
            };
            prePrependScrollRef.current = armedSnapshot;
        }

        // Cancel the multi-frame hold only while this interaction still owns
        // the armed snapshot. A superseded owner must not cancel another hold.
        const releaseSnapshot = () => {
            if (!(armedSnapshot && prePrependScrollRef.current === armedSnapshot)) {
                return;
            }
            prePrependScrollRef.current = null;
            messageListRef.current?.cancelViewportAnchorHold();
        };

        // Arm the re-entry guard synchronously so a burst of wheel events
        // cannot start concurrent pagination chains before React state flips.
        isLoadingOlderRef.current = true;
        beginHistoryInteraction();
        setIsLoadingOlder(true);

        try {
            const targetSessionId = sessionIdRef.current;
            if (!targetSessionId) {
                releaseSnapshot();
                return false;
            }

            let loadedMessageCount = beforeMessageCount;
            let loadedOldestMessageId = beforeOldestMessageId;
            let loadedLimit = beforeLimit;
            let pagesLoaded = 0;

            while (true) {
                // Do not start another Host turn-page while sync still marks
                // history loading (in-flight prepend / meta.loading).
                if (historySignalsRef.current.historyLoading) {
                    releaseSnapshot();
                    return false;
                }

                // Capture height before each page so collapsed turns that
                // absorb rows without growing the document can keep paging.
                const scrollHeightBefore = scrollRef.current?.scrollHeight ?? 0;
                const messageCountBefore = loadedMessageCount;
                const oldestIdBefore = loadedOldestMessageId;
                const limitBefore = loadedLimit;

                await loadMoreMessages(targetSessionId, 'up');
                pagesLoaded += 1;
                if (sessionIdRef.current !== targetSessionId) {
                    releaseSnapshot();
                    return false;
                }

                await waitForNextRenderCommitOrTimeout();

                const afterMessages = messagesRef.current;
                const afterMessageCount = afterMessages.length;
                const afterOldestMessageId = afterMessages[0]?.info?.id ?? null;
                const afterLimit = historyMetaRef.current?.limit ?? loadedLimit;
                const scrollHeightAfter = scrollRef.current?.scrollHeight ?? scrollHeightBefore;
                const decision = resolveHistoryPageDecision({
                    scrollHeightBefore,
                    scrollHeightAfter,
                    messageCountBefore,
                    messageCountAfter: afterMessageCount,
                    oldestIdBefore,
                    oldestIdAfter: afterOldestMessageId,
                    limitBefore,
                    limitAfter: afterLimit,
                    hasMoreAbove: historySignalsRef.current.hasMoreAboveTurns,
                    pagesLoaded,
                    maxPages: HISTORY_INTERACTION_MAX_PAGES,
                });

                if (decision === 'continue') {
                    loadedMessageCount = afterMessageCount;
                    loadedOldestMessageId = afterOldestMessageId;
                    loadedLimit = afterLimit;
                    continue;
                }
                if (decision === 'stop-no-growth') {
                    releaseSnapshot();
                    return false;
                }
                return true;
            }
        } catch (error) {
            releaseSnapshot();
            throw error;
        } finally {
            isLoadingOlderRef.current = false;
            setIsLoadingOlder(false);
            settleHistoryInteraction();
            // Removing the loading row is itself a geometry change above the
            // viewport, so the anchor stays armed until that commit has been
            // compensated. Releasing it afterwards keeps ordinary commits
            // (streaming, live events) free of a stale read position.
            void waitForNextRenderCommitOrTimeout().then(releaseSnapshot);
        }
    }, [beginHistoryInteraction, captureViewportAnchor, loadMoreMessages, messageListRef, scrollRef, settleHistoryInteraction, waitForNextRenderCommitOrTimeout]);

    const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
        beginHistoryInteraction();
        if (options?.userInitiated) {
            releaseAutoFollow();
        }

        try {
            void (await fetchOlderHistory({ preserveViewport: true }));
        } finally {
            settleHistoryInteraction();
        }
    }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, settleHistoryInteraction]);

    // Short first paint (collapsed history shorter than the viewport): fill
    // earlier pages once while auto-follow stays pinned. Paint-after effect so
    // layout has settled; never userInitiated/release so pin is preserved.
    React.useEffect(() => {
        const targetSessionId = sessionId;
        if (!targetSessionId) return;

        const container = scrollRef.current;
        const alreadyAttempted = autoFillAttemptedSessionsRef.current.has(targetSessionId);
        if (!shouldAutoFillEarlierHistory({
            enabled: autoFillEnabled,
            isMobile: isMobileSurfaceRuntime(),
            sessionReady: Boolean(targetSessionId),
            messageReady: messages.length > 0 || Boolean(historyMeta),
            historyLoading: historySignals.historyLoading,
            canLoadEarlier: historySignals.canLoadEarlier,
            isPinned,
            alreadyAttempted,
            scrollHeight: container?.scrollHeight ?? 0,
            clientHeight: container?.clientHeight ?? 0,
            pendingRevealWork,
            isLoadingOlder,
            hasMessages: messages.length > 0,
            messageCount: messages.length,
        })) {
            return;
        }

        // Guard before the fetch so a failed page cannot storm retries.
        autoFillAttemptedSessionsRef.current.add(targetSessionId);
        void fetchOlderHistory({ preserveViewport: true }).catch(() => {
            // Sync failure state already owns the error; only prevent unhandled rejection.
        });
    }, [
        autoFillEnabled,
        fetchOlderHistory,
        historyMeta,
        historySignals.canLoadEarlier,
        historySignals.historyLoading,
        isLoadingOlder,
        isPinned,
        messages.length,
        pendingRevealWork,
        scrollRef,
        sessionId,
    ]);

    const decideAndLoadEarlier = React.useCallback((source: HistoryLoadSource) => {
        // Mobile never loads history from scroll/gesture position: any prepend
        // racing an active touch gesture can be hijacked by the native scroll
        // animation. The user scrolls to the natural top and taps an explicit
        // "load older" button instead — the insert then happens from a resting
        // state, which is fully deterministic.
        const container = scrollRef.current;
        if (!container) return;
        if (!shouldLoadEarlierHistory({
            source,
            isMobile: isMobileSurfaceRuntime(),
            isPinned: isPinnedRef.current,
            scrollTop: container.scrollTop,
            clientHeight: container.clientHeight,
            canLoadEarlier: historySignalsRef.current.canLoadEarlier,
            isLoadingOlder: isLoadingOlderRef.current,
            pendingRevealWork: pendingRevealWorkRef.current,
        })) {
            return;
        }

        void loadEarlier({ userInitiated: true });
    }, [loadEarlier, scrollRef]);

    const handleHistoryScroll = React.useCallback(() => {
        decideAndLoadEarlier('scroll');
    }, [decideAndLoadEarlier]);

    // Explicit upward intent (wheel/touch/key) can fire when scrollTop is already
    // 0, so no scroll event would run. Same decision helper; only the pin gate
    // differs from ordinary scroll.
    const handleHistoryUpwardIntent = React.useCallback(() => {
        decideAndLoadEarlier('upward-intent');
    }, [decideAndLoadEarlier]);

    const scrollToTurn = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!turnId || !sessionIdRef.current) {
            return false;
        }

        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (sessionIdRef.current !== sessionId) {
                return false;
            }

            const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    sessionId: sessionIdRef.current ?? sessionId ?? '',
                    kind: 'turn',
                    id: turnId,
                    behavior: options?.behavior ?? 'auto',
                    turnId,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, sessionId]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!messageId || !sessionIdRef.current) {
            return false;
        }

        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (sessionIdRef.current !== sessionId) {
                return false;
            }

            const turnId = turnModelRef.current.messageToTurnId.get(messageId);
            const turnIndex = turnModelRef.current.messageToTurnIndex.get(messageId);

            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    sessionId: sessionIdRef.current ?? sessionId ?? '',
                    kind: 'message',
                    id: messageId,
                    behavior: options?.behavior ?? 'auto',
                    turnId: turnId ?? null,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, sessionId]);

    const resumeToBottom = React.useCallback(async () => {
        setPendingRevealWork(false);
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        goToBottom('smooth');
    }, [goToBottom]);

    const resumeToBottomInstant = React.useCallback(async () => {
        setPendingRevealWork(false);
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        goToBottom('instant');
    }, [goToBottom]);

    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        const pin = scrollPinRef.current;
        if (pin) {
            if (turnId !== pin.turnId && Date.now() < pin.expiresAt) {
                return;
            }
            scrollPinRef.current = null;
        }
        setActiveTurnId(turnId);
    }, []);

    return {
        turnIds: turnWindowModel.turnIds,
        turnStart: 0,
        renderedMessages,
        historySignals,
        isLoadingOlder,
        pendingRevealWork,
        activeTurnId,
        showScrollToBottom: showScrollButton && !pendingRevealWork,
        turnWindowModel,
        loadEarlier,
        revealBufferedTurns,
        resumeToBottom,
        resumeToBottomInstant,
        scrollToTurn,
        scrollToMessage,
        handleHistoryScroll,
        handleHistoryUpwardIntent,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
