import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEvent, useIsomorphicLayoutEffect, useUnmount } from '@reactuses/core';

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
import { getRuntimeKey } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

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
/** Wait for an in-flight sync page (historyLoading) before user-initiated load-more gives up. */
const HISTORY_LOADING_WAIT_MS = 4_000
const HISTORY_LOADING_POLL_MS = 40
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
 * Short first paint / collapsed transcript that does not fill the viewport:
 * keep loading earlier Host turn pages while still pinned at bottom.
 *
 * Height is the only geometry gate. Collapsed activity can leave many messages
 * on screen without overflow; a message-count ceiling would stop fill early and
 * force users to expand a turn before scroll/load-more can run.
 *
 * `fillBlocked` is set only after a no-growth or failed page so a single failed
 * attempt cannot storm retries, while a successful short page can re-arm.
 */
export const shouldAutoFillEarlierHistory = (input: {
    enabled: boolean;
    isMobile: boolean;
    sessionReady: boolean;
    messageReady: boolean;
    historyLoading: boolean;
    canLoadEarlier: boolean;
    isPinned: boolean;
    /** True after a no-growth/failed fill for this session; cleared on session change. */
    fillBlocked: boolean;
    scrollHeight: number;
    clientHeight: number;
    pendingRevealWork: boolean;
    isLoadingOlder: boolean;
    hasMessages: boolean;
}): boolean => {
    if (!input.enabled) return false;
    if (input.isMobile) return false;
    if (!input.sessionReady || !input.messageReady) return false;
    if (input.historyLoading) return false;
    if (!input.canLoadEarlier) return false;
    if (!input.isPinned) return false;
    if (input.fillBlocked) return false;
    if (input.pendingRevealWork || input.isLoadingOlder) return false;
    if (!input.hasMessages) return false;
    // Container not measured yet — do not fire a fill against 0×0 geometry.
    if (input.clientHeight <= 0) return false;
    if (input.scrollHeight > input.clientHeight + 48) return false;
    return true;
};

/** Query key for short-viewport auto-fill; changes when the timeline edge moves. */
export const chatTimelineAutoFillQueryKey = (input: {
    runtimeKey: string;
    sessionId: string;
    oldestMessageId: string | null;
    messageCount: number;
    canLoadEarlier: boolean;
}) => [
    'chat-timeline-auto-fill',
    input.runtimeKey,
    input.sessionId,
    input.oldestMessageId,
    input.messageCount,
    input.canLoadEarlier,
] as const;

/** Mutation key for explicit load-earlier (mobile button / desktop scroll intent). */
export const chatTimelineLoadEarlierMutationKey = (input: {
    runtimeKey: string;
    sessionId: string;
}) => [
    'chat-timeline-load-earlier',
    input.runtimeKey,
    input.sessionId,
] as const;

/**
 * Multi-frame viewport hold after history restore.
 *
 * Always false: virtualized history leaves scroll to TanStack end-anchor
 * (`anchorTo: 'end'` + measure/resize compensation). A post-commit hold that
 * also writes `scrollTop` while `resizeItem` → `applyScrollAdjustment` runs
 * was a second writer and produced large load-more jumps (trace CLS ~0.5+ /
 * multi-thousand-px swaps with no user input). Non-virtual lists never needed
 * the hold (one-shot heightDelta / anchor restore is enough).
 */
export const shouldHoldHistoryViewportAnchor = (_input: {
    historyVirtualized: boolean;
    anchorRestored: boolean;
    heightDelta: number;
    messages: readonly unknown[];
    heldForMessages: readonly unknown[] | null;
}): boolean => false;

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
    // Per-session short-viewport auto-fill block after no-growth / hard failure.
    const [autoFillBlocked, setAutoFillBlocked] = React.useState(false);
    // Layout metrics for auto-fill enablement (updated after commit, not guessed).
    const [viewportMetrics, setViewportMetrics] = React.useState({ scrollHeight: 0, clientHeight: 0 });

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const scrollPinRef = React.useRef<{ turnId: string; expiresAt: number } | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);

    // Session switch: adjust state during render (React-supported prop-driven reset)
    // so we never race a layout effect against the first paint of the new session.
    const [trackedSessionId, setTrackedSessionId] = React.useState(sessionId);
    if (trackedSessionId !== sessionId) {
        setTrackedSessionId(sessionId);
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        historyInteractionRef.current = false;
        isLoadingOlderRef.current = false;
        scrollPinRef.current = null;
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        setActiveTurnId(null);
        setAutoFillBlocked(false);
        setViewportMetrics({ scrollHeight: 0, clientHeight: 0 });
    }

    const historySignals = React.useMemo(() => {
        const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
        const hasBufferedTurns = false;
        // Prefer explicit canLoadEarlier (cursor-backed). Fall back to !complete
        // only for legacy meta without the field; never invent has-more from
        // message count alone when meta says complete.
        const hasMoreAboveTurns = historyMeta
            ? (typeof historyMeta.canLoadEarlier === 'boolean'
                ? historyMeta.canLoadEarlier
                : !historyMeta.complete)
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

    const beginHistoryInteraction = useEvent(() => {
        historyInteractionRef.current = true;
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
    });

    const settleHistoryInteraction = useEvent(() => {
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
    });

    const resolvePendingRenderWaiters = useEvent(() => {
        const resolvers = pendingRenderResolversRef.current;
        if (resolvers.length === 0) {
            return;
        }
        pendingRenderResolversRef.current = [];
        resolvers.forEach((resolve) => resolve());
    });

    const waitForNextRenderCommitOrTimeout = useEvent((): Promise<void> => {
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
    });

    const resolvePendingScrollRequest = useEvent((value: boolean) => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }
        pendingScrollRequestRef.current = null;
        pending.resolve(value);
    });

    const attemptPendingScrollRequest = useEvent(() => {
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
    });

    useUnmount(() => {
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        resolvePendingRenderWaiters();
        resolvePendingScrollRequest(false);
    });

    const renderedMessages = messages;

    useIsomorphicLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [renderedMessages]);

    // Publish scroll geometry after commit for Query-driven auto-fill enablement.
    useIsomorphicLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) {
            setViewportMetrics({ scrollHeight: 0, clientHeight: 0 });
            return;
        }
        setViewportMetrics({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        });
    }, [messages, sessionId, isLoadingOlder, scrollRef]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory stores a snapshot here before triggering the fetch and
    // keeps it armed for the whole load. Layout effect re-asserts it after
    // every commit React makes in between — before the browser paints.
    // (DOM geometry sync is intentionally layout-phase, not Query/useEffect.)
    const prePrependScrollRef = React.useRef<PrePrependSnapshot | null>(null);

    const captureViewportAnchor = useEvent((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    });

    const restoreViewportAnchor = useEvent((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    });

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

    useIsomorphicLayoutEffect(() => {
        prePrependScrollRef.current = null;
        prependTrackingRef.current = null;
        messageListRef.current?.cancelViewportAnchorHold();
    }, [sessionId]);

    useIsomorphicLayoutEffect(() => {
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
        const prependCompensation = resolveHistoryPrependCompensation(historyVirtualized);

        // Armed snapshot from loadEarlier / auto-fill. Virtualized lists must
        // not re-assert scroll here: TanStack `anchorTo: 'end'` already
        // preserves the keyed viewport on prepend and compensates first
        // measure / remeasure. A second writer (heightDelta, restoreViewportAnchor,
        // multi-frame hold) raced applyScrollAdjustment and pulled the user
        // off their read position after load-more.
        if (snap) {
            if (prependCompensation.owner === 'tanstack-core') {
                // Drop any hold that an older code path may have left running.
                messageListRef.current?.cancelViewportAnchorHold();
                updateTracking();
                return;
            }

            const heightDelta = container.scrollHeight - snap.height;

            // iOS overwrites plain scrollTop writes while a fling runs, so
            // mobile keeps the momentum-defeating writer and its height delta.
            // Non-virtual only (virtual branch returned above).
            if (isMobileSurfaceRuntime()) {
                if (heightDelta > 0) {
                    setScrollTopDefeatingMomentum(container, snap.top + heightDelta);
                }
                updateTracking();
                return;
            }

            // Non-virtual desktop: one-shot absolute restore (or height delta
            // when the anchor node is not mounted yet). No multi-frame hold —
            // see shouldHoldHistoryViewportAnchor.
            const anchor = snap.anchor;
            const restoredAnchor = Boolean(anchor && restoreViewportAnchor(anchor));
            if (!restoredAnchor && heightDelta > 0) {
                container.scrollTop = snap.top + heightDelta;
            }
            updateTracking();
            return;
        }

        // Background prepends (a history page dispatched from useSync rather
        // than from loadEarlier) arrive without a snapshot. TanStack core owns
        // those when virtualized: stable keys preserve the visible item and
        // core batches iOS momentum writes with later measurements.
        if (isPrepend && prev && prependCompensation.owner === 'controller') {
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
    }, [renderedMessages, goToBottom]);

    const revealBufferedTurns = useEvent(async (): Promise<boolean> => false);

    const waitWhileHistoryLoading = useEvent(async (targetSessionId: string): Promise<boolean> => {
        const deadline = Date.now() + HISTORY_LOADING_WAIT_MS;
        while (historySignalsRef.current.historyLoading) {
            if (sessionIdRef.current !== targetSessionId) return false;
            if (Date.now() >= deadline) return false;
            await new Promise<void>((resolve) => {
                if (typeof window === 'undefined') {
                    resolve();
                    return;
                }
                window.setTimeout(resolve, HISTORY_LOADING_POLL_MS);
            });
        }
        return sessionIdRef.current === targetSessionId;
    });

    const fetchOlderHistory = useEvent(async (input: {
        preserveViewport: boolean;
        /** When true, wait out a concurrent sync page instead of silent no-op. */
        userInitiated?: boolean;
    }): Promise<boolean> => {
        if (!sessionIdRef.current || isLoadingOlderRef.current) {
            return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
            return false;
        }

        // Arm the re-entry guard synchronously so a burst of wheel events /
        // double-taps cannot start concurrent pagination chains.
        isLoadingOlderRef.current = true;
        beginHistoryInteraction();
        setIsLoadingOlder(true);

        const targetSessionId = sessionIdRef.current;
        let armedSnapshot: PrePrependSnapshot | null = null;
        const releaseSnapshot = () => {
            if (!(armedSnapshot && prePrependScrollRef.current === armedSnapshot)) {
                return;
            }
            prePrependScrollRef.current = null;
            messageListRef.current?.cancelViewportAnchorHold();
        };

        try {
            // Background materialize/tail pulls flip historyLoading without
            // disabling the mobile button. User taps must wait for that flight
            // instead of returning false with no feedback (intermittent no-op).
            if (historySignalsRef.current.historyLoading) {
                if (!input.userInitiated) {
                    return false;
                }
                const cleared = await waitWhileHistoryLoading(targetSessionId);
                if (!cleared || !historySignalsRef.current.hasMoreAboveTurns) {
                    return false;
                }
            }

            if (!sessionIdRef.current || sessionIdRef.current !== targetSessionId) {
                return false;
            }

            const container = scrollRef.current;
            const beforeMessages = messagesRef.current;
            const beforeMessageCount = beforeMessages.length;
            const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;
            const beforeLimit = historyMetaRef.current?.limit ?? getMemoryLimits().HISTORICAL_MESSAGES;

            // Store scroll snapshot BEFORE the fetch so useLayoutEffect can
            // compensate synchronously when React commits the new messages.
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

            let loadedMessageCount = beforeMessageCount;
            let loadedOldestMessageId = beforeOldestMessageId;
            let loadedLimit = beforeLimit;
            let pagesLoaded = 0;

            while (true) {
                // Do not start another Host turn-page while sync still marks
                // history loading (in-flight prepend / meta.loading).
                if (historySignalsRef.current.historyLoading) {
                    if (input.userInitiated) {
                        const cleared = await waitWhileHistoryLoading(targetSessionId);
                        if (!cleared) {
                            releaseSnapshot();
                            return false;
                        }
                    } else {
                        releaseSnapshot();
                        return false;
                    }
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
    });

    // Explicit load-earlier (mobile button / desktop scroll / timeline dialog) is
    // mutation-owned. Button spinner tracks mutation.isPending only — never
    // background materialize/prefetch historyLoading, which can stick true on
    // Relay and painted a permanent spinner with no real load-more flight.
    const { t } = useI18n();
    const loadEarlierMutation = useMutation({
        mutationKey: chatTimelineLoadEarlierMutationKey({
            runtimeKey: getRuntimeKey(),
            sessionId: sessionId ?? '',
        }),
        mutationFn: async (input: { sessionId: string; userInitiated?: boolean }): Promise<boolean> => {
            if (sessionIdRef.current !== input.sessionId) {
                return false;
            }
            beginHistoryInteraction();
            if (input.userInitiated) {
                releaseAutoFollow();
            }
            try {
                return await fetchOlderHistory({
                    preserveViewport: true,
                    userInitiated: Boolean(input.userInitiated),
                });
            } finally {
                settleHistoryInteraction();
            }
        },
    });

    const loadEarlier = useEvent(async (options?: { userInitiated?: boolean }) => {
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId) return;
        // Scope pending to this session so a prior session's in-flight mutation
        // cannot leave the new session's button spinning.
        if (
            loadEarlierMutation.isPending
            && loadEarlierMutation.variables?.sessionId === targetSessionId
        ) {
            return;
        }
        try {
            const grew = await loadEarlierMutation.mutateAsync({
                sessionId: targetSessionId,
                userInitiated: Boolean(options?.userInitiated),
            });
            // Silent no-op paths (missing cursor, stuck historyLoading timeout,
            // stop-no-growth) return false without throwing — still toast when
            // the user asked and history still claims more so it does not look
            // like a dead button.
            if (
                options?.userInitiated
                && grew === false
                && historySignalsRef.current.canLoadEarlier
            ) {
                toast.error(t('chat.history.loadOlderFailed'));
            }
        } catch {
            // Transport failures (Host turn-page timeout / network) used to clear
            // the spinner with no feedback — mobile looked like a no-op. Toast
            // only on user-initiated paths so auto-fill stays quiet.
            if (options?.userInitiated) {
                toast.error(t('chat.history.loadOlderFailed'));
            }
        }
    });

    // UI busy: mutation for user/scroll path + local state for auto-fill path.
    // Never OR historyLoading — that is a background gate, not button flight.
    const isLoadingOlderUi = (
        loadEarlierMutation.isPending
        && loadEarlierMutation.variables?.sessionId === sessionId
    ) || isLoadingOlder;

    // Short / collapsed transcript: TanStack Query owns the auto-fill flight.
    // queryKey moves with the timeline edge so a successful short page re-arms
    // without a useEffect dependency race. Geometry is layout-published and
    // re-checked live in queryFn. Do not put isLoadingOlder in `enabled` —
    // flipping it mid-flight would cancel the Query and strand the load.
    const oldestMessageId = messages[0]?.info?.id ?? null;
    const autoFillGate = shouldAutoFillEarlierHistory({
        enabled: autoFillEnabled,
        isMobile: isMobileSurfaceRuntime(),
        sessionReady: Boolean(sessionId),
        messageReady: messages.length > 0 || Boolean(historyMeta),
        historyLoading: historySignals.historyLoading,
        canLoadEarlier: historySignals.canLoadEarlier,
        isPinned,
        fillBlocked: autoFillBlocked,
        scrollHeight: viewportMetrics.scrollHeight,
        clientHeight: viewportMetrics.clientHeight,
        pendingRevealWork,
        // Busy/loading checked inside queryFn / fetchOlderHistory, not enabled.
        isLoadingOlder: false,
        hasMessages: messages.length > 0,
    });

    useQuery({
        queryKey: chatTimelineAutoFillQueryKey({
            runtimeKey: getRuntimeKey(),
            sessionId: sessionId ?? '',
            oldestMessageId,
            messageCount: messages.length,
            canLoadEarlier: historySignals.canLoadEarlier,
        }),
        enabled: Boolean(sessionId) && autoFillGate,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        // Transient busy (sync historyLoading / in-flight older load) must retry
        // without cancelling via enabled flips or permanent fillBlocked.
        retry: (failureCount, error) => {
            if ((error as { code?: string } | null)?.code === 'auto-fill-busy') {
                return failureCount < 40;
            }
            return false;
        },
        retryDelay: 50,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        queryFn: async (): Promise<{ status: 'grew' | 'blocked' | 'skip' | 'tall' }> => {
            const targetSessionId = sessionIdRef.current;
            if (!targetSessionId) return { status: 'skip' };

            if (historySignalsRef.current.historyLoading || isLoadingOlderRef.current) {
                const busy = new Error('auto-fill-busy') as Error & { code: string };
                busy.code = 'auto-fill-busy';
                throw busy;
            }
            if (!historySignalsRef.current.canLoadEarlier) {
                return { status: 'skip' };
            }

            const container = scrollRef.current;
            if (!container || container.clientHeight <= 0) {
                return { status: 'skip' };
            }
            if (container.scrollHeight > container.clientHeight + 48) {
                return { status: 'tall' };
            }

            try {
                const grew = await fetchOlderHistory({ preserveViewport: true });
                if (!grew) {
                    // No-growth or hard stop while still short — block further auto-fill.
                    setAutoFillBlocked(true);
                    return { status: 'blocked' };
                }
                return { status: 'grew' };
            } catch (error) {
                if ((error as { code?: string } | null)?.code === 'auto-fill-busy') {
                    throw error;
                }
                setAutoFillBlocked(true);
                throw error instanceof Error ? error : new Error('chat timeline auto-fill failed');
            }
        },
    });

    const decideAndLoadEarlier = useEvent((source: HistoryLoadSource) => {
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
    });

    const handleHistoryScroll = useEvent(() => {
        decideAndLoadEarlier('scroll');
    });

    // Explicit upward intent (wheel/touch/key) can fire when scrollTop is already
    // 0, so no scroll event would run. Same decision helper; only the pin gate
    // differs from ordinary scroll.
    const handleHistoryUpwardIntent = useEvent(() => {
        decideAndLoadEarlier('upward-intent');
    });

    const scrollToTurn = useEvent(async (
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
    });

    const scrollToMessage = useEvent(async (
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
    });

    const resumeToBottom = useEvent(async () => {
        setPendingRevealWork(false);
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        goToBottom('smooth');
    });

    const resumeToBottomInstant = useEvent(async () => {
        setPendingRevealWork(false);
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        goToBottom('instant');
    });

    const handleActiveTurnChange = useEvent((turnId: string | null) => {
        const pin = scrollPinRef.current;
        if (pin) {
            if (turnId !== pin.turnId && Date.now() < pin.expiresAt) {
                return;
            }
            scrollPinRef.current = null;
        }
        setActiveTurnId(turnId);
    });

    return {
        turnIds: turnWindowModel.turnIds,
        turnStart: 0,
        renderedMessages,
        historySignals,
        isLoadingOlder: isLoadingOlderUi,
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
