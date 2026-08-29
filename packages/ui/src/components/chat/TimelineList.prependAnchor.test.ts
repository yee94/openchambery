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

    test('the held row is named to the list, so it cannot anchor on an inserted row', () => {
        expect(source).toContain('shouldRestorePosition');
        expect(source).toMatch(/shouldRestorePosition:\s*\(entry: TEntry\) => entry\.key === anchorKey/);
        // Size compensation is unconditional while a row is held: the inserted
        // block keeps resizing past the fixed settle window, and an expired
        // window leaves those later corrections uncompensated.
        expect(source).toMatch(/size:\s*true,\s*\n\s*shouldRestorePosition/);
    });

    test('corrections are absolute and go through the list, never scrollTop', () => {
        expect(source).toContain('list.scrollToOffset({ offset: target, animated: false })');
        // A relative per-frame writer racing the list's own adjustment pass is
        // what produced the multi-thousand-pixel load-more swaps.
        expect(source).not.toMatch(/scrollTop\s*(\+=|-=|=)/);
    });

    test('the anchor is only chosen from state that predates the prepend commit', () => {
        expect(source).toContain('candidate.headKey !== previous[0]');
        // Refreshed from frames that already read the list state, because by
        // commit time the rows have moved.
        expect(source).toContain('refreshAnchorCandidate(state)');
    });

    test('anchoring and end maintenance never both own the scroll position', () => {
        expect(source).toContain('if (lastIsAtEndRef.current) return;');
        expect(source).toMatch(/if \(anchoredEndSpace \|\| !followEnabled \|\| prependAnchor\) return false;/);
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
});
