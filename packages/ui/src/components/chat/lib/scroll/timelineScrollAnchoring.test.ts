import { describe, expect, test } from 'vitest';

import {
    CHAT_LIST_ANCHOR_OFFSET,
    didPrependTimelineEntries,
    getAnchoredTurnMetrics,
    isReplyReserveOverflowing,
    resolveChatListAnchoredEndSpace,
    resolveNextAnchoredUserMessageId,
    CHAT_REPLY_RESERVE_MAX_VIEWPORT_RATIO,
    resolveReplyReserveMaxHeight,
    resolveReplyReserveSpacerHeight,
    resolveReplyReserveUpdate,
    resolveShrunkItemSizeUpdate,
    resolveTimelineDistanceFromEnd,
    resolveTimelineIsAtEnd,
    resolveTimelineScrollButtonVisible,
    resolveUsableViewportHeight,
    shouldReleaseAnchoredTurnPark,
    TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
    TIMELINE_SCROLL_BUTTON_SHOW_THRESHOLD_PX,
    type TimelineListMeasurementState,
} from './timelineScrollAnchoring';

const createMeasurementState = (
    rows: readonly { readonly top: number; readonly height: number }[],
    scroll = 0,
    scrollLength = 400,
): TimelineListMeasurementState => ({
    data: rows,
    scroll,
    scrollLength,
    positionAtIndex: (index) => rows[index]?.top,
    sizeAtIndex: (index) => rows[index]?.height,
});

describe('didPrependTimelineEntries', () => {
    test('older history inserted above the read position is a prepend', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['a', 'b', 'c', 'd'])).toBe(true);
    });

    test('the streaming tail appending is not', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['c', 'd', 'e'])).toBe(false);
    });

    test('a live tail entry being replaced in place is not', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['c', 'd:2'])).toBe(false);
    });

    // Both ends can move in one commit: a prepend lands while the tail streams.
    test('a prepend that arrives with tail growth still counts', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['a', 'b', 'c', 'd', 'e'])).toBe(true);
    });

    test('switching sessions replaces every key and is not a prepend', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['x', 'y', 'z'])).toBe(false);
    });

    test('the first entries of an empty timeline are not a prepend', () => {
        expect(didPrependTimelineEntries([], ['a', 'b'])).toBe(false);
    });
});

describe('getAnchoredTurnMetrics', () => {
    test('a short turn does not overflow and must not scroll backwards', () => {
        const state = createMeasurementState(
            [{ top: 1000, height: 80 }],
            984,
            400,
        );
        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 0,
            composerOverlayHeight: 0,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
        expect(metrics).not.toBeNull();
        expect(metrics?.turnHeight).toBe(80);
        expect(metrics?.usableViewportHeight).toBe(384);
        expect(metrics?.overflowsUsableViewport).toBe(false);
        expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
    });

    test('a turn that outgrows the usable viewport reveals only the overflow', () => {
        const state = createMeasurementState(
            [{ top: 1000, height: 480 }],
            984,
            400,
        );
        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 0,
            composerOverlayHeight: 0,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
        expect(metrics).not.toBeNull();
        expect(metrics?.overflowsUsableViewport).toBe(true);
        expect(metrics?.targetScrollToRevealEnd).toBe(1096);
        expect(metrics?.scrollDeltaToRevealEnd).toBe(112);
    });

    test('a trailing reserve item is excluded from turn height', () => {
        const state = createMeasurementState(
            [
                { top: 1000, height: 80 },
                { top: 1080, height: 700 },
            ],
            984,
            400,
        );
        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 0,
            lastIndex: 0,
            composerOverlayHeight: 0,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
        expect(metrics?.turnHeight).toBe(80);
        expect(metrics?.overflowsUsableViewport).toBe(false);
    });

    test('composer overlay shrinks the usable viewport', () => {
        const state = createMeasurementState(
            [{ top: 0, height: 200 }],
            0,
            400,
        );
        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 0,
            composerOverlayHeight: 120,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
        expect(metrics?.usableViewportHeight).toBe(264);
        expect(metrics?.overflowsUsableViewport).toBe(false);
    });
});

describe('resolveChatListAnchoredEndSpace', () => {
    const items = [
        { id: 'older' },
        { id: 'live' },
        { id: 'live' },
    ];
    const getId = (item: { id: string }) => item.id;

    test('finds the last matching row so a retry parks the live copy', () => {
        expect(resolveChatListAnchoredEndSpace(items, 'live', getId)).toEqual({
            anchorIndex: 2,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
            anchorId: 'live',
        });
    });

    test('returns nothing when the id is missing or null', () => {
        expect(resolveChatListAnchoredEndSpace(items, 'missing', getId)).toBeUndefined();
        expect(resolveChatListAnchoredEndSpace(items, null, getId)).toBeUndefined();
    });
});

describe('resolveNextAnchoredUserMessageId', () => {
    test('a consumed send parks that message', () => {
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            currentAnchorId: 'a',
            consumedSendMessageId: 'b',
        })).toBe('b');
    });

    test('a session swap drops the park unless a send landed in the same paint', () => {
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: true,
            previousUserOrder: ['a'],
            currentUserOrder: ['x'],
            currentAnchorId: 'a',
            consumedSendMessageId: null,
        })).toBeNull();
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['new'],
            currentAnchorId: null,
            consumedSendMessageId: 'new',
        })).toBe('new');
    });

    test('keeps the park while the id is still in the user order', () => {
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: ['older', 'a', 'b'],
            currentAnchorId: 'b',
            consumedSendMessageId: null,
        })).toBe('b');
    });

    test('follows a same-length replacement of the last user row', () => {
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: false,
            previousUserOrder: ['a', 'optimistic'],
            currentUserOrder: ['a', 'authoritative'],
            currentAnchorId: 'optimistic',
            consumedSendMessageId: null,
        })).toBe('authoritative');
    });

    test('keeps the park across a transient hole in the user order', () => {
        expect(resolveNextAnchoredUserMessageId({
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: ['a'],
            currentAnchorId: 'b',
            consumedSendMessageId: null,
        })).toBe('b');
    });
});

describe('resolveUsableViewportHeight', () => {
    test('subtracts the composer overlay and park offset', () => {
        expect(resolveUsableViewportHeight({
            viewportHeight: 800,
            composerOverlayHeight: 0,
        })).toBe(800 - CHAT_LIST_ANCHOR_OFFSET);
        expect(resolveUsableViewportHeight({
            viewportHeight: 800,
            composerOverlayHeight: 120,
        })).toBe(800 - 120 - CHAT_LIST_ANCHOR_OFFSET);
    });

    test('ignores an unmeasured viewport', () => {
        expect(resolveUsableViewportHeight({
            viewportHeight: 0,
            composerOverlayHeight: 0,
        })).toBe(0);
        expect(resolveUsableViewportHeight({
            viewportHeight: Number.NaN,
            composerOverlayHeight: 0,
        })).toBe(0);
    });
});

describe('resolveReplyReserveSpacerHeight', () => {
    const viewport = 800;
    const usable = 784;
    const cap = resolveReplyReserveMaxHeight(viewport);

    test('the hole never exceeds 60% of the list viewport', () => {
        expect(CHAT_REPLY_RESERVE_MAX_VIEWPORT_RATIO).toBe(0.6);
        expect(cap).toBe(480);
    });

    test('unmeasured content reserves the capped hole', () => {
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: null,
        })).toBe(cap);
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: 0,
        })).toBe(cap);
    });

    test('measured content keeps leftover only up to the cap', () => {
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: 200,
        })).toBe(cap);
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: 400,
        })).toBe(384);
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: 784,
        })).toBe(0);
        expect(resolveReplyReserveSpacerHeight({
            usableViewportHeight: usable,
            viewportHeight: viewport,
            contentHeight: 900,
        })).toBe(0);
    });
});

describe('isReplyReserveOverflowing', () => {
    test('content still inside the reserved box is not overflow', () => {
        expect(isReplyReserveOverflowing(200, 784)).toBe(false);
        expect(isReplyReserveOverflowing(784, 784)).toBe(false);
        expect(isReplyReserveOverflowing(785, 784)).toBe(false);
    });

    test('content that outgrows the reserved box is overflow', () => {
        expect(isReplyReserveOverflowing(786, 784)).toBe(true);
        expect(isReplyReserveOverflowing(1200, 784)).toBe(true);
    });

    test('no reserve means no overflow', () => {
        expect(isReplyReserveOverflowing(1200, 0)).toBe(false);
    });
});

describe('resolveReplyReserveUpdate', () => {
    const usable = 784;
    const viewport = 800;
    const cap = resolveReplyReserveMaxHeight(viewport);

    test('a new send latches a capped spacer until the turn measures', () => {
        expect(resolveReplyReserveUpdate({
            previous: null,
            reserveId: 'user-1',
            entryKey: 'msg:user-1',
            contentHeight: null,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        })).toEqual({
            release: false,
            snapshot: {
                reserveId: 'user-1',
                entryKey: 'msg:user-1',
                contentHeight: null,
                spacerHeight: cap,
            },
        });
    });

    test('growth consumes the spacer and never writes the turn taller', () => {
        const afterFirstMeasure = resolveReplyReserveUpdate({
            previous: null,
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 200,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(afterFirstMeasure.release).toBe(false);
        expect(afterFirstMeasure.snapshot.spacerHeight).toBe(cap);

        const afterGrowth = resolveReplyReserveUpdate({
            previous: afterFirstMeasure.snapshot,
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 400,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(afterGrowth.release).toBe(false);
        expect(afterGrowth.snapshot.spacerHeight).toBe(384);
        expect(afterGrowth.snapshot.contentHeight).toBe(400);
    });

    test('the optimistic row becoming a turn relatches instead of releasing', () => {
        const optimistic = resolveReplyReserveUpdate({
            previous: null,
            reserveId: 'user-1',
            entryKey: 'msg:user-1',
            contentHeight: 80,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        }).snapshot;
        const grouped = resolveReplyReserveUpdate({
            previous: optimistic,
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 80,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(grouped.release).toBe(false);
        expect(grouped.snapshot.entryKey).toBe('turn:1');
        expect(grouped.snapshot.spacerHeight).toBe(cap);
    });

    test('a same-row collapse that would reopen the spacer drops the park', () => {
        const consumed = resolveReplyReserveUpdate({
            previous: {
                reserveId: 'user-1',
                entryKey: 'turn:1',
                contentHeight: 780,
                spacerHeight: 4,
            },
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 120,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(consumed.release).toBe(true);
        expect(consumed.snapshot.spacerHeight).toBe(0);
    });

    test('a taller usable viewport keeps filling the hole instead of releasing', () => {
        const parked = resolveReplyReserveUpdate({
            previous: null,
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 200,
            usableViewportHeight: 500,
            viewportHeight: 516,
        }).snapshot;
        const afterKeyboardDismiss = resolveReplyReserveUpdate({
            previous: parked,
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 200,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(afterKeyboardDismiss.release).toBe(false);
        expect(afterKeyboardDismiss.snapshot.spacerHeight).toBe(cap);
    });

    test('content that outgrows the usable viewport drops the park', () => {
        const overflow = resolveReplyReserveUpdate({
            previous: {
                reserveId: 'user-1',
                entryKey: 'turn:1',
                contentHeight: 700,
                spacerHeight: 84,
            },
            reserveId: 'user-1',
            entryKey: 'turn:1',
            contentHeight: 900,
            usableViewportHeight: usable,
            viewportHeight: viewport,
        });
        expect(overflow.release).toBe(true);
        expect(overflow.snapshot.spacerHeight).toBe(0);
    });
});

describe('shouldReleaseAnchoredTurnPark', () => {
    test('keeps the park while reserved tail is consumed by growing content', () => {
        expect(shouldReleaseAnchoredTurnPark({
            previousEndSpaceSize: 320,
            nextEndSpaceSize: 40,
        })).toBe(false);
        expect(shouldReleaseAnchoredTurnPark({
            previousEndSpaceSize: 40,
            nextEndSpaceSize: 0,
        })).toBe(false);
    });

    test('drops the park when collapse would reopen the reserved tail', () => {
        expect(shouldReleaseAnchoredTurnPark({
            previousEndSpaceSize: 0,
            nextEndSpaceSize: 360,
        })).toBe(true);
        expect(shouldReleaseAnchoredTurnPark({
            previousEndSpaceSize: 40,
            nextEndSpaceSize: 280,
        })).toBe(true);
    });

    test('drops the park once the turn overflows the usable viewport', () => {
        expect(shouldReleaseAnchoredTurnPark({
            overflowsUsableViewport: true,
            previousEndSpaceSize: 80,
            nextEndSpaceSize: 40,
        })).toBe(true);
    });

    test('does not drop on the first measured size', () => {
        expect(shouldReleaseAnchoredTurnPark({
            nextEndSpaceSize: 360,
        })).toBe(false);
    });
});

describe('resolveShrunkItemSizeUpdate', () => {
    test('writes when a measured row is shorter than its cached size', () => {
        expect(resolveShrunkItemSizeUpdate(1200, 96)).toBe(96);
    });

    test('ignores growth, first measure, and noise', () => {
        expect(resolveShrunkItemSizeUpdate(96, 1200)).toBeNull();
        expect(resolveShrunkItemSizeUpdate(undefined, 96)).toBeNull();
        expect(resolveShrunkItemSizeUpdate(96, 96)).toBeNull();
        expect(resolveShrunkItemSizeUpdate(96, 95.5)).toBeNull();
        expect(resolveShrunkItemSizeUpdate(96, 0)).toBeNull();
    });
});

describe('resolveTimelineScrollButtonVisible', () => {
    test('stays hidden until the viewport has travelled past the show band', () => {
        expect(resolveTimelineDistanceFromEnd({
            contentLength: 1000,
            scroll: 560,
            scrollLength: 400,
        })).toBe(40);
        expect(resolveTimelineIsAtEnd({
            contentLength: 1000,
            scroll: 560,
            scrollLength: 400,
        })).toBe(true);

        expect(resolveTimelineScrollButtonVisible(0, false)).toBe(false);
        expect(resolveTimelineScrollButtonVisible(TIMELINE_FOLLOW_REARM_THRESHOLD_PX, false)).toBe(false);
        expect(resolveTimelineScrollButtonVisible(
            TIMELINE_FOLLOW_REARM_THRESHOLD_PX + 1,
            false,
        )).toBe(false);
        expect(resolveTimelineScrollButtonVisible(
            TIMELINE_SCROLL_BUTTON_SHOW_THRESHOLD_PX,
            false,
        )).toBe(true);
    });

    test('once shown, stays visible until the follow re-arm band', () => {
        expect(resolveTimelineScrollButtonVisible(50, true)).toBe(true);
        expect(resolveTimelineScrollButtonVisible(TIMELINE_FOLLOW_REARM_THRESHOLD_PX, true)).toBe(false);
        expect(resolveTimelineScrollButtonVisible(undefined, true)).toBe(true);
    });
});
