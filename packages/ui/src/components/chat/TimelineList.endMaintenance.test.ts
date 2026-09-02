import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opening a session must land on its newest message.
 *
 * Rows arrive at their estimated heights, so the live edge keeps moving while
 * they are measured. An animated maintain pass scrolls toward the offset that
 * was current when it was requested, and a smooth scroll lasts long enough for
 * those measurements — plus a model still streaming — to leave that target far
 * short of the real end. The list coalesces every pass raised while one is in
 * flight into a single replay, so the catch-up gets two glides and stops. Its
 * proximity exemption then lapses, and a remaining gap wider than a tenth of a
 * screen retires end maintenance outright: the transcript is left parked
 * mid-conversation with follow permanently disengaged.
 *
 * Instant passes land exactly on the end every time, which is why only a
 * session that was actively streaming — the only one that asks for animation —
 * ever showed this.
 *
 * jsdom reports a zero-sized viewport for this list, so it mounts no rows,
 * produces no measurements and never finishes the initial scroll these passes
 * are driven by. The wiring is therefore read rather than run.
 */
describe('TimelineList end maintenance contracts', () => {
    const source = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');

    test('animation waits until the transcript has reached its live edge', () => {
        expect(source).toContain('animated: sessionIsWorking && endSettledOnce,');
        // Streaming alone must not authorize it: at open that is exactly the
        // state which strands the viewport.
        expect(source).not.toContain('animated: sessionIsWorking,');
    });

    test('the config recomputes when the latch flips', () => {
        const deps = source.indexOf(
            '}, [anchoredEndSpace, endSettledOnce, followEnabled, historyAnchor, parkReleased, sessionIsWorking]);',
        );
        expect(deps).toBeGreaterThan(-1);
    });

    /**
     * Starting false is what makes the opening catch-up race-free: the list
     * reads this config synchronously during its maintain pass, so a latch that
     * began true and was cleared by a later scroll event could still hand the
     * first pass an animated target.
     */
    test('the latch starts closed and reopens with each transcript', () => {
        expect(source).toContain('const [endSettledOnce, setEndSettledOnce] = React.useState(false);');
        expect(source).toContain('const endSettledOnceRef = React.useRef(false);');

        const reset = source.indexOf('endSettledOnceRef.current = false;');
        expect(reset).toBeGreaterThan(-1);
        expect(source.slice(reset, reset + 200)).toContain('setEndSettledOnce(false);');
        expect(source.slice(reset, reset + 200)).toContain('}, [timelineCacheKey]);');
        // Before paint, alongside the at-end edge detector it belongs with.
        expect(source.slice(reset - 400, reset)).toContain('React.useLayoutEffect');
    });

    test('the latch closes on the observed end and stays open afterwards', () => {
        const latch = source.indexOf('if (atEnd && !endSettledOnceRef.current) {');
        expect(latch).toBeGreaterThan(-1);
        const body = source.slice(latch, latch + 200);
        expect(body).toContain('endSettledOnceRef.current = true;');
        expect(body).toContain('setEndSettledOnce(true);');
        // One-way per transcript: leaving the end again is ordinary streaming
        // growth, which is the case the glide exists for.
        expect(source).not.toContain('setEndSettledOnce(!atEnd)');
        expect(source).not.toContain('if (!atEnd) setEndSettledOnce(false);');
    });

    /**
     * The latch is derived from the same reading the at-end signal is published
     * from, so it cannot disagree with what upstream believes about the edge.
     */
    test('the latch reads the same at-end resolution as the published signal', () => {
        const resolve = source.indexOf('const atEnd = parkedDistance !== null');
        expect(resolve).toBeGreaterThan(-1);
        // Parked and unparked distance come from one binding, so the re-arm
        // band and the scroll button cannot read different edges.
        expect(source).toContain('const distanceFromEnd = parkedDistance ?? resolveTimelineDistanceFromEnd(state);');
        expect(source.slice(resolve, resolve + 280)).toContain('resolveTimelineIsAtEnd(state) ?? state.isAtEnd');
        const latch = source.indexOf('if (atEnd && !endSettledOnceRef.current) {');
        expect(latch).toBeGreaterThan(resolve);
        expect(source.slice(resolve, latch)).toContain('onIsAtEndChange?.(atEnd, showScrollButton)');
    });

    /**
     * The scroll-to-bottom control re-arms follow and jumps in the same tick.
     * A still-running prepend hold would then restore the old read position
     * and swallow the jump. Reaching the live edge, or follow coming back on,
     * must drop the hold without waiting for the next React commit.
     */
    test('a jump to the live edge drops a held prepend anchor', () => {
        const holdStep = source.indexOf('if (resolveTimelineIsAtEnd(state) ?? state.isAtEnd)');
        expect(holdStep).toBeGreaterThan(-1);
        expect(source.slice(holdStep, holdStep + 160)).toContain('stop(true);');

        const followRelease = source.indexOf('if (!followEnabled) return;');
        expect(followRelease).toBeGreaterThan(-1);
        expect(source.slice(followRelease, followRelease + 120)).toContain('setHistoryAnchor(null);');
    });
});
