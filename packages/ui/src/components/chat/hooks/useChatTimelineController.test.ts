import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    chatTimelineAutoFillQueryKey,
    isOlderHistoryPrependCommit,
    resolveHistoryPageDecision,
    resolveHistoryPrependCompensation,
    shouldAutoFillEarlierHistory,
    shouldHoldHistoryViewportAnchor,
    shouldLoadEarlierHistory,
} from './useChatTimelineController';

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

    test('explicit load-earlier is mutation-owned (button busy ≠ historyLoading)', () => {
        expect(source).toContain('useMutation');
        expect(source).toContain('chatTimelineLoadEarlierMutationKey');
        expect(source).toContain('loadEarlierMutation');
        // Button busy must not OR background historyLoading (Relay stuck spinner).
        expect(source).toContain('Never OR historyLoading');
        expect(source).toContain('isLoadingOlderUi');
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
    test('load-more snapshot path must defer to tanstack-core when virtualized', () => {
        const source = readFileSync(join(here, 'useChatTimelineController.ts'), 'utf8');
        const snapBlockStart = source.indexOf('// Armed snapshot from loadEarlier');
        const snapBlockEnd = source.indexOf('// Background prepends', snapBlockStart);
        expect(snapBlockStart).toBeGreaterThan(-1);
        expect(snapBlockEnd).toBeGreaterThan(snapBlockStart);
        const snapBlock = source.slice(snapBlockStart, snapBlockEnd);
        expect(snapBlock).toContain("prependCompensation.owner === 'tanstack-core'");
        expect(snapBlock).toContain('cancelViewportAnchorHold');
        // Must not re-enter restore/hold on the virtualized branch.
        expect(snapBlock).not.toContain('holdViewportAnchor(anchor)');
    });
});
