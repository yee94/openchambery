// Anchored-turn scroll geometry for the chat timeline.
//
// The timeline has three mutually exclusive scroll modes:
//
//   • `following-end`      — stay pinned to the live edge as content grows.
//   • `anchoring-new-turn` — the just-sent user message is parked near the TOP
//     of the viewport and the reply streams into reserved space below it. The
//     viewport does NOT move until the turn outgrows the usable viewport.
//   • `free-scrolling`     — the user took over; nothing moves the scroll
//     position until they opt back in.
//
// This module is pure geometry: it reads measurements from the virtualized
// list and answers "how far, if at all, must we scroll to reveal the end of
// the anchored turn". Keeping it free of DOM and React makes the mode machine
// testable without a renderer.
//
// "Usable viewport" is the middle visible window on an immersive page:
// list height minus the measured header (safe area + floating nav), minus
// the measured footer (Composer reservation + tail spacer), minus the park
// fade when no header has been measured. That window is the leftover the
// hole may fill. The hole itself is capped at 40% of the list viewport — a
// 60% leftover of the full immersive scroller was half the phone.
//
// Send latches the just-sent user message and TimelineList drives
// `anchoring-new-turn`. Occupancy is a sibling spacer AFTER the last turn,
// not a minHeight on the turn itself — collapse, hydration, and streaming
// keep writing that row's natural height. The spacer starts as
// `usableViewport - content` and only shrinks; a later collapse that would
// reopen it drops the reserve instead. Overflow also drops it and returns
// to `following-end`. Jump-to-latest returns to the parked edge and keeps
// the hole.
//
// The parked edge is bounded by the scroll range that exists, never the
// offset the anchor would like (`resolveParkedLiveEdgeOffset`). Nothing here
// pulls the viewport back to that edge either: the hole makes the edge the end
// of the content, so the scroller's own bounds hold the position and a touch
// surface keeps its native rubber-band. A per-frame correction toward the edge
// reads `scrollTop` past the maximum mid-bounce on iOS and writes scroll under
// a live gesture, which is felt as the transcript fighting the finger.

export type TimelineScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling';

// Distance from the top of the viewport at which an anchored user message
// parks. Small enough to read as "at the top", large enough not to collide
// with the timeline's top fade.
export const CHAT_LIST_ANCHOR_OFFSET = 16;

/**
 * Blank hole under the parked turn, as a fraction of the list viewport
 * (full-screen on immersive mobile). The middle chat window after chrome
 * is subtracted is typically at or under this.
 */
export const CHAT_REPLY_RESERVE_MAX_VIEWPORT_RATIO = 0.4;

export const resolveReplyReserveMaxHeight = (viewportHeight: number): number => {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
    return viewportHeight * CHAT_REPLY_RESERVE_MAX_VIEWPORT_RATIO;
};

/**
 * Where the just-sent row parks. On immersive mobile the measured list
 * header (safe area + nav spacer) is that offset; otherwise the fade gap.
 */
export const resolveParkAnchorOffset = (
    startInsetHeight: number,
    fallback = CHAT_LIST_ANCHOR_OFFSET,
): number => {
    if (Number.isFinite(startInsetHeight) && startInsetHeight > 0) return startInsetHeight;
    return fallback;
};

/**
 * The middle window a parked turn may fill.
 *
 * `endInsetHeight` is the list's measured footer, which is where the bottom
 * chrome reservation lives on this path: the Composer occupancy plus the tail
 * spacer are inside it. There is deliberately no second overlay term — a
 * floating composer the list cannot measure would have to become part of that
 * footer, not a parallel number that only one of these callers remembers to
 * pass.
 */
export const resolveUsableViewportHeight = ({
    viewportHeight,
    endInsetHeight = 0,
    anchorOffset = CHAT_LIST_ANCHOR_OFFSET,
}: {
    readonly viewportHeight: number;
    readonly endInsetHeight?: number;
    readonly anchorOffset?: number;
}): number => {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
    const inset = Number.isFinite(endInsetHeight) ? Math.max(0, endInsetHeight) : 0;
    return Math.max(0, viewportHeight - inset - anchorOffset);
};

/**
 * Extra scroll range below a parked user row.
 *
 * Zero when the spacer used the footer-aware leftover
 * (`usable = viewport - overlay - footer - offset`). A positive value is
 * the downward room that used to hide Changes and flash scroll-to-bottom
 * after send.
 */
export const resolveParkedScrollSlack = ({
    contentHeight,
    spacerHeight,
    endInsetHeight,
    viewportHeight,
    anchorOffset = CHAT_LIST_ANCHOR_OFFSET,
}: {
    readonly contentHeight: number;
    readonly spacerHeight: number;
    readonly endInsetHeight: number;
    readonly viewportHeight: number;
    readonly anchorOffset?: number;
}): number => {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
    return Math.max(
        0,
        contentHeight + spacerHeight + endInsetHeight - viewportHeight + anchorOffset,
    );
};

/**
 * Furthest the scroller can actually travel: content beyond the viewport.
 *
 * `null` when the list has not reported both numbers, which is not the same as
 * "no room" — a caller must not read an unmeasured list as pinned.
 */
export const resolveMaxScrollOffset = (state: {
    readonly contentLength?: number;
    readonly scrollLength?: number;
}): number | null => {
    const { contentLength, scrollLength } = state;
    if (typeof contentLength !== 'number' || typeof scrollLength !== 'number') return null;
    if (!Number.isFinite(contentLength) || !Number.isFinite(scrollLength)) return null;
    return Math.max(0, contentLength - scrollLength);
};

/**
 * Content offset where the parked user row sits `anchorOffset` from the top.
 *
 * Bounded by the room that actually exists. The hole under the parked row is
 * capped at a fraction of the viewport, so it is routinely smaller than the
 * window the anchor offset asks for: on a phone the first frames of a reply
 * leave the scroller tens of pixels short of the ideal offset. Publishing the
 * ideal there made the platform silently clamp the park scroll and then report
 * the resting viewport as dozens of pixels from its own live edge — far enough
 * to raise the scroll-to-bottom control at rest and to withhold the at-end
 * re-arm, until the reply grew enough to close the gap and both flipped. The
 * live edge is therefore whichever comes first, the ideal or the end of the
 * scroll range.
 */
export const resolveParkedLiveEdgeOffset = ({
    anchorTop,
    anchorOffset = CHAT_LIST_ANCHOR_OFFSET,
    maxScrollOffset,
}: {
    readonly anchorTop: number;
    readonly anchorOffset?: number;
    readonly maxScrollOffset?: number | null;
}): number => {
    const ideal = Math.max(0, anchorTop - anchorOffset);
    if (typeof maxScrollOffset !== 'number' || !Number.isFinite(maxScrollOffset)) return ideal;
    return Math.min(ideal, Math.max(0, maxScrollOffset));
};

/**
 * Distance from the parked live edge. Slack below that offset (composer
 * inset sitting under the hole) is still "at the bottom".
 */
export const resolveTimelineDistanceFromParkedEnd = ({
    scroll,
    parkOffset,
}: {
    readonly scroll: number;
    readonly parkOffset: number;
}): number => {
    if (!Number.isFinite(scroll) || !Number.isFinite(parkOffset)) return 0;
    return Math.max(0, parkOffset - scroll);
};

/**
 * Written on the timeline scroller while a send is reserved. Composer swap
 * and jump-to-latest read it so the parked row — not `scrollHeight` — is
 * the live edge.
 */
export const TIMELINE_PARK_END_ATTRIBUTE = 'data-oc-timeline-park-end';

export const readTimelineParkEndOffset = (
    element: HTMLElement | null | undefined,
): number | null => {
    if (!element) return null;
    const raw = element.getAttribute(TIMELINE_PARK_END_ATTRIBUTE);
    if (raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

export const writeTimelineParkEndOffset = (
    element: HTMLElement | null | undefined,
    parkOffset: number | null,
): void => {
    if (!element) return;
    if (parkOffset === null || !Number.isFinite(parkOffset)) {
        if (element.hasAttribute(TIMELINE_PARK_END_ATTRIBUTE)) {
            element.removeAttribute(TIMELINE_PARK_END_ATTRIBUTE);
        }
        return;
    }
    const next = String(Math.round(parkOffset));
    if (element.getAttribute(TIMELINE_PARK_END_ATTRIBUTE) !== next) {
        element.setAttribute(TIMELINE_PARK_END_ATTRIBUTE, next);
    }
};

/** DOM distance from the live edge, remapped onto the park when reserved. */
export const resolveScrollDistanceFromLiveEdge = (
    geometry: {
        readonly scrollHeight: number;
        readonly scrollTop: number;
        readonly clientHeight: number;
    },
    parkOffset: number | null,
): number => {
    if (parkOffset !== null && Number.isFinite(parkOffset)) {
        return resolveTimelineDistanceFromParkedEnd({
            scroll: geometry.scrollTop,
            parkOffset,
        });
    }
    return Math.max(0, geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight);
};

/**
 * Sibling spacer after the last turn (user + live status). Unmeasured
 * content still gets the capped hole so the first paint can park. Once
 * the turn reports a natural height, the spacer is the leftover, never
 * more than 40% of the list viewport.
 */
export const resolveReplyReserveSpacerHeight = ({
    usableViewportHeight,
    viewportHeight,
    contentHeight,
}: {
    readonly usableViewportHeight: number;
    readonly viewportHeight: number;
    readonly contentHeight: number | null;
}): number => {
    if (!Number.isFinite(usableViewportHeight) || usableViewportHeight <= 0) return 0;
    const maxHole = resolveReplyReserveMaxHeight(
        Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : usableViewportHeight,
    );
    const cap = maxHole > 0 ? Math.min(usableViewportHeight, maxHole) : usableViewportHeight;
    if (contentHeight === null || !Number.isFinite(contentHeight) || contentHeight <= 0) {
        return cap;
    }
    return Math.min(cap, Math.max(0, usableViewportHeight - contentHeight));
};

export const isReplyReserveOverflowing = (
    contentHeight: number,
    usableViewportHeight: number,
): boolean => {
    if (!Number.isFinite(contentHeight) || !Number.isFinite(usableViewportHeight)) return false;
    if (usableViewportHeight <= 0) return false;
    return contentHeight > usableViewportHeight + 1;
};

export type ReplyReserveSnapshot = {
    readonly reserveId: string;
    readonly entryKey: string;
    readonly contentHeight: number | null;
    readonly spacerHeight: number;
};

/**
 * Drop the reserved spacer once real content has consumed it, or once a later
 * shrink would reopen it.
 *
 * The spacer is `min(usableViewport - turnNaturalHeight, 40% viewport)`.
 * A long streaming turn drives that leftover to 0; collapsed activity then
 * shortens the same row and the leftover comes back as blank space under
 * the transcript. Overflow is the same moment we start revealing the live
 * edge — keeping the reserve after that only exists to restore padding on
 * shrink.
 */
export const shouldReleaseAnchoredTurnPark = ({
    overflowsUsableViewport = false,
    previousEndSpaceSize,
    nextEndSpaceSize,
}: {
    readonly overflowsUsableViewport?: boolean;
    readonly previousEndSpaceSize?: number;
    readonly nextEndSpaceSize?: number;
}): boolean => {
    if (overflowsUsableViewport) return true;
    if (
        previousEndSpaceSize === undefined
        || nextEndSpaceSize === undefined
        || !Number.isFinite(previousEndSpaceSize)
        || !Number.isFinite(nextEndSpaceSize)
    ) {
        return false;
    }
    return nextEndSpaceSize > previousEndSpaceSize + 1;
};

/**
 * Owns the reserved spacer. The last turn's height is an input, never a
 * write target: a new row key relatches, growth consumes the spacer, and a
 * same-row shrink that would reopen it (collapsed activity) drops the park.
 */
export const resolveReplyReserveUpdate = ({
    previous,
    reserveId,
    entryKey,
    contentHeight,
    usableViewportHeight,
    viewportHeight,
}: {
    readonly previous: ReplyReserveSnapshot | null;
    readonly reserveId: string;
    readonly entryKey: string;
    readonly contentHeight: number | null;
    readonly usableViewportHeight: number;
    readonly viewportHeight: number;
}): { readonly snapshot: ReplyReserveSnapshot; readonly release: boolean } => {
    const nextSpacer = resolveReplyReserveSpacerHeight({
        usableViewportHeight,
        viewportHeight,
        contentHeight,
    });
    const overflows = contentHeight !== null
        && isReplyReserveOverflowing(contentHeight, usableViewportHeight);
    const snapshot: ReplyReserveSnapshot = {
        reserveId,
        entryKey,
        contentHeight,
        spacerHeight: overflows ? 0 : nextSpacer,
    };

    if (overflows) {
        return { snapshot, release: true };
    }

    const sameRow = previous !== null
        && previous.reserveId === reserveId
        && previous.entryKey === entryKey;
    if (!sameRow) {
        return { snapshot, release: false };
    }

    // Only a content shrink (collapsed activity) may reopen leftover space.
    // A taller usable viewport — keyboard dismiss, rotate — must keep filling
    // the new hole instead of dropping the park.
    const contentShrank = previous.contentHeight !== null
        && contentHeight !== null
        && contentHeight + 1 < previous.contentHeight;
    if (contentShrank && shouldReleaseAnchoredTurnPark({
        previousEndSpaceSize: previous.spacerHeight,
        nextEndSpaceSize: nextSpacer,
    })) {
        return {
            snapshot: { ...snapshot, spacerHeight: 0 },
            release: true,
        };
    }

    return { snapshot, release: false };
};

export interface TimelineListMeasurementState {
    readonly data: readonly unknown[];
    readonly scroll: number;
    readonly scrollLength: number;
    /** Total content extent, used to bound the parked edge by real scroll room. */
    readonly contentLength?: number;
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
    readonly anchorTop: number;
    readonly lastBottom: number;
    readonly turnHeight: number;
    readonly usableViewportHeight: number;
    readonly visibleUsableBottom: number;
    readonly overflowsUsableViewport: boolean;
    readonly targetScrollToRevealEnd: number;
    readonly scrollDeltaToRevealEnd: number;
}

export const getRowBottom = (
    state: TimelineListMeasurementState,
    index: number,
): number | null => {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
        typeof top !== 'number'
        || typeof height !== 'number'
        || !Number.isFinite(top)
        || !Number.isFinite(height)
    ) {
        return null;
    }
    // Rows measured at zero height would make an anchored turn look empty and
    // suppress the reveal scroll; treat them as one pixel tall instead.
    return top + Math.max(1, height);
};

export const getAnchoredTurnMetrics = ({
    state,
    anchorIndex,
    endInsetHeight,
    anchorOffset,
    lastIndex,
}: {
    readonly state: TimelineListMeasurementState;
    readonly anchorIndex: number;
    readonly endInsetHeight: number;
    readonly anchorOffset: number;
    readonly lastIndex?: number;
}): AnchoredTurnMetrics | null => {
    if (state.data.length === 0) return null;

    const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
    const anchorTop = state.positionAtIndex(boundedAnchorIndex);
    // Last CONTENT row, not a trailing reserve item and not the full content
    // length: targeting the reserved tail would scroll the real turn off the
    // top, and including it would make every parked turn look viewport-tall.
    const resolvedLastIndex = Math.max(
        0,
        Math.min(lastIndex ?? state.data.length - 1, state.data.length - 1),
    );
    const lastBottom = getRowBottom(state, resolvedLastIndex);
    if (typeof anchorTop !== 'number' || !Number.isFinite(anchorTop) || lastBottom === null) {
        return null;
    }

    const usableViewportHeight = resolveUsableViewportHeight({
        viewportHeight: state.scrollLength,
        endInsetHeight,
        anchorOffset,
    });
    const turnHeight = Math.max(0, lastBottom - anchorTop);
    const visibleUsableBottom = state.scroll + usableViewportHeight;
    const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
    // Never negative: revealing the end must not scroll the timeline backwards.
    const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

    return {
        anchorTop,
        lastBottom,
        turnHeight,
        usableViewportHeight,
        visibleUsableBottom,
        overflowsUsableViewport: turnHeight > usableViewportHeight,
        targetScrollToRevealEnd,
        scrollDeltaToRevealEnd,
    };
};

// "At the end" for follow purposes is a tight band, not the list's isNearEnd
// (half a viewport): that band hid the scroll-to-bottom pill and re-armed
// follow while the user had genuinely scrolled away, yanking them back on the
// next stream chunk. Distance is measured against the parked offset while a
// send is reserved (`data-oc-timeline-park-end`), otherwise against the full
// content length. Slack below the parked row is still the live edge.
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;
/**
 * Scroll-to-bottom stays hidden until the viewport has travelled this far
 * from the live edge. The follow re-arm band is tighter so a small nudge
 * does not flash the pill the way `!isAtEnd` would.
 */
export const TIMELINE_SCROLL_BUTTON_SHOW_THRESHOLD_PX = 80;

export const resolveTimelineIsAtEnd = (
    state: {
        readonly contentLength?: number;
        readonly scroll?: number;
        readonly scrollLength?: number;
        readonly isNearEnd?: boolean;
        readonly isAtEnd?: boolean;
    } | undefined,
): boolean | undefined => {
    if (!state) return undefined;
    const { contentLength, scroll, scrollLength } = state;
    if (
        typeof contentLength === 'number'
        && typeof scroll === 'number'
        && typeof scrollLength === 'number'
        && Number.isFinite(contentLength)
    ) {
        return contentLength - (scroll + scrollLength) <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
    }
    return state.isNearEnd ?? state.isAtEnd;
};

export const resolveTimelineDistanceFromEnd = (
    state: {
        readonly contentLength?: number;
        readonly scroll?: number;
        readonly scrollLength?: number;
    } | undefined,
): number | undefined => {
    if (!state) return undefined;
    const { contentLength, scroll, scrollLength } = state;
    if (
        typeof contentLength !== 'number'
        || typeof scroll !== 'number'
        || typeof scrollLength !== 'number'
        || !Number.isFinite(contentLength)
        || !Number.isFinite(scroll)
        || !Number.isFinite(scrollLength)
    ) {
        return undefined;
    }
    return Math.max(0, contentLength - (scroll + scrollLength));
};

export const resolveTimelineScrollButtonVisible = (
    distanceFromEnd: number | undefined,
    previousVisible: boolean,
): boolean => {
    if (distanceFromEnd === undefined || !Number.isFinite(distanceFromEnd)) {
        return previousVisible;
    }
    if (distanceFromEnd <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX) return false;
    if (distanceFromEnd >= TIMELINE_SCROLL_BUTTON_SHOW_THRESHOLD_PX) return true;
    return previousVisible;
};

/**
 * True when `next` is `previous` with older entries inserted at the head.
 *
 * The head key changing is the cheap gate: a streaming chunk replaces the tail
 * entry and leaves the head alone, so the linear membership check below only
 * runs for a head change on a list that also grew — a prepend or a session
 * swap, not a per-chunk cost.
 */
export const didPrependTimelineEntries = (
    previous: readonly string[],
    next: readonly string[],
): boolean => {
    if (previous.length === 0 || next.length <= previous.length) return false;
    const previousHead = previous[0];
    if (previousHead === undefined || next[0] === previousHead) return false;
    // A swap to a different session replaces every key; a prepend keeps the old
    // head somewhere below the inserted block.
    return next.includes(previousHead);
};

/**
 * Written on the timeline's scroll element while a prepend is being absorbed.
 *
 * The transcript's scroll position is moved by the list itself across several
 * frames here, so DOM-level scroll observers that infer user intent from the
 * scroll geometry (the mobile composer swap) have to know to sit this out.
 * An attribute rather than a prop: those observers hold the scroll element, not
 * a path through the component tree.
 */
export const TIMELINE_ANCHORING_ATTRIBUTE = 'data-oc-timeline-anchoring';

/**
 * How long after a prepend the list keeps compensating for size changes.
 *
 * Long enough to cover the newly mounted rows replacing their estimated
 * heights with measured ones (including the deferred Markdown hydration that
 * follows), short enough that ordinary in-place growth is back to growing
 * downward well before the user's next gesture.
 */
export const TIMELINE_PREPEND_SETTLE_MS = 1200;

export interface ChatListAnchoredEndSpace {
    readonly anchorIndex: number;
    readonly anchorOffset: number;
    readonly anchorId: string;
}

// Finds the anchored row from the BACK of the list: a retried or re-sent
// message id can appear more than once, and the live one is always the last.
export const resolveChatListAnchoredEndSpace = <Item, AnchorId extends string>(
    items: readonly Item[],
    anchorId: AnchorId | null,
    getAnchorId: (item: Item) => AnchorId | null,
    options: { readonly anchorOffset?: number } = {},
): ChatListAnchoredEndSpace | undefined => {
    if (anchorId === null) return undefined;

    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item !== undefined && getAnchorId(item) === anchorId) {
            return {
                anchorIndex: index,
                anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
                anchorId,
            };
        }
    }

    return undefined;
};

/**
 * Next parked user-message id after a transcript update.
 *
 * A consumed send always wins (including a send that lands as the first paint
 * of a new session). Otherwise a session swap drops the park; an id that is
 * still in the user order is kept; a same-length replacement of the last user
 * row (optimistic id → authoritative id) follows the new last id.
 */
export const resolveNextAnchoredUserMessageId = ({
    sessionChanged,
    previousUserOrder,
    currentUserOrder,
    currentAnchorId,
    consumedSendMessageId,
}: {
    readonly sessionChanged: boolean;
    readonly previousUserOrder: readonly string[];
    readonly currentUserOrder: readonly string[];
    readonly currentAnchorId: string | null;
    readonly consumedSendMessageId: string | null;
}): string | null => {
    if (consumedSendMessageId !== null) return consumedSendMessageId;
    if (sessionChanged) return null;
    if (currentAnchorId === null) return null;
    if (currentUserOrder.includes(currentAnchorId)) return currentAnchorId;

    const previousLast = previousUserOrder[previousUserOrder.length - 1];
    const currentLast = currentUserOrder[currentUserOrder.length - 1];
    if (
        currentAnchorId === previousLast
        && currentLast !== undefined
        && currentUserOrder.length === previousUserOrder.length
        && previousUserOrder.length > 0
    ) {
        return currentLast;
    }

    // A transient hole (optimistic row briefly missing) must not drop the
    // park — the next authoritative paint still owns the same send.
    return currentAnchorId;
};

/**
 * Known virtualizer height that is still taller than the live DOM. Returning
 * null means "do not write" — growth and first measure stay with the list.
 */
export const resolveShrunkItemSizeUpdate = (
    knownSize: number | undefined,
    measuredHeight: number,
): number | null => {
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return null;
    if (typeof knownSize !== 'number' || !Number.isFinite(knownSize)) return null;
    if (measuredHeight + 1 >= knownSize) return null;
    return measuredHeight;
};
