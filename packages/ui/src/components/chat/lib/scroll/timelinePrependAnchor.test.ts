import { describe, expect, test } from 'vitest';

import {
    captureTimelineAnchorArm,
    captureTimelinePrependAnchor,
    measureTimelineAnchorDrift,
    resolveTimelineAnchorHoldStep,
    resolveTimelineAnchorScrollTarget,
    TIMELINE_ANCHOR_CORRECTION_INTERVAL_MS,
    TIMELINE_ANCHOR_MAX_HOLD_MS,
    TIMELINE_ANCHOR_STABLE_FRAMES,
    type TimelineAnchorReadState,
} from './timelinePrependAnchor';

// Rows 100px tall at 0, 100, 200, … so a position maps to its index by /100.
const listState = (input: {
    scroll: number;
    start: number;
    keys: readonly string[];
    positions?: Record<string, number>;
}): TimelineAnchorReadState => {
    const positions = input.positions
        ?? Object.fromEntries(input.keys.map((key, index) => [key, index * 100]));
    return {
        scroll: input.scroll,
        start: input.start,
        positionAtIndex: (index) => {
            const key = input.keys[index];
            return key === undefined ? undefined : positions[key];
        },
        positionByKey: (key) => positions[key],
    };
};

describe('captureTimelineAnchorArm', () => {
    test('snapshots the read position together with the keys that predate the fetch', () => {
        const arm = captureTimelineAnchorArm(
            listState({ scroll: 250, start: 2, keys: ['a', 'b', 'c', 'd'] }),
            ['a', 'b', 'c', 'd'],
        );

        expect(arm?.anchor).toEqual({ key: 'c', offsetFromViewportTop: -50 });
        // The filter the list is given: rows outside this set arrived with the
        // fetch, and those are the ones still carrying estimated heights.
        expect([...arm?.knownKeys ?? []]).toEqual(['a', 'b', 'c', 'd']);
    });

    test('the snapshot does not alias the caller\'s key list', () => {
        const keys = ['a', 'b'];
        const arm = captureTimelineAnchorArm(listState({ scroll: 0, start: 0, keys }), keys);
        keys.push('prepended');

        expect(arm?.knownKeys.has('prepended')).toBe(false);
    });

    test('nothing measurable to hold means no arm', () => {
        expect(captureTimelineAnchorArm(
            listState({ scroll: 0, start: 0, keys: [] }),
            [],
        )).toBeNull();
    });
});

describe('captureTimelinePrependAnchor', () => {
    test('names the topmost row in view and how far below the fold it starts', () => {
        const anchor = captureTimelinePrependAnchor(
            listState({ scroll: 250, start: 2, keys: ['a', 'b', 'c', 'd'] }),
            ['a', 'b', 'c', 'd'],
        );
        // Row 'c' starts at 200, the fold is at 250: it began 50px above it.
        expect(anchor).toEqual({ key: 'c', offsetFromViewportTop: -50 });
    });

    test('a fractional first-visible index resolves to the row it is inside', () => {
        const anchor = captureTimelinePrependAnchor(
            listState({ scroll: 250, start: 2.5, keys: ['a', 'b', 'c', 'd'] }),
            ['a', 'b', 'c', 'd'],
        );
        expect(anchor?.key).toBe('c');
    });

    test('there is nothing to anchor in an empty timeline', () => {
        expect(captureTimelinePrependAnchor(
            listState({ scroll: 0, start: 0, keys: [] }),
            [],
        )).toBeNull();
    });

    test('an unmeasured row cannot be an anchor', () => {
        const state: TimelineAnchorReadState = {
            scroll: 0,
            start: 0,
            positionAtIndex: () => undefined,
            positionByKey: () => undefined,
        };
        expect(captureTimelinePrependAnchor(state, ['a'])).toBeNull();
    });
});

describe('resolveTimelineAnchorScrollTarget', () => {
    test('a prepend that pushed the anchor down resolves to a matching scroll offset', () => {
        // 'c' was at 200 with the fold at 250; three rows landed above it, so it
        // now starts at 500. Keeping it 50px above the fold means scrolling to 550.
        const target = resolveTimelineAnchorScrollTarget(
            listState({
                scroll: 250,
                start: 5,
                keys: ['x', 'y', 'z', 'a', 'b', 'c'],
            }),
            { key: 'c', offsetFromViewportTop: -50 },
        );
        expect(target).toBe(550);
    });

    test('an anchor that left the data has no target', () => {
        expect(resolveTimelineAnchorScrollTarget(
            listState({ scroll: 0, start: 0, keys: ['a', 'b'] }),
            { key: 'gone', offsetFromViewportTop: 0 },
        )).toBeNull();
    });
});

describe('measureTimelineAnchorDrift', () => {
    const prepended = ['x', 'y', 'z', 'a', 'b', 'c'];

    test('an uncompensated prepend reads as the anchor drifting down', () => {
        // Scroll never moved, so the anchor is now 300px lower on screen.
        const drift = measureTimelineAnchorDrift(
            listState({ scroll: 250, start: 2, keys: prepended }),
            { key: 'c', offsetFromViewportTop: -50 },
        );
        expect(drift).toBe(-300);
    });

    test('a fully compensated prepend reads as no drift at all', () => {
        const drift = measureTimelineAnchorDrift(
            listState({ scroll: 550, start: 5, keys: prepended }),
            { key: 'c', offsetFromViewportTop: -50 },
        );
        expect(drift).toBe(0);
    });

    test('drift and the scroll target always agree', () => {
        const state = listState({ scroll: 400, start: 4, keys: prepended });
        const anchor = { key: 'c', offsetFromViewportTop: -50 };
        const drift = measureTimelineAnchorDrift(state, anchor);
        const target = resolveTimelineAnchorScrollTarget(state, anchor);
        expect(target).toBe(state.scroll - (drift ?? 0));
    });
});

describe('resolveTimelineAnchorHoldStep', () => {
    const base = { drift: 0, elapsedMs: 0, stableFrames: 0, msSinceLastCorrection: 1000 };

    test('drift beyond tolerance is corrected once the rate limit allows it', () => {
        expect(resolveTimelineAnchorHoldStep({ ...base, drift: -120 })).toEqual({
            action: 'correct',
            stableFrames: 0,
        });
    });

    test('a correction that just fired is not repeated on the next frame', () => {
        expect(resolveTimelineAnchorHoldStep({
            ...base,
            drift: -120,
            msSinceLastCorrection: TIMELINE_ANCHOR_CORRECTION_INTERVAL_MS - 1,
        })).toEqual({ action: 'wait', stableFrames: 0 });
    });

    test('drift restarts the settled streak', () => {
        expect(resolveTimelineAnchorHoldStep({
            ...base,
            drift: -120,
            stableFrames: TIMELINE_ANCHOR_STABLE_FRAMES - 1,
        }).stableFrames).toBe(0);
    });

    test('sub-pixel drift is left alone and counts as settled', () => {
        expect(resolveTimelineAnchorHoldStep({ ...base, drift: 0.5 })).toEqual({
            action: 'wait',
            stableFrames: 1,
        });
    });

    // The hold outlasts the first measurement pass on purpose: Markdown
    // hydration resizes the inserted rows again later.
    test('the hold ends only after a run of settled frames', () => {
        expect(resolveTimelineAnchorHoldStep({
            ...base,
            stableFrames: TIMELINE_ANCHOR_STABLE_FRAMES - 2,
        }).action).toBe('wait');
        expect(resolveTimelineAnchorHoldStep({
            ...base,
            stableFrames: TIMELINE_ANCHOR_STABLE_FRAMES - 1,
        }).action).toBe('release');
    });

    test('a transcript that never settles still releases at the ceiling', () => {
        expect(resolveTimelineAnchorHoldStep({
            ...base,
            drift: -400,
            elapsedMs: TIMELINE_ANCHOR_MAX_HOLD_MS,
        }).action).toBe('release');
    });

    test('an anchor with no measurable position releases instead of guessing', () => {
        expect(resolveTimelineAnchorHoldStep({ ...base, drift: null }).action).toBe('release');
    });
});
