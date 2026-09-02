// Explicit read-position anchor for history prepends.
//
// The list already restores content position across a prepend, but it picks its
// own anchor: on a data change it uses the first row in view, and on the size
// frames that follow it uses the first row in view *unfiltered*. Loading older
// history is exactly the case where that choice is wrong — the user taps the
// control at the very top of the transcript, so the rows that land above them
// become the first rows in view, and they land at their ESTIMATED heights. The
// list then holds an estimated row's top edge steady while that row is measured
// and re-measured, and every correction below it moves the read position. The
// error compounds over the whole inserted block, which is why the transcript
// ended up somewhere unrelated instead of a pixel or two off.
//
// So the anchor is named here instead: the row the reader was actually looking
// at before the fetch, held until the inserted block has stopped resizing.
//
// Captured when the load is REQUESTED, not when its rows commit. Reacting to
// the commit is a frame too late for every lever that matters: the list handles
// the data change during that same commit, so an anchor published by an effect
// afterwards misses the one frame it needed to influence. Worse, end
// maintenance is still armed for that frame, and the list ignores distance from
// the end once its maintain pass has latched (`pendingMaintainScrollAtEnd`) —
// it simply scrolls to the live edge, which is how loading older history could
// throw the reader to the newest message instead of merely a few pixels off.
//
// The row filter is expressed as "keys that existed before the fetch" rather
// than the single anchor key. The list treats `shouldRestorePosition` as a hard
// filter over the rows in view and compensates by ZERO when nothing matches, so
// naming one key means any frame where that row is out of view silently loses
// all compensation. Excluding just the newcomers keeps every older row eligible
// as a fallback while still denying the list the estimated-height rows it would
// otherwise have picked.
//
// The measurements come from the list's own bookkeeping (`positionAtIndex` /
// `positionByKey` against `scroll`), not from `getBoundingClientRect`. Both
// coordinate spaces would work, but reading the list's numbers costs no layout
// and — more importantly — puts the correction in the same space the list
// computes its own adjustments in, so the two cannot disagree about where the
// row is.
//
// Corrections are ABSOLUTE (scroll to a computed offset) and rate limited, and
// they go through the list's scroll API rather than writing `scrollTop`. That
// distinction is the whole reason this is safe: the per-frame relative
// `scrollTop +=` writer this replaces raced the list's own adjustment pass and
// produced multi-thousand-pixel swaps (see `shouldHoldHistoryViewportAnchor`).
// An absolute target cannot accumulate error — a correction that lands late is
// a no-op rather than a double correction.

/** The row whose on-screen position a prepend must not change. */
export interface TimelinePrependAnchor {
    readonly key: string;
    /**
     * Distance from the viewport's top edge to the row's top edge at capture.
     *
     * Normally negative: the topmost visible row usually starts above the fold.
     * Restoring the captured value reproduces what the reader saw, so no header
     * or inset height has to be reasoned about here — whatever was under the
     * mobile header stays under it.
     */
    readonly offsetFromViewportTop: number;
}

/** The subset of the list's state the anchor needs. */
export interface TimelineAnchorReadState {
    readonly scroll: number;
    readonly start: number;
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly positionByKey: (key: string) => number | undefined;
}

/** Anchor drift this small reads as settled; below one device pixel. */
export const TIMELINE_ANCHOR_TOLERANCE_PX = 1;

/**
 * Consecutive settled frames that end the hold.
 *
 * Measured in frames rather than milliseconds because what the hold waits for
 * is measurement passes, not elapsed time: a few quiet frames in a row means
 * the inserted rows have stopped changing size.
 */
export const TIMELINE_ANCHOR_STABLE_FRAMES = 8;

/**
 * Hard ceiling on the hold.
 *
 * Deliberately longer than the rows take to measure: the inserted block also
 * swaps Markdown placeholders for real content on a later pass, and that
 * resizes rows above the reader a good while after the fetch resolved. The old
 * fixed window expired before that second wave and left it uncompensated.
 */
export const TIMELINE_ANCHOR_MAX_HOLD_MS = 3000;

/**
 * Minimum gap between corrections.
 *
 * The list needs a few frames to apply its own adjustment; correcting every
 * frame would just pre-empt it with a redundant write.
 */
export const TIMELINE_ANCHOR_CORRECTION_INTERVAL_MS = 64;

/**
 * Names the row to hold: the topmost row currently in view.
 *
 * Called while the transcript is still showing the pre-fetch content, so the
 * row it picks is the one the reader is looking at. For a load-older tap that
 * is the oldest loaded row, which is what sits directly under the control they
 * just pressed.
 */
export const captureTimelinePrependAnchor = (
    state: TimelineAnchorReadState,
    entryKeys: readonly string[],
): TimelinePrependAnchor | null => {
    if (entryKeys.length === 0) return null;
    if (!Number.isFinite(state.scroll) || !Number.isFinite(state.start)) return null;

    const topIndex = Math.max(0, Math.min(Math.floor(state.start), entryKeys.length - 1));
    const key = entryKeys[topIndex];
    if (key === undefined) return null;

    const position = state.positionAtIndex(topIndex);
    if (position === undefined || !Number.isFinite(position)) return null;

    return { key, offsetFromViewportTop: position - state.scroll };
};

/** Everything the hold needs, snapshotted before the request goes out. */
export interface TimelineAnchorArm {
    readonly anchor: TimelinePrependAnchor;
    /**
     * The row keys the transcript already had.
     *
     * Anything outside this set arrived with the fetch, which is what makes it
     * usable as the list's row filter without having to wait and diff the two
     * key lists after the rows have already committed.
     */
    readonly knownKeys: ReadonlySet<string>;
}

/**
 * Snapshots the read position at the moment a history load is requested.
 *
 * Null when the list has nothing measurable to anchor to — an empty or
 * not-yet-laid-out transcript, where there is no read position to preserve.
 */
export const captureTimelineAnchorArm = (
    state: TimelineAnchorReadState,
    entryKeys: readonly string[],
): TimelineAnchorArm | null => {
    const anchor = captureTimelinePrependAnchor(state, entryKeys);
    if (anchor === null) return null;
    return { anchor, knownKeys: new Set(entryKeys) };
};

/**
 * How long an arm waits for its rows before giving up.
 *
 * End maintenance stays off while armed, so an arm whose request fails, returns
 * nothing, or never resolves must not leave the live edge unmaintained forever.
 * Generous because the request crosses a relay on mobile.
 */
export const TIMELINE_ANCHOR_ARM_EXPIRY_MS = 15000;

/**
 * Scroll offset that puts the anchor back where it was captured.
 *
 * Null when the row has no tracked position — a session swap, or the anchor
 * having been dropped from the data entirely. There is nothing to hold then.
 */
export const resolveTimelineAnchorScrollTarget = (
    state: TimelineAnchorReadState,
    anchor: TimelinePrependAnchor,
): number | null => {
    const position = state.positionByKey(anchor.key);
    if (position === undefined || !Number.isFinite(position)) return null;
    return position - anchor.offsetFromViewportTop;
};

/**
 * How far the anchor has moved on screen since capture.
 *
 * Positive means it drifted down (content above it grew by more than the list
 * compensated for), negative means up.
 */
export const measureTimelineAnchorDrift = (
    state: TimelineAnchorReadState,
    anchor: TimelinePrependAnchor,
): number | null => {
    if (!Number.isFinite(state.scroll)) return null;
    const target = resolveTimelineAnchorScrollTarget(state, anchor);
    if (target === null) return null;
    return state.scroll - target;
};

export type TimelineAnchorHoldAction =
    /** Within tolerance, but not for long enough yet — keep watching. */
    | 'wait'
    /** Drifted, and the rate limit allows another absolute correction. */
    | 'correct'
    /** Settled, expired, or unanchorable — stop holding. */
    | 'release';

export interface TimelineAnchorHoldStep {
    readonly action: TimelineAnchorHoldAction;
    /** Quiet-frame streak to carry into the next frame. */
    readonly stableFrames: number;
}

/**
 * Decides what a single frame of the hold should do.
 *
 * Pure, and returns the streak it consumed rather than leaving the caller to
 * re-derive it, so every rule about how long the hold waits, when it gives up
 * and how often it writes lives here and is testable without a list, a DOM or
 * a clock.
 */
export const resolveTimelineAnchorHoldStep = (input: {
    /** Null when the anchor has no measurable position. */
    readonly drift: number | null;
    readonly elapsedMs: number;
    readonly stableFrames: number;
    readonly msSinceLastCorrection: number;
}): TimelineAnchorHoldStep => {
    if (input.drift === null) return { action: 'release', stableFrames: 0 };
    if (input.elapsedMs >= TIMELINE_ANCHOR_MAX_HOLD_MS) {
        return { action: 'release', stableFrames: 0 };
    }

    if (Math.abs(input.drift) <= TIMELINE_ANCHOR_TOLERANCE_PX) {
        const stableFrames = input.stableFrames + 1;
        return {
            action: stableFrames >= TIMELINE_ANCHOR_STABLE_FRAMES ? 'release' : 'wait',
            stableFrames,
        };
    }

    // Drifting: the streak restarts either way, and a correction only goes out
    // if the previous one has had time to land.
    return {
        action: input.msSinceLastCorrection >= TIMELINE_ANCHOR_CORRECTION_INTERVAL_MS
            ? 'correct'
            : 'wait',
        stableFrames: 0,
    };
};
