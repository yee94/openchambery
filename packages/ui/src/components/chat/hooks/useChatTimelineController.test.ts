import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    chatTimelineAutoFillQueryKey,
    HISTORY_LOADING_TIMEOUT_CODE,
    HISTORY_LOADING_WAIT_MS,
    isHistoryLoadingTimeoutError,
    isOlderHistoryPrependCommit,
    logChatHistoryLoadOlderFailure,
    resolveHasMoreAboveTurns,
    resolveHistoryPageDecision,
    resolveHistoryPrependCompensation,
    resolvePublishedViewportMetrics,
    attachTouchGestureTracking,
    setScrollTopDefeatingMomentum,
    shouldAutoFillEarlierHistory,
    shouldHoldHistoryViewportAnchor,
    shouldLoadEarlierHistory,
} from './useChatTimelineController';
import { SESSION_TURN_PAGE_TIMEOUT_MS } from '@/sync/session-turn-page-api';

const here = dirname(fileURLToPath(import.meta.url));

describe('isOlderHistoryPrependCommit', () => {
    test('detects older messages inserted above the existing timeline', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_4',
        })).toBe(true);
    });

    test('does not treat appends or replacements as prepends', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_2',
            currentNewestId: 'msg_5',
        })).toBe(false);
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_5',
        })).toBe(false);
    });
});

describe('resolveHistoryPrependCompensation', () => {
    test('assigns virtualized prepend compensation exclusively to TanStack core', () => {
        expect(resolveHistoryPrependCompensation(true)).toEqual({
            owner: 'tanstack-core',
        });
    });

    test('keeps manual delta and anchor restoration with the non-virtualized controller', () => {
        expect(resolveHistoryPrependCompensation(false)).toEqual({
            owner: 'controller',
        });
    });
});

describe('resolveHasMoreAboveTurns', () => {
    const meta = (input: { complete: boolean; canLoadEarlier: boolean }) => ({
        limit: 6,
        loading: false,
        ...input,
    });

    test('unknown boundary meta ({ complete:false, canLoadEarlier:false }) is never has-more', () => {
        // No `!complete` fallback may reinterpret unknown as loadable.
        expect(resolveHasMoreAboveTurns(meta({ complete: false, canLoadEarlier: false }), 0)).toBe(false);
        expect(resolveHasMoreAboveTurns(meta({ complete: false, canLoadEarlier: false }), 100)).toBe(false);
    });

    test('has-more boundary meta resolves true', () => {
        expect(resolveHasMoreAboveTurns(meta({ complete: false, canLoadEarlier: true }), 0)).toBe(true);
    });

    test('exhausted boundary meta resolves false', () => {
        expect(resolveHasMoreAboveTurns(meta({ complete: true, canLoadEarlier: false }), 100)).toBe(false);
    });

    test('session switch does not flash the button across meta transitions', () => {
        // New session opens with unknown meta (hidden), boundary converges to
        // has-more (shown), then exhausts (hidden). Exhausted → unknown (next
        // session) must also stay hidden — no transient has-more paint.
        const unknown = meta({ complete: false, canLoadEarlier: false });
        const hasMore = meta({ complete: false, canLoadEarlier: true });
        const exhausted = meta({ complete: true, canLoadEarlier: false });
        expect(resolveHasMoreAboveTurns(unknown, 50)).toBe(false);
        expect(resolveHasMoreAboveTurns(hasMore, 50)).toBe(true);
        expect(resolveHasMoreAboveTurns(exhausted, 50)).toBe(false);
        expect(resolveHasMoreAboveTurns(unknown, 50)).toBe(false);
    });

    test('absent meta keeps the legacy message-count heuristic only for non-Chat callers', () => {
        // ChatContainer always passes meta; a missing meta means the heuristic
        // window applies (short transcript cannot hide pages above).
        expect(resolveHasMoreAboveTurns(null, 0)).toBe(false);
        expect(resolveHasMoreAboveTurns(null, 10_000)).toBe(true);
    });
});

describe('resolvePublishedViewportMetrics', () => {
    test('reuses the previous object when scroll geometry is unchanged', () => {
        const previous = { scrollHeight: 4000, clientHeight: 900 };
        expect(resolvePublishedViewportMetrics(previous, {
            scrollHeight: 4000,
            clientHeight: 900,
        })).toBe(previous);
    });

    test('publishes a new object when height or viewport size changes', () => {
        const previous = { scrollHeight: 4000, clientHeight: 900 };
        expect(resolvePublishedViewportMetrics(previous, {
            scrollHeight: 4120,
            clientHeight: 900,
        })).toEqual({ scrollHeight: 4120, clientHeight: 900 });
        expect(resolvePublishedViewportMetrics(previous, {
            scrollHeight: 4000,
            clientHeight: 800,
        })).toEqual({ scrollHeight: 4000, clientHeight: 800 });
    });
});

// Near-top uses max(1200, clientHeight * 1.5). clientHeight 800 => threshold 1200.
const NEAR_TOP = {
    scrollTop: 100,
    clientHeight: 800,
} as const;
const FAR_FROM_TOP = {
    scrollTop: 2000,
    clientHeight: 800,
} as const;

const baseLoadEarlierInput = {
    source: 'scroll' as const,
    isMobile: false,
    isPinned: false,
    ...NEAR_TOP,
    canLoadEarlier: true,
    isLoadingOlder: false,
    pendingRevealWork: false,
};

describe('shouldLoadEarlierHistory', () => {
    test('desktop + upward-intent + pinned + near-top => true', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isPinned: true,
            ...NEAR_TOP,
        })).toBe(true);
    });

    test('ordinary scroll + pinned => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'scroll',
            isPinned: true,
            ...NEAR_TOP,
        })).toBe(false);
    });

    test('far from top => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isPinned: true,
            ...FAR_FROM_TOP,
        })).toBe(false);
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'scroll',
            isPinned: false,
            ...FAR_FROM_TOP,
        })).toBe(false);
    });

    test('mobile => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isMobile: true,
            isPinned: true,
            ...NEAR_TOP,
        })).toBe(false);
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'scroll',
            isMobile: true,
            isPinned: false,
            ...NEAR_TOP,
        })).toBe(false);
    });

    test('loading older => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isPinned: true,
            isLoadingOlder: true,
            ...NEAR_TOP,
        })).toBe(false);
    });

    test('pending reveal work => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isPinned: true,
            pendingRevealWork: true,
            ...NEAR_TOP,
        })).toBe(false);
    });

    test('no more history => false', () => {
        expect(shouldLoadEarlierHistory({
            ...baseLoadEarlierInput,
            source: 'upward-intent',
            isPinned: true,
            canLoadEarlier: false,
            ...NEAR_TOP,
        })).toBe(false);
    });
});

const basePageDecisionInput = {
    scrollHeightBefore: 5000,
    scrollHeightAfter: 5000,
    messageCountBefore: 40,
    messageCountAfter: 50,
    oldestIdBefore: 'msg_10',
    oldestIdAfter: 'msg_1',
    limitBefore: 40,
    limitAfter: 50,
    hasMoreAbove: true,
    pagesLoaded: 1,
    maxPages: 10,
};

describe('resolveHistoryPageDecision', () => {
    test('message/oldest growth without scrollHeight growth, hasMore, under max => continue', () => {
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5000,
            messageCountBefore: 40,
            messageCountAfter: 50,
            oldestIdBefore: 'msg_10',
            oldestIdAfter: 'msg_1',
            hasMoreAbove: true,
            pagesLoaded: 1,
            maxPages: 10,
        })).toBe('continue');
    });

    test('scrollHeight growth >1px => stop-visible', () => {
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5002,
        })).toBe('stop-visible');
    });

    test('no data growth => stop-no-growth', () => {
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5000,
            messageCountBefore: 40,
            messageCountAfter: 40,
            oldestIdBefore: 'msg_10',
            oldestIdAfter: 'msg_10',
            limitBefore: 40,
            limitAfter: 40,
            hasMoreAbove: true,
        })).toBe('stop-no-growth');
    });

    test('hasMore false => stop-exhausted', () => {
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5000,
            messageCountBefore: 40,
            messageCountAfter: 50,
            oldestIdBefore: 'msg_10',
            oldestIdAfter: 'msg_1',
            hasMoreAbove: false,
        })).toBe('stop-exhausted');
    });

    test('pagesLoaded reaches maxPages => stop-bounded', () => {
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5000,
            messageCountBefore: 40,
            messageCountAfter: 50,
            oldestIdBefore: 'msg_10',
            oldestIdAfter: 'msg_1',
            hasMoreAbove: true,
            pagesLoaded: 10,
            maxPages: 10,
        })).toBe('stop-bounded');
    });

    test('interaction page ceiling=1: first server turn page already stops further paging', () => {
        // One client interaction is allowed a single server turn-page request.
        // After that page lands, pagesLoaded=1 with maxPages=1 => stop-bounded
        // even when collapsed content would otherwise continue.
        expect(resolveHistoryPageDecision({
            ...basePageDecisionInput,
            scrollHeightBefore: 5000,
            scrollHeightAfter: 5000,
            messageCountBefore: 40,
            messageCountAfter: 50,
            oldestIdBefore: 'msg_10',
            oldestIdAfter: 'msg_1',
            hasMoreAbove: true,
            pagesLoaded: 1,
            maxPages: 1,
        })).toBe('stop-bounded');
    });
});

describe('HISTORY_INTERACTION_MAX_PAGES source contract', () => {
    test('controller interaction page ceiling is 1 (single server turn page)', () => {
        const source = readFileSync(
            join(here, 'useChatTimelineController.ts'),
            'utf8',
        );
        const match = source.match(/HISTORY_INTERACTION_MAX_PAGES\s*=\s*(\d+)/);
        expect(match?.[1]).toBe('1');
        // Guard against reintroducing multi-page while loops (3-page ceiling).
        expect(/HISTORY_INTERACTION_MAX_PAGES\s*=\s*3\b/.test(source)).toBe(false);
    });
});

const baseAutoFillInput = {
    enabled: true,
    isMobile: false,
    sessionReady: true,
    messageReady: true,
    historyLoading: false,
    canLoadEarlier: true,
    isPinned: true,
    fillBlocked: false,
    scrollHeight: 400,
    clientHeight: 400,
    pendingRevealWork: false,
    isLoadingOlder: false,
    hasMessages: true,
} as const;

describe('shouldAutoFillEarlierHistory', () => {
    test('desktop + ready + not loading + canLoad + pinned + not blocked + scrollHeight within clientHeight+48 + no pending/loadingOlder => true', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
        })).toBe(true);
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            scrollHeight: 448,
            clientHeight: 400,
        })).toBe(true);
    });

    test('scrollHeight exceeds clientHeight+48 => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            scrollHeight: 449,
            clientHeight: 400,
        })).toBe(false);
    });

    test('mobile => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            isMobile: true,
        })).toBe(false);
    });

    test('enabled false (inactive or expanded-input) => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            enabled: false,
        })).toBe(false);
    });

    test('no messages => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            hasMessages: false,
        })).toBe(false);
    });

    test('history loading => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            historyLoading: true,
        })).toBe(false);
    });

    test('no more history => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            canLoadEarlier: false,
        })).toBe(false);
    });

    test('released (not pinned) => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            isPinned: false,
        })).toBe(false);
    });

    test('fill blocked after no-growth/failure => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            fillBlocked: true,
        })).toBe(false);
    });

    test('pending reveal work => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            pendingRevealWork: true,
        })).toBe(false);
    });

    test('loading older => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            isLoadingOlder: true,
        })).toBe(false);
    });

    test('session or message not ready => false', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            sessionReady: false,
        })).toBe(false);
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            messageReady: false,
        })).toBe(false);
    });

    test('short collapsed transcript keeps auto-fill without a message-count ceiling', () => {
        // Collapsed activity can stack many messages without overflow; count must
        // not freeze fill (that forced expand-before-load-more).
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            scrollHeight: 400,
            clientHeight: 400,
        })).toBe(true);
    });

    test('unmeasured viewport (clientHeight 0) does not auto-fill', () => {
        expect(shouldAutoFillEarlierHistory({
            ...baseAutoFillInput,
            scrollHeight: 0,
            clientHeight: 0,
        })).toBe(false);
    });
});

describe('chatTimelineAutoFillQueryKey', () => {
    test('includes runtime, session, edge id, count, and canLoadEarlier', () => {
        expect(chatTimelineAutoFillQueryKey({
            runtimeKey: 'rt_1',
            sessionId: 'ses_1',
            oldestMessageId: 'msg_old',
            messageCount: 12,
            canLoadEarlier: true,
        })).toEqual([
            'chat-timeline-auto-fill',
            'rt_1',
            'ses_1',
            'msg_old',
            12,
            true,
        ]);
    });
});

describe('useChatTimelineController source contracts', () => {
    const source = readFileSync(join(here, 'useChatTimelineController.ts'), 'utf8');

    test('auto-fill is Query-driven (no useEffect fill path)', () => {
        expect(source).toContain('useQuery');
        expect(source).toContain('chatTimelineAutoFillQueryKey');
        // Imperative auto-fill effect must stay gone.
        expect(source).not.toMatch(/React\.useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?fetchOlderHistory/);
        expect(source).not.toMatch(/useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?shouldAutoFillEarlierHistory/);
    });

    test('has-more-above-turns never falls back to !complete (unknown ≠ loadable)', () => {
        expect(source).toContain('export const resolveHasMoreAboveTurns');
        expect(source).toContain('return historyMeta.canLoadEarlier;');
        expect(source).not.toContain(': !historyMeta.complete');
    });

    test('explicit load-earlier is mutation-owned (button busy ≠ historyLoading)', () => {
        expect(source).toContain('useMutation');
        expect(source).toContain('chatTimelineLoadEarlierMutationKey');
        expect(source).toContain('loadEarlierMutation');
        // Button busy must not OR background historyLoading (Relay stuck spinner).
        expect(source).toContain('Never OR historyLoading');
        expect(source).toContain('isLoadingOlderUi');
    });

    test('historyLoading wait gate is historyMeta.loading only (sync/archive, not prefetch)', () => {
        // fetchOlderHistory waits on historySignals.historyLoading derived solely
        // from historyMeta.loading. ChatContainer must not fold prefetch into that
        // field — otherwise a stuck background tail pull blocks user loadMore.
        expect(source).toContain('const historyLoading = Boolean(historyMeta?.loading)');
        expect(source).toContain('waitWhileHistoryLoading');
        expect(source).not.toContain('sessionPrefetch');
        expect(source).not.toContain('prefetchStatus');
    });

    test('user-initiated load-earlier toasts on transport failure (no silent flash)', () => {
        expect(source).toContain("chat.history.loadOlderFailed");
        expect(source).toContain("chat.history.loadOlderTimeout");
        expect(source).toContain('toast.error');
        expect(source).toContain('logChatHistoryLoadOlderFailure');
        // Messages live in the shared logChatHistoryLoadOlderFailure helper, so
        // pin the text rather than the console.error call shape.
        expect(source).toContain("console.error('[chat-history] load older failed'");
        expect(source).toContain(
            "'[chat-history] load older timed out waiting for sync pagination',",
        );
        expect(source).toContain(
            "'[chat-history] load older completed without prepending messages',",
        );
        expect(source).toContain('userInitiated');
        // Failure always console.error; toast stays user-initiated-only.
        expect(source).toContain('grew === false && historySignalsRef.current.canLoadEarlier');
        expect(source).toContain('Always console.error');
        // historyLoading wait timeout throws — never silent-defer toast skip.
        expect(source).toContain('HISTORY_LOADING_TIMEOUT_CODE');
        expect(source).toContain("throw createHistoryLoadingTimeoutError()");
        expect(source).not.toContain('load older deferred');
    });

    test('historyLoading wait covers a full Host turn-page budget', () => {
        // Regression: 15s wait < 30s Host turn-page timeout false-failed load-more
        // while a concurrent sync flight was still legitimate.
        expect(source).toContain('SESSION_TURN_PAGE_TIMEOUT_MS');
        expect(source).toContain('HISTORY_LOADING_WAIT_MS = SESSION_TURN_PAGE_TIMEOUT_MS + 2_000');
        expect(HISTORY_LOADING_WAIT_MS).toBe(SESSION_TURN_PAGE_TIMEOUT_MS + 2_000);
        expect(HISTORY_LOADING_WAIT_MS).toBeGreaterThanOrEqual(SESSION_TURN_PAGE_TIMEOUT_MS);
        expect(source).toContain("wait === 'timeout'");
        expect(source).toContain("wait === 'switched'");
        expect(source).toContain("pagesLoaded -= 1");
        // Wait diagnostics must print the transcript request status so a phantom
        // historyLoading (nothing in Network) is visible in the console.
        expect(source).toContain("waiting for sync pagination to clear");
        expect(source).toContain('likelyStaleLoadingFlag');
        expect(source).toContain('getRequestState');
        expect(source).toContain('requestStatusAtTimeout');
    });

    test('isHistoryLoadingTimeoutError matches typed wait timeout', () => {
        const timeout = Object.assign(new Error('chat history pagination wait timed out'), {
            code: HISTORY_LOADING_TIMEOUT_CODE,
        });
        expect(isHistoryLoadingTimeoutError(timeout)).toBe(true);
        expect(isHistoryLoadingTimeoutError(new Error('network'))).toBe(false);
        expect(isHistoryLoadingTimeoutError(null)).toBe(false);
    });

    test('logChatHistoryLoadOlderFailure always writes console.error', () => {
        const original = console.error;
        const calls: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            calls.push(args);
        };
        try {
            logChatHistoryLoadOlderFailure('no-growth', new Error('no growth'), { sessionId: 'ses_1' });
            logChatHistoryLoadOlderFailure('timeout', new Error('timeout'), { waitMs: 15_000 });
            logChatHistoryLoadOlderFailure('failed', new Error('network'), { sessionId: 'ses_1' });
        } finally {
            console.error = original;
        }
        expect(calls).toHaveLength(3);
        expect(String(calls[0]?.[0])).toContain('completed without prepending messages');
        expect(String(calls[1]?.[0])).toContain('timed out waiting for sync pagination');
        expect(String(calls[2]?.[0])).toContain('load older failed');
    });

    test('no-growth pagination suppresses the load-earlier affordance without a toast', () => {
        expect(source).toContain("if (decision === 'stop-no-growth')");
        expect(source).toContain('setNoGrowthHistoryLimit(exhaustedLimit)');
        expect(source).toContain('blockedAtCurrentHistoryLimit');
        expect(source).toContain('hasMoreAboveTurns: false');
    });

    test('handlers use useEvent; no React.useCallback', () => {
        expect(source).toContain("from '@reactuses/core'");
        expect(source).toContain('useEvent');
        expect(source).not.toContain('React.useCallback');
        expect(source).not.toMatch(/\buseCallback\s*\(/);
    });

    test('DOM sync uses isomorphic layout effects, unmount via useUnmount', () => {
        expect(source).toContain('useIsomorphicLayoutEffect');
        expect(source).toContain('useUnmount');
        expect(source).not.toContain('React.useLayoutEffect');
        expect(source).not.toContain('React.useEffect');
    });
});

const baseHoldAnchorInput = {
    historyVirtualized: true,
    anchorRestored: true,
    heightDelta: 2,
    messages: ['msg_1', 'msg_2'] as readonly string[],
    heldForMessages: null as readonly string[] | null,
} as const;

describe('shouldHoldHistoryViewportAnchor', () => {
    test('never holds: virtualized scroll is TanStack-only (no dual scrollTop writer)', () => {
        // Former policy started a multi-frame hold after virtualized restore;
        // that raced applyScrollAdjustment and yanked the viewport after load-more.
        expect(shouldHoldHistoryViewportAnchor({
            ...baseHoldAnchorInput,
        })).toBe(false);
        expect(shouldHoldHistoryViewportAnchor({
            ...baseHoldAnchorInput,
            historyVirtualized: false,
            heightDelta: 100,
            anchorRestored: true,
        })).toBe(false);
    });
});

describe('virtualized armed-snapshot compensation ownership', () => {
    test('virtualized load-more uses a one-shot keyed-anchor correction after TanStack', () => {
        const source = readFileSync(join(here, 'useChatTimelineController.ts'), 'utf8');
        const snapBlockStart = source.indexOf('// Armed snapshot from loadEarlier');
        const snapBlockEnd = source.indexOf('// Background prepends', snapBlockStart);
        expect(snapBlockStart).toBeGreaterThan(-1);
        expect(snapBlockEnd).toBeGreaterThan(snapBlockStart);
        const snapBlock = source.slice(snapBlockStart, snapBlockEnd);
        const virtualBranchStart = snapBlock.indexOf("if (prependCompensation.owner === 'tanstack-core')");
        const virtualBranchEnd = snapBlock.indexOf('const heightDelta', virtualBranchStart);
        expect(virtualBranchStart).toBeGreaterThan(-1);
        expect(virtualBranchEnd).toBeGreaterThan(virtualBranchStart);
        const virtualBranch = snapBlock.slice(virtualBranchStart, virtualBranchEnd);
        expect(virtualBranch).toContain('cancelViewportAnchorHold');
        // TanStack performs the normal adjustment. This correction is a single
        // keyed write only when its final DOM position still drifted (Android
        // observed y=0 after prepend), so the prior reading position wins.
        expect(virtualBranch).toContain('restoreViewportAnchor(anchor)');
        // A multi-frame hold would fight TanStack measurements.
        expect(virtualBranch).not.toContain('holdViewportAnchor(anchor)');
    });

    test('armed explicit-load snapshots bypass a stale pinned re-pin', () => {
        const source = readFileSync(join(here, 'useChatTimelineController.ts'), 'utf8');
        expect(source).toContain('if (isPinnedRef.current && !snap)');
    });

    test('prepends preserve bottom pin or the reader anchor through their existing owners', () => {
        const source = readFileSync(join(here, 'useChatTimelineController.ts'), 'utf8');
        expect(source).toContain('if (isPinnedRef.current && !snap)');
        expect(source).toContain("if (prependCompensation.owner === 'tanstack-core')");
        expect(source).toContain('restoreViewportAnchor(anchor)');
        expect(source).toContain("goToBottom('instant');");
    });
});

describe('setScrollTopDefeatingMomentum touch-aware compensation', () => {
    const flushFrame = () => new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });

    const makeContainer = () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        attachTouchGestureTracking(container);
        return container;
    };

    test('no touch active: writes immediately (existing behavior)', () => {
        const container = makeContainer();
        container.scrollTop = 100;
        setScrollTopDefeatingMomentum(container, 300, 200);
        expect(container.scrollTop).toBe(300);
        container.remove();
    });

    test('touch active: defers the write, applies at lift-off anchored to the live position', async () => {
        const container = makeContainer();
        container.scrollTop = 500;
        container.dispatchEvent(new Event('touchstart'));

        setScrollTopDefeatingMomentum(container, 700, 200);
        // No mid-gesture write: the pan latch must survive.
        expect(container.scrollTop).toBe(500);

        container.dispatchEvent(new Event('touchend'));
        await flushFrame();

        expect(container.scrollTop).toBe(700);
        container.remove();
    });

    test('deferred batches accumulate against the gesture anchor', async () => {
        const container = makeContainer();
        container.scrollTop = 500;
        container.dispatchEvent(new Event('touchstart'));

        setScrollTopDefeatingMomentum(container, 700, 200);
        setScrollTopDefeatingMomentum(container, 780, 80);

        container.dispatchEvent(new Event('touchend'));
        await flushFrame();

        expect(container.scrollTop).toBe(780);
        container.remove();
    });

    test('user scrolled on before lift-off: deferred compensation is dropped, not yanked', async () => {
        const container = makeContainer();
        container.scrollTop = 500;
        container.dispatchEvent(new Event('touchstart'));

        setScrollTopDefeatingMomentum(container, 700, 200);

        // The user keeps scrolling well past the uncompensated growth.
        container.scrollTop = 1200;
        container.dispatchEvent(new Event('touchend'));
        await flushFrame();

        expect(container.scrollTop).toBe(1200);
        container.remove();
    });
});
