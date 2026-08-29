import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Loading older history must not move what the reader is looking at.
 *
 * The list restores content position across a prepend on its own, but it picks
 * its own anchor, and for a load-older tap that choice is wrong: the reader is
 * at the very top, so the rows that arrive above them become the first rows in
 * view — at their ESTIMATED heights. The list then holds an estimated row still
 * while it is measured, and each correction lands above the reader.
 *
 * The geometry and the hold policy are unit-tested in
 * ./lib/scroll/timelinePrependAnchor.test.ts. What cannot be driven from a test
 * DOM is the wiring: this list reports a zero-sized viewport in jsdom, so it
 * mounts no rows, produces no measurements and never finishes the initial
 * scroll the hold observes. Those parts are therefore read rather than run.
 */
describe('TimelineList prepend anchor contracts', () => {
    const source = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');

    /**
     * The commit that delivers the prepend is too late for any of this. The
     * list absorbs the data change inside it, so an anchor published by an
     * effect afterwards misses the only frame it could have influenced — and
     * end maintenance, still armed for that frame, takes the viewport to the
     * live edge, which is a whole conversation away rather than a few pixels.
     */
    test('the read position is captured when the load is requested', () => {
        const armStart = source.indexOf('if (historyAnchorToken <= 0) return;');
        expect(armStart).toBeGreaterThan(-1);

        // Before paint, and from a fresh read: nothing has moved yet, so this
        // is the position the reader is actually looking at.
        expect(source.slice(0, armStart)).toMatch(/React\.useLayoutEffect\(\(\) => \{\s*$/m);
        const armBody = source.slice(armStart, armStart + 600);
        expect(armBody).toContain('captureTimelineAnchorArm(list.getState(), entryKeysRef.current)');
        expect(armBody).toContain('holding: false');
    });

    test('end maintenance stands down from the request, not from the commit', () => {
        // Once the list's maintain pass has latched it stops caring how far the
        // viewport is from the end and simply scrolls there, so the stand-down
        // cannot wait for the rows to arrive.
        expect(source).toContain(
            'if ((anchoredEndSpace && !parkReleased) || !followEnabled || historyAnchor) return false;',
        );
        // Being at the live edge is not a reason to skip anchoring: that is
        // precisely the state in which the prepend pins to the newest message.
        expect(source).not.toContain('if (lastIsAtEndRef.current) return;');
    });

    test('the row filter excludes the newcomers and keeps older rows eligible', () => {
        // The list treats shouldRestorePosition as a hard filter over the rows
        // in view and compensates by NOTHING when none of them passes, so
        // naming a single row forfeits all compensation on any frame where that
        // row is off screen.
        expect(source).toMatch(
            /shouldRestorePosition:\s*\(entry: \{ key: string \}\) => knownKeys\.has\(entry\.key\)/,
        );
        expect(source).not.toContain('entry.key === anchorKey');
        // Size compensation is unconditional while a row is held: the inserted
        // block keeps resizing past the fixed settle window, and an expired
        // window leaves those later corrections uncompensated.
        expect(source).toMatch(/size:\s*true,\s*\n\s*shouldRestorePosition/);
    });

    test('the hold clock starts when the rows land, not when they were asked for', () => {
        // "Has it stopped moving" only means something once something is
        // moving; counting quiet frames during the fetch would retire the
        // anchor before its rows ever arrived.
        expect(source).toContain("if (!historyAnchor?.holding) return;");
        const promotion = source.indexOf('current === null || current.holding ? current');
        expect(promotion).toBeGreaterThan(-1);
        expect(source.slice(0, promotion)).toContain('didPrependTimelineEntries(previous, entryKeys)');
    });

    test('an arm whose rows never arrive lets go by itself', () => {
        // It holds end maintenance down, so a failed request — or history that
        // turned out to have nothing older — must not leave the live edge
        // unmaintained for the rest of the session.
        expect(source).toContain('TIMELINE_ANCHOR_ARM_EXPIRY_MS');
        const expiry = source.indexOf('TIMELINE_ANCHOR_ARM_EXPIRY_MS)');
        expect(expiry).toBeGreaterThan(-1);
        // Scoped to the arm it was scheduled for, so it cannot cancel a hold
        // or a later arm.
        expect(source.slice(expiry - 400, expiry))
            .toContain("current?.token === token && !current.holding");
    });

    test('corrections are absolute and go through the list, never scrollTop', () => {
        expect(source).toContain('list.scrollToOffset({ offset: target, animated: false })');
        // A relative per-frame writer racing the list's own adjustment pass is
        // what produced the multi-thousand-pixel load-more swaps.
        expect(source).not.toMatch(/scrollTop\s*(\+=|-=|=)/);
    });

    test('the reader taking over ends the hold', () => {
        expect(source).toMatch(/'touchstart', 'touchmove', 'wheel', 'pointerdown', 'keydown'/);
        expect(source).toContain('const releaseToUser = () => {');
    });

    /**
     * The list adjusts the scroll position during the prepend commit, and the
     * browser dispatches the resulting scroll event before a passive effect
     * would have raised the flag. The mobile composer reads that one unflagged
     * frame — a large distance change with no gesture behind it — as a swipe and
     * flashes open, which is the regression this ordering prevents.
     */
    test('the anchoring flag is raised before paint', () => {
        const flagEffect = source.indexOf('const timelineAnchoring = prependSettling');
        expect(flagEffect).toBeGreaterThan(-1);
        expect(source.slice(flagEffect, flagEffect + 400)).toContain('React.useLayoutEffect');
    });

    test('the hold is bounded rather than left running', () => {
        expect(source).toContain('resolveTimelineAnchorHoldStep');
        expect(source).toContain("if (outcome.action === 'release')");
        expect(source).toContain('window.cancelAnimationFrame(frame)');
        expect(source).toContain('return () => {\n            stop(false);');
    });

    /**
     * The at-end signal published upstream is edge-triggered off a ref, and a
     * stale ref stops publishing silently: a swapped-in session opens at the
     * live edge, so a ref still reading "away from the end" from the previous
     * transcript matches the first real reading and no edge ever fires again.
     * Upstream then keeps the `true` it assumed on the swap, and every decision
     * gated on being away from the end reads the wrong answer.
     */
    test('the at-end edge detector resets with the transcript', () => {
        const reset = source.indexOf('lastIsAtEndRef.current = true;');
        expect(reset).toBeGreaterThan(-1);
        expect(source.slice(reset - 200, reset)).toContain('React.useLayoutEffect');
        expect(source.slice(reset, reset + 240)).toContain('}, [timelineCacheKey]);');
    });
});
