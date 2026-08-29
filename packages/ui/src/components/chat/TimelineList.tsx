// --- Timeline virtualization (@legendapp/list) ------------------------------
// One list owns the whole timeline: history turns AND the live streaming tail
// are rows of the same list, so there is a single scroll position instead of a
// virtualizer and a separately-rendered tail arbitrating over one container.
//
// Scroll behaviour the list owns natively, which is why the auto-follow pin,
// the entry-stick window and the force-bottom watchdog are all bypassed on
// this path:
//   • `initialScrollAtEnd` opens a session at the live edge.
//   • `maintainScrollAtEnd` keeps it there as rows grow. Late async growth is
//     handled by the list staying at the end, not by a timed hold — which is
//     what the entry-stick quiescence window used to approximate.
//   • `maintainVisibleContentPosition` preserves the read position when older
//     history is prepended, replacing the manual anchor hold and the mobile
//     quiet-window prepend deferral.
//   • `anchoredEndSpace` reserves the tail space that parks a just-sent
//     message near the top of the viewport.
//
// Rows are never recycled: chat rows own internal state (expanded tool calls,
// reveal animations) that recycling would carry into a different turn.
//
// Row rendering is injected as `renderEntry` rather than imported, so this
// module stays free of the turn/message component tree and cannot form an
// import cycle with MessageList.
//
// ── Re-rendering a row ─────────────────────────────────────────────────────
// The list memoizes each row on `[itemKey, itemData, extraData]`, so a row is
// only re-rendered when one of those three changes. Anything dynamic therefore
// has to travel through one of them, or through a context read *inside* the
// row (context updates cross the memo boundary):
//   • streaming content — the caller substitutes the live entry into `entries`,
//     so the newest row's item identity changes per chunk.
//   • Markdown hydration — published through `TimelineHydrationContext` and
//     read by the row itself, so releasing a batch re-renders only the rows
//     whose flag actually flipped.
//   • the history/tail boundary — passed as `extraData`, because a row's own
//     identity does not change when a prepend shifts its index.

import React from 'react';
import { useEvent } from '@reactuses/core';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import {
    createInitialMarkdownHydratedKeys,
    ensureNewestMarkdownKeyHydrated,
    getMarkdownHydrationBatch,
    pruneMarkdownHydratedKeys,
    readMarkdownHydrationRestore,
    writeMarkdownHydrationRestore,
    type MarkdownHydrationScrollDirection,
} from './lib/markdownHydrationWindow';
import {
    captureTimelineAnchorArm,
    measureTimelineAnchorDrift,
    resolveTimelineAnchorHoldStep,
    resolveTimelineAnchorScrollTarget,
    TIMELINE_ANCHOR_ARM_EXPIRY_MS,
    type TimelineAnchorArm,
} from './lib/scroll/timelinePrependAnchor';
import {
    didPrependTimelineEntries,
    resolveTimelineIsAtEnd,
    TIMELINE_ANCHORING_ATTRIBUTE,
    TIMELINE_PREPEND_SETTLE_MS,
} from './lib/scroll/timelineScrollAnchoring';

// Any sliver of a row counts as visible: the Markdown hydration window needs
// the full mounted span, not a "mostly on screen" subset.
const TIMELINE_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 } as const;

// Scroll counts as settled this long after the last scroll event. Visible
// Markdown may only be released while settled, so a placeholder-to-Markdown
// swap never happens under the user's eyes mid-scroll.
const TIMELINE_SCROLL_IDLE_MS = 100;

// Delay of the pass that runs *after* scrolling stops. Scroll events are the
// only thing the list reports here, so without a trailing pass the settled
// branch above is unreachable: every pass a scroll schedules runs in that same
// frame, is therefore never settled, and withholds exactly the visible rows the
// user is now looking at — they stay placeholders until the transcript is
// remounted. One frame past the idle threshold, so the pass reads as settled.
const TIMELINE_HYDRATION_IDLE_PASS_MS = TIMELINE_SCROLL_IDLE_MS + 16;

const EMPTY_HYDRATED_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Hydrated Markdown keys, read by each row rather than baked into the row's
 * props. A context update re-renders consumers regardless of the list's row
 * memo, which is what makes a hydration release actually reach the screen.
 */
const TimelineHydrationContext = React.createContext<ReadonlySet<string>>(EMPTY_HYDRATED_KEYS);

export type TimelineRowEntry = {
    key: string;
    kind: string;
};

/** The subset of the list's ScrollView methods object this module relies on. */
type ScrollViewLike = {
    getScrollableNode?: () => HTMLDivElement | null;
};

export type TimelineHydrationTuning = {
    resolvePreloadEntries: (visibleCount: number) => number;
    resolvePreloadReleaseWhileScrolling: () => number;
    resolveVisibleReleaseLimit: () => number;
};

export type TimelineAnchoredEndSpace = {
    anchorIndex: number;
    anchorOffset?: number;
};

export type TimelineListProps<TEntry extends TimelineRowEntry> = {
    entries: readonly TEntry[];
    /** Scope key for the measurement / hydration restore caches. */
    timelineCacheKey: string;
    estimatedItemSize: number;
    hydrationTuning: TimelineHydrationTuning;
    renderEntry: (entry: TEntry, index: number, hydrateMarkdown: boolean) => React.ReactNode;
    /**
     * Forwarded to the list as `extraData`, whose only job here is to invalidate
     * the row memo when something outside a row's own identity changes the way
     * it renders — the history/tail boundary moving, for instance, which shifts
     * every following index without changing any item.
     */
    rowInvalidationKey?: unknown;
    /**
     * Bridges the list's scroll element to the existing DOM-based machinery
     * (overlay scrollbar, scroll spy, viewport snapshots, `data-turn-entry`
     * queries). `refScrollView` publishes a ScrollView *methods* object, not an
     * element, so the element is unwrapped through `getScrollableNode()` before
     * being published here.
     */
    scrollElementRef?: React.RefObject<HTMLDivElement | null>;
    /**
     * Applied to the list's scroll element on attach. The old path's scroll
     * container carried `data-scrollbar="chat"`, which several DOM consumers
     * find by `closest()` — the list owns that element here, so the attributes
     * have to be written when it is published rather than declared in JSX.
     * Must be referentially stable: it participates in the ref callback.
     */
    scrollElementDataset?: Record<string, string>;
    registerList?: (list: LegendListRef | null) => void;
    anchoredEndSpace?: TimelineAnchoredEndSpace;
    /** Height of the composer floating over the list. */
    composerOverlayHeight?: number;
    /**
     * False while something else owns the scroll position: an explicit
     * navigation to an older turn, or the user having scrolled away. Replaces
     * the old "freeze by not writing scrollTop" approach — here the list simply
     * stops maintaining the end.
     */
    followEnabled?: boolean;
    /**
     * Bumped when a load of earlier history is REQUESTED, before the fetch.
     *
     * The list absorbs a prepend during the commit that delivers it, so an
     * anchor derived from that commit arrives too late to influence it — and
     * end maintenance, still armed for that frame, will have taken the viewport
     * to the live edge. A token lets the read position be captured and end
     * maintenance stood down while the transcript is still untouched.
     */
    historyAnchorToken?: number;
    /** Drives the animated variant of end maintenance. */
    sessionIsWorking?: boolean;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
    /**
     * Notified on every scroll frame. The list owns the scroll container here,
     * so scroll-driven work that used to hang off the shared container (history
     * pagination) has to be forwarded from inside.
     */
    onScroll?: () => void;
    /**
     * Content that used to be a sibling of the list inside the shared scroll
     * container (load-older control; question/permission cards, recap, status
     * row, tail spacer). The list owns the scroll container here, so they have
     * to live in its header/footer slots — `maintainScrollAtEnd.footerLayout`
     * keeps the end maintained when the footer's height changes.
     */
    header?: React.ReactNode;
    footer?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    contentContainerClassName?: string;
    contentContainerStyle?: React.CSSProperties;
};

type TimelineRowProps<TEntry extends TimelineRowEntry> = {
    entry: TEntry;
    index: number;
    renderEntryRef: React.RefObject<TimelineListProps<TEntry>['renderEntry']>;
};

/**
 * Reads the hydration flag for its own row. Being a context consumer is the
 * point: the list's row memo cannot see a hydration release, but a context
 * update re-renders this component anyway — and only the rows whose flag
 * changed produce a different subtree.
 */
const TimelineRow = <TEntry extends TimelineRowEntry>({
    entry,
    index,
    renderEntryRef,
}: TimelineRowProps<TEntry>) => {
    const hydratedKeys = React.useContext(TimelineHydrationContext);
    return (
        <div data-turn-entry={entry.key} className="oc-chat-message-layout-boundary">
            {renderEntryRef.current?.(entry, index, hydratedKeys.has(entry.key))}
        </div>
    );
};

const TimelineListInner = <TEntry extends TimelineRowEntry>({
    entries,
    timelineCacheKey,
    estimatedItemSize,
    hydrationTuning,
    renderEntry,
    rowInvalidationKey,
    scrollElementRef,
    scrollElementDataset,
    registerList,
    anchoredEndSpace,
    composerOverlayHeight = 0,
    followEnabled = true,
    historyAnchorToken = 0,
    sessionIsWorking = false,
    onIsAtEndChange,
    onScroll,
    header,
    footer,
    className,
    style,
    contentContainerClassName,
    contentContainerStyle,
}: TimelineListProps<TEntry>) => {
    const listRef = React.useRef<LegendListRef | null>(null);

    const entryKeys = React.useMemo(() => entries.map((entry) => entry.key), [entries]);
    const entryKeysRef = React.useRef(entryKeys);
    entryKeysRef.current = entryKeys;

    const tuningRef = React.useRef(hydrationTuning);
    tuningRef.current = hydrationTuning;

    const setListRef = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList?.(list);
    }, [registerList]);

    // `refScrollView` hands back a ScrollView methods object (scrollTo,
    // getScrollableNode, …), not the element. Everything downstream expects an
    // element, so unwrap it here and publish that.
    const listScrollElementRef = React.useRef<HTMLDivElement | null>(null);
    const setScrollView = React.useCallback((scrollView: ScrollViewLike | null) => {
        const element = scrollView?.getScrollableNode?.() ?? null;
        if (element && scrollElementDataset) {
            for (const [key, value] of Object.entries(scrollElementDataset)) {
                element.dataset[key] = value;
            }
        }
        listScrollElementRef.current = element;
        if (scrollElementRef) {
            scrollElementRef.current = element;
        }
    }, [scrollElementRef, scrollElementDataset]);

    // --- Prepend settle window ---------------------------------------------
    // Key-anchored prepends are only exact while the inserted rows keep the
    // heights they were anchored with. They arrive at their estimated heights
    // and are measured a frame or two later, and those corrections land ABOVE
    // the read position: uncompensated, the viewport moves by the whole
    // estimation error, which is what threw the transcript somewhere unrelated
    // after loading older history. So size compensation is switched on for the
    // window that follows a prepend and off again outside it, where rows
    // growing in place (a tool result expanding) must still grow downward.
    const [prependToken, setPrependToken] = React.useState(0);
    const [settledPrependToken, setSettledPrependToken] = React.useState(0);
    const prependSettling = prependToken !== settledPrependToken;

    // A fresh list opens at the live edge (`initialScrollAtEnd`).
    const lastIsAtEndRef = React.useRef(true);
    // Whether this transcript has ever actually reached its live edge.
    //
    // Gates the animated form of end maintenance, which must never be what
    // covers the opening catch-up. Rows arrive at their estimated heights, so
    // the end keeps moving as they measure, while an animated pass scrolls
    // toward the offset that was current when it was requested — and a smooth
    // scroll lasts long enough for those measurements to leave that target far
    // short of the real end. Everything raised during a pass is coalesced into
    // a single replay, so the catch-up gets two glides and stops; once the
    // pass-in-flight exemption lapses, a remaining gap wider than a tenth of a
    // screen retires end maintenance outright and parks the transcript
    // mid-conversation. Instant passes land exactly on the end every time,
    // which is why only actively streaming sessions ever showed this.
    const [endSettledOnce, setEndSettledOnce] = React.useState(false);
    const endSettledOnceRef = React.useRef(false);
    // Reset with the transcript, because this ref is the edge detector for the
    // at-end signal published upstream and a stale one stops publishing
    // silently. A swapped-in session opens at the live edge, so a ref still
    // reading "away from the end" from the previous transcript matches the
    // first real reading, no edge fires, and upstream keeps the `true` it
    // assumed on the swap — permanently. Everything gated on being away from
    // the end then reads the wrong answer, and standing end maintenance down
    // before a history load is exactly such a gate.
    React.useLayoutEffect(() => {
        lastIsAtEndRef.current = true;
        endSettledOnceRef.current = false;
        setEndSettledOnce(false);
    }, [timelineCacheKey]);

    // --- Held read-position anchor ------------------------------------------
    // Widening the window above only extends the list's own compensation; it
    // does not change WHICH row the list holds still, and for a load-older tap
    // that choice is the actual defect. The reader is at the very top when they
    // press the control, so the rows that arrive above them become the list's
    // first-in-view anchor while their heights are still estimates, and every
    // later measurement moves the transcript out from under the reader.
    //
    // So the row to hold is named explicitly, captured when the load is
    // requested and held until the inserted block stops resizing. Requested,
    // not committed: the list absorbs the prepend inside the delivering commit,
    // so an anchor published afterwards misses that frame — and end
    // maintenance, still armed for it, takes the viewport to the live edge.
    // See ./lib/scroll/timelinePrependAnchor.
    type HistoryAnchorState = {
        readonly token: number;
        readonly arm: TimelineAnchorArm;
        /** True once the requested rows have landed and can start moving. */
        readonly holding: boolean;
    };
    const [historyAnchor, setHistoryAnchor] = React.useState<HistoryAnchorState | null>(null);
    const clearHistoryAnchor = useEvent((token: number) => {
        setHistoryAnchor((current) => (current?.token === token ? null : current));
    });

    React.useLayoutEffect(() => {
        if (historyAnchorToken <= 0) return;
        const list = listRef.current;
        if (!list) return;
        // Nothing has moved yet, so this reads the position the reader is
        // actually looking at rather than a remembered one.
        const arm = captureTimelineAnchorArm(list.getState(), entryKeysRef.current);
        if (!arm) return;
        setHistoryAnchor({ token: historyAnchorToken, arm, holding: false });
    }, [historyAnchorToken]);

    // An arm holds end maintenance down, so one whose rows never arrive — a
    // failed request, or history that turned out to have nothing older — has to
    // let go by itself.
    React.useEffect(() => {
        if (!historyAnchor || historyAnchor.holding) return;
        const { token } = historyAnchor;
        const timer = window.setTimeout(() => {
            setHistoryAnchor((current) => (
                current?.token === token && !current.holding ? null : current
            ));
        }, TIMELINE_ANCHOR_ARM_EXPIRY_MS);
        return () => window.clearTimeout(timer);
    }, [historyAnchor]);

    const committedEntryKeysRef = React.useRef(entryKeys);
    React.useLayoutEffect(() => {
        const previous = committedEntryKeysRef.current;
        committedEntryKeysRef.current = entryKeys;
        if (!didPrependTimelineEntries(previous, entryKeys)) return;
        // Before paint: the measurements that need compensating are reported
        // once this commit is on screen.
        setPrependToken((token) => token + 1);
        // The arm becomes a hold. Its clock starts here rather than at the
        // request, because "has it stopped moving" only means anything once
        // there is something moving — counting quiet frames during the fetch
        // would retire the anchor before its rows ever arrived.
        setHistoryAnchor((current) => (
            current === null || current.holding ? current : { ...current, holding: true }
        ));
    }, [entryKeys]);

    React.useEffect(() => {
        if (!prependSettling) return;
        const timer = window.setTimeout(() => {
            setSettledPrependToken(prependToken);
        }, TIMELINE_PREPEND_SETTLE_MS);
        return () => window.clearTimeout(timer);
    }, [prependSettling, prependToken]);

    // Holds the named row still until it stops moving on its own.
    //
    // Read-only per frame, and corrections are absolute offsets issued through
    // the list's own scroll API rather than `scrollTop` writes — a relative
    // per-frame writer racing the list's adjustment pass is what produced the
    // huge load-more swaps this replaces.
    React.useEffect(() => {
        if (!historyAnchor?.holding) return;
        const { token, arm: { anchor } } = historyAnchor;
        const list = listRef.current;
        if (!list || typeof window === 'undefined') {
            clearHistoryAnchor(token);
            return;
        }
        const element = listScrollElementRef.current;

        const startedAt = Date.now();
        let stableFrames = 0;
        let lastCorrectionAt: number | null = null;
        let frame: number | null = null;
        let stopped = false;
        const listeners: Array<[string, EventListener]> = [];

        const stop = (clearAnchor: boolean) => {
            if (stopped) return;
            stopped = true;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
                frame = null;
            }
            for (const [type, listener] of listeners) {
                element?.removeEventListener(type, listener);
            }
            if (clearAnchor) clearHistoryAnchor(token);
        };

        const step = () => {
            frame = null;
            if (stopped) return;
            const state = list.getState();
            const now = Date.now();
            const outcome = resolveTimelineAnchorHoldStep({
                drift: measureTimelineAnchorDrift(state, anchor),
                elapsedMs: now - startedAt,
                stableFrames,
                msSinceLastCorrection: lastCorrectionAt === null
                    ? Number.POSITIVE_INFINITY
                    : now - lastCorrectionAt,
            });
            stableFrames = outcome.stableFrames;
            if (outcome.action === 'release') {
                stop(true);
                return;
            }
            if (outcome.action === 'correct') {
                const target = resolveTimelineAnchorScrollTarget(state, anchor);
                if (target !== null) {
                    lastCorrectionAt = now;
                    void list.scrollToOffset({ offset: target, animated: false });
                }
            }
            frame = window.requestAnimationFrame(step);
        };

        // The reader taking over outranks the anchor: once they move, where the
        // transcript should sit is their business, not the load's.
        const releaseToUser = () => {
            stop(true);
        };
        for (const type of ['touchstart', 'touchmove', 'wheel', 'pointerdown', 'keydown']) {
            listeners.push([type, releaseToUser]);
        }
        for (const [type, listener] of listeners) {
            element?.addEventListener(type, listener, { passive: true });
        }
        frame = window.requestAnimationFrame(step);

        return () => {
            stop(false);
        };
    }, [clearHistoryAnchor, historyAnchor]);

    // Announced on the element so scroll observers outside this tree can tell
    // the list's own re-anchoring from the user's travel. Covers the whole
    // hold, which outlasts the settle window when measurements keep landing.
    //
    // Before paint, not after: the list adjusts the scroll position during this
    // same commit, and the browser dispatches the resulting scroll event before
    // a passive effect would have raised the flag. That one unflagged frame is
    // a large distance change with no gesture behind it, which is exactly what
    // the mobile composer reads as a deliberate swipe.
    const timelineAnchoring = prependSettling || historyAnchor !== null;
    React.useLayoutEffect(() => {
        const element = listScrollElementRef.current;
        if (!element || !timelineAnchoring) return;
        element.setAttribute(TIMELINE_ANCHORING_ATTRIBUTE, 'true');
        return () => {
            element.removeAttribute(TIMELINE_ANCHORING_ATTRIBUTE);
        };
    }, [timelineAnchoring]);

    const maintainVisibleContentPosition = React.useMemo(() => {
        if (historyAnchor === null) {
            return { data: true, size: prependSettling };
        }
        const { knownKeys } = historyAnchor.arm;
        // Denies the list the rows this load brought in — those are the ones
        // still carrying estimated heights, and picking one as its anchor is
        // what moved the transcript out from under the reader.
        //
        // Everything older stays eligible on purpose: the list treats this as a
        // hard filter and compensates by NOTHING when no row in view passes it,
        // so narrowing this to the single held row would silently forfeit all
        // compensation on any frame where that row happens to be off screen.
        return {
            data: true,
            size: true,
            shouldRestorePosition: (entry: TEntry) => knownKeys.has(entry.key),
        };
    }, [historyAnchor, prependSettling]);

    // --- Markdown hydration window -----------------------------------------
    // The window planner is engine-agnostic: it only needs the mounted span,
    // the visible span and the travel direction. The list reports those through
    // `getState()` (startBuffered/endBuffered vs start/end, scroll offset),
    // which is what previously came from the virtualizer range.
    const [hydratedMarkdownEntryKeys, setHydratedMarkdownEntryKeys] = React.useState<Set<string>>(
        () => createInitialMarkdownHydratedKeys(entryKeys, {
            restore: readMarkdownHydrationRestore(timelineCacheKey) ?? null,
        }),
    );
    const hydratedMarkdownKeysRef = React.useRef(hydratedMarkdownEntryKeys);
    hydratedMarkdownKeysRef.current = hydratedMarkdownEntryKeys;

    const lastScrollAtRef = React.useRef(0);
    const lastScrollOffsetRef = React.useRef(0);
    const scrollDirectionRef = React.useRef<MarkdownHydrationScrollDirection>(null);
    const hydrationScheduledRef = React.useRef(false);
    const idleHydrationTimerRef = React.useRef<number | null>(null);

    // A turn that finished streaming in the tail is already painted rich; it
    // must not fall back to a placeholder for a frame when it becomes history.
    const activeHydratedMarkdownEntryKeys = React.useMemo(
        () => ensureNewestMarkdownKeyHydrated(hydratedMarkdownEntryKeys, entryKeys),
        [hydratedMarkdownEntryKeys, entryKeys],
    );

    React.useEffect(() => {
        setHydratedMarkdownEntryKeys((current) => pruneMarkdownHydratedKeys(current, entryKeys));
    }, [entryKeys]);

    React.useEffect(() => () => {
        writeMarkdownHydrationRestore(timelineCacheKey, hydratedMarkdownKeysRef.current);
    }, [timelineCacheKey]);

    const releaseMarkdownHydration = useEvent(() => {
        hydrationScheduledRef.current = false;
        const list = listRef.current;
        if (!list) return;

        const keys = entryKeysRef.current;
        if (keys.length === 0) return;

        const state = list.getState();
        const lastIndex = keys.length - 1;
        const mountedStart = Math.max(0, Math.floor(state.startBuffered));
        const mountedEnd = Math.min(lastIndex, Math.floor(state.endBuffered));
        if (!Number.isFinite(mountedStart) || !Number.isFinite(mountedEnd) || mountedEnd < mountedStart) {
            return;
        }

        const mountedIndexes: number[] = [];
        for (let index = mountedStart; index <= mountedEnd; index += 1) {
            mountedIndexes.push(index);
        }

        const visibleStartIndex = Math.max(0, Math.floor(state.start));
        const visibleEndIndex = Math.min(lastIndex, Math.floor(state.end));
        const visibleCount = Math.max(0, visibleEndIndex - visibleStartIndex + 1);
        const settled = Date.now() - lastScrollAtRef.current >= TIMELINE_SCROLL_IDLE_MS;
        const tuning = tuningRef.current;
        const preloadEntries = tuning.resolvePreloadEntries(visibleCount);

        const batch = getMarkdownHydrationBatch({
            entryKeys: keys,
            mountedIndexes,
            visibleStartIndex,
            visibleEndIndex,
            scrollDirection: scrollDirectionRef.current,
            preloadEntries,
            hydratedKeys: hydratedMarkdownKeysRef.current,
            allowVisibleRelease: settled,
            preloadReleaseLimit: settled
                ? preloadEntries
                : tuning.resolvePreloadReleaseWhileScrolling(),
            visibleReleaseLimit: tuning.resolveVisibleReleaseLimit(),
        });

        if (batch.length === 0) return;

        // A settled pass releases a capped batch (a screenful of rich Markdown
        // in one commit is a visible stall), so whatever it left deferred needs
        // another pass. Self-terminating: the pass that finds nothing left to
        // release does not re-arm.
        armIdleMarkdownHydration();

        React.startTransition(() => {
            setHydratedMarkdownEntryKeys((current) => {
                let changed = false;
                const next = new Set(current);
                for (const key of batch) {
                    if (!next.has(key)) {
                        next.add(key);
                        changed = true;
                    }
                }
                return changed ? next : current;
            });
        });
    });

    const scheduleMarkdownHydration = useEvent(() => {
        if (hydrationScheduledRef.current) return;
        hydrationScheduledRef.current = true;
        // After paint: releasing inside the commit that mounted the rows makes
        // the list remeasure within its own layout pass.
        scheduleAfterPaintTask(releaseMarkdownHydration);
    });

    /**
     * Schedules the pass that runs once the transcript has stopped moving.
     *
     * Debounced: every scroll frame pushes it back, so it lands only after the
     * scroll (and its momentum) has actually settled — which is the only moment
     * visible rows are allowed to swap their placeholder for rich Markdown.
     */
    const armIdleMarkdownHydration = useEvent(() => {
        if (typeof window === 'undefined') return;
        if (idleHydrationTimerRef.current !== null) {
            window.clearTimeout(idleHydrationTimerRef.current);
        }
        idleHydrationTimerRef.current = window.setTimeout(() => {
            idleHydrationTimerRef.current = null;
            scheduleMarkdownHydration();
        }, TIMELINE_HYDRATION_IDLE_PASS_MS);
    });

    React.useEffect(() => () => {
        if (idleHydrationTimerRef.current === null) return;
        window.clearTimeout(idleHydrationTimerRef.current);
        idleHydrationTimerRef.current = null;
    }, []);

    const handleViewableItemsChanged = useEvent(() => {
        scheduleMarkdownHydration();
    });

    const handleScroll = useEvent(() => {
        lastScrollAtRef.current = Date.now();
        const list = listRef.current;
        if (list) {
            const state = list.getState();
            const offset = state.scroll;
            if (Number.isFinite(offset) && offset !== lastScrollOffsetRef.current) {
                scrollDirectionRef.current = offset > lastScrollOffsetRef.current ? 'forward' : 'backward';
                lastScrollOffsetRef.current = offset;
            }
            // Edge-triggered: this drives React state upstream, and scroll fires
            // every frame.
            const atEnd = resolveTimelineIsAtEnd(state) ?? state.isAtEnd;
            if (atEnd !== lastIsAtEndRef.current) {
                lastIsAtEndRef.current = atEnd;
                onIsAtEndChange?.(atEnd);
            }
            // One-way for this transcript: leaving the end again is ordinary
            // streaming growth, which is precisely what the glide is for.
            if (atEnd && !endSettledOnceRef.current) {
                endSettledOnceRef.current = true;
                setEndSettledOnce(true);
            }
        }
        onScroll?.();
        scheduleMarkdownHydration();
        // The pass above runs in this frame and is therefore never settled: it
        // may only release off-screen preload. The rows that entered the
        // viewport during a fast scroll are hydrated by the trailing pass.
        armIdleMarkdownHydration();
    });

    const keyExtractor = React.useCallback((entry: TEntry) => entry.key, []);

    // Rows are pooled by kind so a turn moving from the live tail into history
    // reuses the same container kind instead of tearing its subtree down.
    const getItemType = React.useCallback((entry: TEntry) => entry.kind, []);

    const renderEntryRef = React.useRef(renderEntry);
    renderEntryRef.current = renderEntry;

    const renderItem = React.useCallback(({ item, index }: { item: TEntry; index: number }) => (
        <TimelineRow<TEntry> entry={item} index={index} renderEntryRef={renderEntryRef} />
    ), []);

    const maintainScrollAtEnd = React.useMemo(() => {
        // While a turn is anchored, the reserved end space — not the live edge —
        // defines where the viewport rests. A history anchor owns the scroll
        // position outright for the same reason, from the moment the load is
        // requested: once the list's maintain pass has latched it stops caring
        // how far the viewport is from the end and simply scrolls there, so
        // standing it down has to happen before the rows arrive, not after.
        if (anchoredEndSpace || !followEnabled || historyAnchor) return false;
        return {
            // Animated only once the transcript has reached its live edge, and
            // only while it streams: there the block-step growth turns each
            // correction into a glide. The opening catch-up has to be instant —
            // see `endSettledOnce` for what an animated one does to it.
            animated: sessionIsWorking && endSettledOnce,
            on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
        } as const;
    }, [anchoredEndSpace, endSettledOnce, followEnabled, historyAnchor, sessionIsWorking]);

    return (
        <TimelineHydrationContext.Provider value={activeHydratedMarkdownEntryKeys}>
            <LegendList<TEntry>
                ref={setListRef}
                refScrollView={setScrollView as unknown as React.Ref<HTMLElement>}
                data={entries as TEntry[]}
                extraData={rowInvalidationKey}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                renderItem={renderItem}
                estimatedItemSize={estimatedItemSize}
                initialScrollAtEnd
                recycleItems={false}
                {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                contentInsetEndAdjustment={composerOverlayHeight}
                maintainScrollAtEnd={maintainScrollAtEnd}
                // Prepending older history must not move what the user is
                // reading — see the settle window above for why size
                // restoration is scoped to it rather than always on.
                maintainVisibleContentPosition={maintainVisibleContentPosition}
                onScroll={handleScroll}
                onViewableItemsChanged={handleViewableItemsChanged}
                viewabilityConfig={TIMELINE_VIEWABILITY_CONFIG}
                ListHeaderComponent={header as React.ReactElement | null | undefined}
                ListFooterComponent={footer as React.ReactElement | null | undefined}
                className={className}
                style={style}
                contentContainerClassName={contentContainerClassName}
                contentContainerStyle={contentContainerStyle}
            />
        </TimelineHydrationContext.Provider>
    );
};

export const TimelineList = React.memo(TimelineListInner) as typeof TimelineListInner;
