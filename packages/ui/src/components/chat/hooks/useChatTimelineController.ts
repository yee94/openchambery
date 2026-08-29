import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEvent, useIsomorphicLayoutEffect, useResizeObserver, useUnmount } from '@reactuses/core';

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
import { SESSION_TURN_PAGE_TIMEOUT_MS } from '@/sync/session-turn-page-api';
import {
    getTranscriptRepository,
    transcriptScope,
} from '@/sync/transcript-repository-runtime';
import {
    createHistoryViewportAnchorKeeper,
    type HistoryViewportAnchorKeeper,
} from './historyViewportAnchorKeeper';

type ViewportAnchor = { messageId: string; offsetTop: number };

type PrePrependSnapshot = {
    sessionId: string | null;
    height: number;
    top: number;
    anchor: ViewportAnchor | null;
    oldestId: string | null;
    newestId: string | null;
    /**
     * Height already compensated by the relative path after the user scrolled
     * mid-load. Absolute-anchor restore would yank the viewport back to the
     * capture-time position, so once the user scrolls during a load, every
     * remaining batch of that load compensates relatively against this tally.
     */
    compensatedHeight?: number;
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
    /** Session workspace directory — diagnostics for concurrent sync waits. */
    directory?: string | null;
    messages: ChatMessageEntry[];
    historyMeta: SessionHistoryMeta | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    beginHistoryViewportPreservation: () => void;
    endHistoryViewportPreservation: () => void;
    isPinned: boolean;
    showScrollButton: boolean;
    /** Active desktop transcript only (not expanded-input). Mobile stays false. */
    autoFillEnabled?: boolean;
    /**
     * Fired when a user-initiated load of earlier history is about to go out.
     *
     * The commit that delivers the prepend is too late to prepare for it: the
     * list absorbs the data change inside that commit, so whatever has to be
     * in place first — the read position to preserve, end maintenance stood
     * down — has to be arranged here, while the transcript is untouched.
     */
    onWillLoadEarlier?: () => void;
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
/**
 * Wait for an in-flight sync page (historyLoading) before user-initiated
 * load-more gives up.
 *
 * Must cover a full Host turn-page flight (`SESSION_TURN_PAGE_TIMEOUT_MS`) plus
 * a short settle for loader finally / React commit. A shorter wait (e.g. 15s)
 * false-timeouts while a concurrent initial/materialize/resync turn-page is
 * still within its legitimate 30s budget — loadMore never starts, and the UI
 * looks broken even though sync is healthy.
 */
export const HISTORY_LOADING_WAIT_MS = SESSION_TURN_PAGE_TIMEOUT_MS + 2_000
const HISTORY_LOADING_POLL_MS = 40
/** Thrown when user-initiated load-older waited out historyLoading without clear. */
export const HISTORY_LOADING_TIMEOUT_CODE = 'history-loading-timeout'

export type HistoryLoadingWaitResult = 'cleared' | 'timeout' | 'switched'

export const isHistoryLoadingTimeoutError = (error: unknown): boolean => (
    Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === HISTORY_LOADING_TIMEOUT_CODE
    )
)

const createHistoryLoadingTimeoutError = (): Error & { code: string } => {
    const error = new Error('chat history pagination wait timed out') as Error & { code: string }
    error.code = HISTORY_LOADING_TIMEOUT_CODE
    return error
}

/**
 * Every load-older failure path must hit the error console — toast/UI gating
 * is separate and may stay quiet (auto-fill), but diagnostics always print.
 */
export const logChatHistoryLoadOlderFailure = (
    kind: 'no-growth' | 'timeout' | 'failed',
    error: unknown,
    diagnostic?: Record<string, unknown>,
): void => {
    if (kind === 'no-growth') {
        console.error(
            '[chat-history] load older completed without prepending messages',
            error instanceof Error ? error : new Error('chat history pagination returned no growth'),
            diagnostic,
        )
        return
    }
    if (kind === 'timeout') {
        console.error(
            '[chat-history] load older timed out waiting for sync pagination',
            error,
            diagnostic,
        )
        return
    }
    console.error('[chat-history] load older failed', error, diagnostic)
}
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

/**
 * Whether the timeline has earlier pages above the rendered turns.
 *
 * With a `historyMeta` present, the authoritative child-store boundary answer
 * (`canLoadEarlier`) is the only source: an unknown boundary
 * (`{ complete: false, canLoadEarlier: false }`) must NEVER be reinterpreted
 * as has-more, so no `!complete` fallback exists here. Only when meta is
 * entirely absent (no Chat-driven caller supplies one) does the legacy
 * message-count heuristic apply — a transcript with fewer messages than the
 * historical window cannot have hidden pages above.
 */
export const resolveHasMoreAboveTurns = (
    historyMeta: SessionHistoryMeta | null,
    messageCount: number,
): boolean => {
    if (historyMeta) {
        return historyMeta.canLoadEarlier;
    }
    return messageCount >= getMemoryLimits().HISTORICAL_MESSAGES;
};

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
 * Scroll drift (px) between an armed load snapshot and the live scrollTop that
 * marks "the user scrolled during this load". Below it, small programmatic
 * adjustments are treated as noise and the absolute anchor restore still runs;
 * above it, restoring would yank the viewport back to the pre-load position.
 */
const USER_SCROLLED_DURING_LOAD_PX = 8;

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
// While the user's finger is DOWN, the same overflow toggle is fatal to the
// gesture itself: WKWebView latches the pan to the scroll container, and the
// synchronous overflow flip breaks that latch — the page stops following the
// finger until lift + re-touch (reported as "gesture dead" after reversing
// direction during a history load). Mid-gesture the write cannot stick anyway,
// so compensation is deferred to lift-off with a live-relative anchor.
const TOUCH_COMPENSATION_DRIFT_MARGIN_PX = 80;

type PendingTouchCompensation = {
    /** Live scrollTop at the first deferred batch of the current gesture. */
    anchorTop: number;
    /** Cumulative above-viewport height added by deferred batches. */
    delta: number;
};

type TouchGestureState = {
    touches: number;
    pending: PendingTouchCompensation | null;
    settleScheduled: boolean;
};

type MomentumWriteControl = {
    generation: number;
};

const touchGestureStates = new WeakMap<HTMLElement, TouchGestureState>();
const momentumWriteControls = new WeakMap<HTMLElement, MomentumWriteControl>();

const bumpMomentumWriteGeneration = (container: HTMLElement): number => {
    const control = momentumWriteControls.get(container) ?? { generation: 0 };
    control.generation += 1;
    momentumWriteControls.set(container, control);
    return control.generation;
};

/**
 * Drop leftover touch-defer state and cancel in-flight momentum watchdogs.
 * Session switches reuse the same scroll element; a pending lift-off write
 * from the previous session (or the opening tap) must not yank the new
 * transcript to a stale mid-timeline target.
 */
export const resetTouchGestureTracking = (container: HTMLElement) => {
    const state = touchGestureStates.get(container);
    if (state) {
        state.touches = 0;
        state.pending = null;
        state.settleScheduled = false;
    }
    bumpMomentumWriteGeneration(container);
};

/**
 * Installs the touch gesture counter on the scroll container. Must run before
 * the first compensation write so a gesture that is already in flight when a
 * prepend commits is counted (lazy install inside the writer would miss the
 * touchstart and fall through to the gesture-killing direct write).
 */
export const attachTouchGestureTracking = (container: HTMLElement) => {
    resolveTouchGestureState(container);
};

const resolveTouchGestureState = (container: HTMLElement): TouchGestureState => {
    const existing = touchGestureStates.get(container);
    if (existing) return existing;

    const state: TouchGestureState = { touches: 0, pending: null, settleScheduled: false };
    container.addEventListener('touchstart', () => {
        state.touches += 1;
    }, { passive: true });
    const release = () => {
        state.touches = Math.max(0, state.touches - 1);
        if (state.touches === 0 && state.pending) {
            scheduleTouchCompensationSettle(container, state);
        }
    };
    container.addEventListener('touchend', release, { passive: true });
    container.addEventListener('touchcancel', release, { passive: true });
    touchGestureStates.set(container, state);
    return state;
};

const scheduleTouchCompensationSettle = (container: HTMLElement, state: TouchGestureState) => {
    if (state.settleScheduled || typeof window === 'undefined') return;
    state.settleScheduled = true;
    window.requestAnimationFrame(() => {
        state.settleScheduled = false;
        const pending = state.pending;
        state.pending = null;
        if (!pending || state.touches > 0 || !container.isConnected) return;
        // The user kept scrolling after the deferred batch landed: applying
        // the stale anchor would yank the viewport. Only restore when the
        // live position still matches the gesture's anchor within the
        // uncompensated growth plus margin.
        const drift = Math.abs(container.scrollTop - pending.anchorTop);
        if (drift > pending.delta + TOUCH_COMPENSATION_DRIFT_MARGIN_PX) return;
        applyDefeatingMomentumWrite(container, pending.anchorTop + pending.delta);
    });
};

const applyDefeatingMomentumWrite = (container: HTMLElement, target: number) => {
    const generation = bumpMomentumWriteGeneration(container);
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
        if ((momentumWriteControls.get(container)?.generation ?? 0) !== generation) {
            container.removeEventListener('touchstart', cancelOnUserTouch);
            return;
        }
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

/**
 * Momentum-defeating scrollTop write for the mobile surface.
 *
 * `deltaAbove` (height the prepend added above the viewport) enables the
 * gesture-preserving path: while a touch is active the write is deferred to
 * lift-off instead of toggling overflow mid-gesture (which kills the pan on
 * WKWebView). Deferred batches accumulate against the gesture's live anchor
 * and are dropped entirely if the user scrolled on before lift-off.
 */
export const setScrollTopDefeatingMomentum = (
    container: HTMLElement,
    target: number,
    deltaAbove?: number,
) => {
    const state = resolveTouchGestureState(container);
    if (state.touches > 0 && typeof deltaAbove === 'number' && deltaAbove > 0) {
        state.pending = state.pending
            ? { anchorTop: state.pending.anchorTop, delta: state.pending.delta + deltaAbove }
            : { anchorTop: container.scrollTop, delta: deltaAbove };
        return;
    }
    // Gesture idle (possibly momentum-only): a stale deferred batch must not
    // double-apply after this direct write.
    state.pending = null;
    applyDefeatingMomentumWrite(container, target);
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

export type ChatViewportMetrics = {
    scrollHeight: number;
    clientHeight: number;
};

/**
 * Publish chat scroller metrics for auto-fill only when the box actually
 * changed. Streaming part commits used to call `setState({ ... })` with a fresh
 * object on every messages identity change even when height was stable, which
 * forced a second ChatContainer render (and a layout read) in the same shell-
 * tool / stream window — the double-paint path behind the full-viewport flash.
 */
export const resolvePublishedViewportMetrics = (
    previous: ChatViewportMetrics,
    next: ChatViewportMetrics,
): ChatViewportMetrics => {
    if (
        previous.scrollHeight === next.scrollHeight
        && previous.clientHeight === next.clientHeight
    ) {
        return previous;
    }
    return next;
};

export const useChatTimelineController = ({
    sessionId,
    directory = null,
    messages,
    historyMeta,
    scrollRef,
    messageListRef,
    loadMoreMessages,
    goToBottom,
    releaseAutoFollow,
    beginHistoryViewportPreservation,
    endHistoryViewportPreservation,
    isPinned,
    showScrollButton,
    autoFillEnabled = false,
    onWillLoadEarlier,
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
    // A successful prepend that adds no records has reached the current history
    // boundary. Keep the control hidden until an authoritative boundary update
    // advances its loaded-turn limit.
    const [noGrowthHistoryLimit, setNoGrowthHistoryLimit] = React.useState<number | null>(null);
    // Layout metrics for auto-fill enablement. Owned by ResizeObserver so
    // streaming text/tool growth updates geometry without a messages-keyed
    // layout effect that re-renders ChatContainer on every part commit.
    const [viewportMetrics, setViewportMetrics] = React.useState<ChatViewportMetrics>({
        scrollHeight: 0,
        clientHeight: 0,
    });

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const directoryRef = React.useRef<string | null>(directory ?? null);
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const noGrowthHistoryLimitRef = React.useRef<number | null>(noGrowthHistoryLimit);
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
        noGrowthHistoryLimitRef.current = null;
        setNoGrowthHistoryLimit(null);
        setViewportMetrics({ scrollHeight: 0, clientHeight: 0 });
    }

    const historySignals = React.useMemo(() => {
        const hasBufferedTurns = false;
        const blockedAtCurrentHistoryLimit = historyMeta?.limit === noGrowthHistoryLimit;
        const hasMoreAboveTurns = !blockedAtCurrentHistoryLimit
            && resolveHasMoreAboveTurns(historyMeta, messages.length);
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
    directoryRef.current = directory ?? null;
    messagesRef.current = messages;
    historyMetaRef.current = historyMeta;
    noGrowthHistoryLimitRef.current = noGrowthHistoryLimit;

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

    // Armed-window DOM keeper for non-virtual desktop: corrects materialization /
    // hydration mutations that do not change renderedMessages (layout effect miss).
    const historyAnchorKeeperRef = React.useRef<HistoryViewportAnchorKeeper | null>(null);

    const stopKeeper = useEvent(() => {
        const keeper = historyAnchorKeeperRef.current;
        if (!keeper) return;
        historyAnchorKeeperRef.current = null;
        keeper.dispose();
    });

    useUnmount(() => {
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        stopKeeper();
        resolvePendingRenderWaiters();
        resolvePendingScrollRequest(false);
    });

    const renderedMessages = messages;

    useIsomorphicLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [renderedMessages]);

    // Publish scroll geometry for Query-driven auto-fill. ResizeObserver fires
    // after layout when the scroller or its content actually changes size —
    // not on every streaming part identity change that leaves height alone.
    const publishViewportMetrics = useEvent(() => {
        const el = scrollRef.current;
        if (!el) {
            setViewportMetrics((previous) => resolvePublishedViewportMetrics(previous, {
                scrollHeight: 0,
                clientHeight: 0,
            }));
            return;
        }
        setViewportMetrics((previous) => resolvePublishedViewportMetrics(previous, {
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        }));
    });
    const canObserveViewportMetrics = typeof ResizeObserver !== 'undefined';
    // Pass the ref object (not `.current`) so attach/detach tracks the scroller
    // mount the same way ChatContainer's --chat-scroll-height observer does.
    useResizeObserver(
        canObserveViewportMetrics ? scrollRef : null,
        publishViewportMetrics,
    );
    // Session / load-older edges still need a layout-phase seed so auto-fill
    // does not wait for an unrelated size event after the first paint.
    useIsomorphicLayoutEffect(() => {
        publishViewportMetrics();
        // Session/load edges only; publishViewportMetrics is useEvent-stable.
    }, [sessionId, isLoadingOlder]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory stores a snapshot here before triggering the fetch and
    // keeps it armed for the whole load. Layout effect re-asserts it after
    // every commit React makes in between — before the browser paints.
    // Desktop loading status is an overlay (no layout push). Within the armed
    // window a MutationObserver keeper also corrects in-component mutations
    // (slim→full / markdown hydrate) that leave renderedMessages unchanged.
    // (DOM geometry sync is intentionally layout-phase, not Query/useEffect.)
    const prePrependScrollRef = React.useRef<PrePrependSnapshot | null>(null);

    const captureViewportAnchor = useEvent((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    });

    const restoreViewportAnchor = useEvent((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    });

    const startKeeper = useEvent(() => {
        // Mobile keeps its momentum-defeating writer; the keeper is desktop.
        if (isMobileSurfaceRuntime()) return;
        stopKeeper();
        const container = scrollRef.current;
        if (!container) return;
        const anchor = captureViewportAnchor();
        if (!anchor) return;
        // Active in BOTH engines. In the non-virtualized window it owns all
        // mutation compensation (materialization / hydration); across the
        // none→tanstack flip and inside virtualized history it only bridges the
        // 1-2 frame gap before TanStack core's measure adjustment (which
        // round-trips through React onChange) writes scrollTop. The keeper's
        // scroll-rebase accepts core's absolute write instead of fighting it —
        // unlike the old multi-frame rAF hold, it never chases core.
        historyAnchorKeeperRef.current = createHistoryViewportAnchorKeeper({
            container,
            anchor,
        });
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
        if (!isMobileSurfaceRuntime()) return;
        const container = scrollRef.current;
        if (!container) return;
        attachTouchGestureTracking(container);
        resetTouchGestureTracking(container);
    }, [sessionId, scrollRef]);

    useIsomorphicLayoutEffect(() => {
        stopKeeper();
        prePrependScrollRef.current = null;
        prependTrackingRef.current = null;
        messageListRef.current?.cancelViewportAnchorHold();
    }, [sessionId]);

    useIsomorphicLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let snap = prePrependScrollRef.current;
        // Fast wheel/fling during an in-flight load: scrollTop moves
        // synchronously while scroll events land per frame, so by the time the
        // history page commits the snapshot anchor describes a viewport the
        // user has already scrolled away from. Restoring it would yank the
        // viewport back to the pre-load position (visible jump-back during
        // fast upward scrolling). Drop the snapshot instead and let this
        // prepend take the relative paths — background height-delta
        // compensation when non-virtual, TanStack core's keyed adjustment
        // when virtual — both anchored at the user's live position.
        if (snap && Math.abs(container.scrollTop - snap.top) > USER_SCROLLED_DURING_LOAD_PX) {
            prePrependScrollRef.current = null;
            snap = null;
        }
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

        // Avoid reading scrollHeight on every append: that forces a full-document
        // Layout during React layout effects (trace: updateTracking next to
        // removeChild + ScrollLayer). Only measure when prepend compensation
        // needs the previous height; otherwise reuse the last tracked value.
        const updateTracking = (scrollHeight?: number) => {
            prependTrackingRef.current = {
                oldestId: currentOldestId,
                newestId: currentNewestId,
                scrollHeight: scrollHeight
                    ?? prependTrackingRef.current?.scrollHeight
                    ?? 0,
            };
        };

        // An armed explicit-load snapshot owns its prepend even while the
        // auto-follow prop is still catching up from releaseAutoFollow().
        // Re-pinning that snapshot would overwrite its preserved read position.
        if (isPinnedRef.current && !snap) {
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
            stopKeeper();
            if (didPrepend) {
                prePrependScrollRef.current = null;
                goToBottom('instant');
                updateTracking(container.scrollHeight);
            } else {
                updateTracking();
            }
            return;
        }

        const historyVirtualized = messageListRef.current?.isHistoryVirtualized() ?? false;
        const prependCompensation = resolveHistoryPrependCompensation(historyVirtualized);

        // Armed snapshot from loadEarlier / auto-fill. TanStack `anchorTo: 'end'`
        // performs the normal keyed prepend adjustment. Android can still leave
        // its scroll element at y=0 after a top-button prepend, so one layout
        // phase keyed-anchor correction verifies the final DOM position. A
        // multi-frame hold or height-delta writer would race later TanStack
        // measurements and is intentionally excluded.
        if (snap) {
            if (prependCompensation.owner === 'tanstack-core') {
                // Drop any hold that an older code path may have left running.
                messageListRef.current?.cancelViewportAnchorHold();
                const anchor = snap.anchor;
                if (anchor) {
                    restoreViewportAnchor(anchor);
                }
                updateTracking();
                return;
            }

            const measuredHeight = container.scrollHeight;
            const heightDelta = measuredHeight - snap.height;

            // iOS overwrites plain scrollTop writes while a fling runs, so
            // mobile keeps the momentum-defeating writer and its height delta.
            // Non-virtual only (virtual branch returned above).
            if (isMobileSurfaceRuntime()) {
                if (heightDelta > 0) {
                    setScrollTopDefeatingMomentum(container, snap.top + heightDelta, heightDelta);
                }
                updateTracking(measuredHeight);
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
            updateTracking(measuredHeight);
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
            const measuredHeight = container.scrollHeight;
            const delta = measuredHeight - prev.scrollHeight;
            if (delta > 0) {
                const target = container.scrollTop + delta;
                if (isMobileSurfaceRuntime()) {
                    setScrollTopDefeatingMomentum(container, target, delta);
                } else {
                    container.scrollTop = target;
                }
            }
            updateTracking(measuredHeight);
            startKeeper();
            return;
        }

        updateTracking();
    }, [renderedMessages, goToBottom]);

    const revealBufferedTurns = useEvent(async (): Promise<boolean> => false);

    const waitWhileHistoryLoading = useEvent(async (
        targetSessionId: string,
    ): Promise<HistoryLoadingWaitResult> => {
        const waitStartedAt = Date.now();
        const deadline = waitStartedAt + HISTORY_LOADING_WAIT_MS;
        const directoryForLog = directoryRef.current;
        const requestAtStart = directoryForLog
            ? getTranscriptRepository()?.getRequestState?.(
                transcriptScope(directoryForLog, targetSessionId),
            )
            : undefined;
        console.info('[chat-history] waiting for sync pagination to clear', {
            sessionId: targetSessionId,
            directory: directoryForLog,
            waitMs: HISTORY_LOADING_WAIT_MS,
            hostTurnPageTimeoutMs: SESSION_TURN_PAGE_TIMEOUT_MS,
            historyLoading: historySignalsRef.current.historyLoading,
            historyMeta: historyMetaRef.current,
            requestStatus: requestAtStart?.status ?? null,
            requestError: requestAtStart?.error ?? null,
        });
        while (historySignalsRef.current.historyLoading) {
            if (sessionIdRef.current !== targetSessionId) {
                console.info('[chat-history] historyLoading wait aborted — session switched', {
                    sessionId: targetSessionId,
                    elapsedMs: Date.now() - waitStartedAt,
                });
                return 'switched';
            }
            if (Date.now() >= deadline) {
                const requestAtTimeout = directoryForLog
                    ? getTranscriptRepository()?.getRequestState?.(
                        transcriptScope(directoryForLog, targetSessionId),
                    )
                    : undefined;
                console.error(
                    '[chat-history] historyLoading wait timed out — sync flag still true',
                    {
                        sessionId: targetSessionId,
                        directory: directoryForLog,
                        elapsedMs: Date.now() - waitStartedAt,
                        waitMs: HISTORY_LOADING_WAIT_MS,
                        hostTurnPageTimeoutMs: SESSION_TURN_PAGE_TIMEOUT_MS,
                        historyLoading: historySignalsRef.current.historyLoading,
                        historyMeta: historyMetaRef.current,
                        requestStatusAtStart: requestAtStart?.status ?? null,
                        requestStatusAtTimeout: requestAtTimeout?.status ?? null,
                        requestErrorAtTimeout: requestAtTimeout?.error ?? null,
                        likelyStaleLoadingFlag:
                            requestAtTimeout?.status === 'ready'
                            || requestAtTimeout?.status === 'error'
                            || requestAtTimeout == null,
                    },
                );
                return 'timeout';
            }
            await new Promise<void>((resolve) => {
                if (typeof window === 'undefined') {
                    resolve();
                    return;
                }
                window.setTimeout(resolve, HISTORY_LOADING_POLL_MS);
            });
        }
        console.info('[chat-history] historyLoading cleared — resuming load older', {
            sessionId: targetSessionId,
            elapsedMs: Date.now() - waitStartedAt,
            requestStatus: directoryForLog
                ? (getTranscriptRepository()?.getRequestState?.(
                    transcriptScope(directoryForLog, targetSessionId),
                )?.status ?? null)
                : null,
        });
        return sessionIdRef.current === targetSessionId ? 'cleared' : 'switched';
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
        let historyViewportPreservationActive = Boolean(input.userInitiated);
        if (historyViewportPreservationActive) {
            beginHistoryViewportPreservation();
        }
        const releaseSnapshot = () => {
            if (armedSnapshot && prePrependScrollRef.current === armedSnapshot) {
                prePrependScrollRef.current = null;
                messageListRef.current?.cancelViewportAnchorHold();
            }
            // The anchor keeper stays armed here on purpose: after the load
            // lands, scroll-time markdown hydration / slim materialization keep
            // mutating content heights for a while. The keeper self-retires via
            // its quiet window once scrolling and mutations stop.
            if (historyViewportPreservationActive) {
                historyViewportPreservationActive = false;
                endHistoryViewportPreservation();
            }
        };

        try {
            // Background materialize/tail pulls flip historyLoading without
            // disabling the mobile button. User taps must wait for that flight
            // instead of returning false with no feedback (intermittent no-op).
            // Timeout throws so loadEarlier can toast a dedicated failure.
            if (historySignalsRef.current.historyLoading) {
                if (!input.userInitiated) {
                    return false;
                }
                const wait = await waitWhileHistoryLoading(targetSessionId);
                if (wait === 'timeout') {
                    throw createHistoryLoadingTimeoutError();
                }
                if (wait === 'switched' || !historySignalsRef.current.hasMoreAboveTurns) {
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
                startKeeper();
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
                        const wait = await waitWhileHistoryLoading(targetSessionId);
                        if (wait === 'timeout') {
                            releaseSnapshot();
                            throw createHistoryLoadingTimeoutError();
                        }
                        if (wait === 'switched') {
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
                    // Concurrent sync can hold historyLoading while loadMore
                    // busy-no-ops. Wait it out and retry the same interaction
                    // budget; never mark history exhausted from a busy miss.
                    if (historySignalsRef.current.historyLoading) {
                        if (input.userInitiated) {
                            const wait = await waitWhileHistoryLoading(targetSessionId);
                            if (wait === 'timeout') {
                                releaseSnapshot();
                                throw createHistoryLoadingTimeoutError();
                            }
                            if (wait === 'switched') {
                                releaseSnapshot();
                                return false;
                            }
                            pagesLoaded -= 1;
                            continue;
                        }
                        releaseSnapshot();
                        return false;
                    }
                    const exhaustedLimit = historyMetaRef.current?.limit ?? limitBefore;
                    noGrowthHistoryLimitRef.current = exhaustedLimit;
                    setNoGrowthHistoryLimit(exhaustedLimit);
                    historySignalsRef.current = {
                        ...historySignalsRef.current,
                        hasMoreAboveTurns: false,
                        canLoadEarlier: false,
                    };
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
            // Desktop loading status is overlay (no layout push). Keep the
            // snapshot + DOM keeper armed until the next commit settles so
            // materialization/hydration mutations still correct before paint;
            // then release so ordinary commits stay free of a stale read position.
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
        // Past the dedupe, so this call really is going to fetch. Automatic
        // backfill is excluded: it has no read position to protect and must
        // leave end maintenance alone.
        if (options?.userInitiated) {
            onWillLoadEarlier?.();
        }
        try {
            const grew = await loadEarlierMutation.mutateAsync({
                sessionId: targetSessionId,
                userInitiated: Boolean(options?.userInitiated),
            });
            // Silent no-op paths (missing cursor, stop-no-growth) return false
            // without throwing. Always log when history still claims more;
            // toast only on user-initiated so auto-fill stays quiet.
            if (grew === false && historySignalsRef.current.canLoadEarlier) {
                const diagnostic = {
                    sessionId: targetSessionId,
                    grew,
                    userInitiated: Boolean(options?.userInitiated),
                    canLoadEarlier: historySignalsRef.current.canLoadEarlier,
                    hasMoreAboveTurns: historySignalsRef.current.hasMoreAboveTurns,
                    historyLoading: historySignalsRef.current.historyLoading,
                    historyMeta: historyMetaRef.current,
                    messageCount: messagesRef.current.length,
                    oldestMessageId: messagesRef.current[0]?.info?.id ?? null,
                };
                logChatHistoryLoadOlderFailure(
                    'no-growth',
                    new Error('chat history pagination returned no growth'),
                    diagnostic,
                );
                if (options?.userInitiated) {
                    toast.error(t('chat.history.loadOlderFailed'));
                }
            }
        } catch (error) {
            const diagnostic = {
                sessionId: targetSessionId,
                userInitiated: Boolean(options?.userInitiated),
                waitMs: HISTORY_LOADING_WAIT_MS,
                hostTurnPageTimeoutMs: SESSION_TURN_PAGE_TIMEOUT_MS,
                canLoadEarlier: historySignalsRef.current.canLoadEarlier,
                historyLoading: historySignalsRef.current.historyLoading,
                historyMeta: historyMetaRef.current,
                messageCount: messagesRef.current.length,
                oldestMessageId: messagesRef.current[0]?.info?.id ?? null,
            };
            // Always console.error — toast remains user-initiated only.
            if (isHistoryLoadingTimeoutError(error)) {
                logChatHistoryLoadOlderFailure('timeout', error, diagnostic);
            } else {
                logChatHistoryLoadOlderFailure('failed', error, diagnostic);
            }
            // Transport failures / historyLoading wait timeout used to clear
            // the spinner with no feedback — mobile looked like a no-op. Toast
            // only on user-initiated paths so auto-fill stays quiet.
            if (options?.userInitiated) {
                toast.error(
                    isHistoryLoadingTimeoutError(error)
                        ? t('chat.history.loadOlderTimeout')
                        : t('chat.history.loadOlderFailed'),
                );
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
                    if (historySignalsRef.current.canLoadEarlier) {
                        logChatHistoryLoadOlderFailure(
                            'no-growth',
                            new Error('chat history pagination returned no growth'),
                            {
                                sessionId: targetSessionId,
                                source: 'auto-fill',
                                grew,
                                canLoadEarlier: historySignalsRef.current.canLoadEarlier,
                                hasMoreAboveTurns: historySignalsRef.current.hasMoreAboveTurns,
                                historyLoading: historySignalsRef.current.historyLoading,
                                historyMeta: historyMetaRef.current,
                                messageCount: messagesRef.current.length,
                                oldestMessageId: messagesRef.current[0]?.info?.id ?? null,
                            },
                        );
                    }
                    setAutoFillBlocked(true);
                    return { status: 'blocked' };
                }
                return { status: 'grew' };
            } catch (error) {
                if ((error as { code?: string } | null)?.code === 'auto-fill-busy') {
                    throw error;
                }
                const diagnostic = {
                    sessionId: targetSessionId,
                    source: 'auto-fill',
                    waitMs: HISTORY_LOADING_WAIT_MS,
                    canLoadEarlier: historySignalsRef.current.canLoadEarlier,
                    historyLoading: historySignalsRef.current.historyLoading,
                    historyMeta: historyMetaRef.current,
                    messageCount: messagesRef.current.length,
                    oldestMessageId: messagesRef.current[0]?.info?.id ?? null,
                };
                if (isHistoryLoadingTimeoutError(error)) {
                    logChatHistoryLoadOlderFailure('timeout', error, diagnostic);
                } else {
                    logChatHistoryLoadOlderFailure('failed', error, diagnostic);
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
        // The legend list owns the scroll position; auto-follow's goToBottom
        // is a no-op there (`enabled: false`). The handle talks to the list.
        messageListRef.current?.scrollToBottom();
        goToBottom('smooth');
    });

    const resumeToBottomInstant = useEvent(async () => {
        setPendingRevealWork(false);
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        messageListRef.current?.scrollToBottom();
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
