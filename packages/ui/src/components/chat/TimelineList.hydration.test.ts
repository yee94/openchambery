import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Rows mount as placeholders and swap in rich Markdown once a hydration pass
 * releases them. Visible rows may only be released while the transcript is
 * settled, because swapping under the user's eyes mid-scroll moves what they
 * are reading — so the settled pass is the only one that can hydrate the rows a
 * scroll just brought into view.
 *
 * Scroll events are the only thing this list reports, and the pass a scroll
 * schedules runs in that same frame, where nothing is settled yet. Without a
 * pass that runs *after* the scrolling stops, the settled branch is unreachable:
 * rows a fast scroll carried past the preload window were withheld and then
 * never reconsidered, so they sat as placeholders until the transcript was
 * remounted. This is a source contract because the list drops scroll events
 * from a zero-sized viewport and defers its public `onScroll` until an initial
 * scroll it never finishes in jsdom — the wiring cannot be driven from a test
 * DOM, only read.
 */
describe('TimelineList Markdown hydration trigger contract', () => {
    const source = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');

    test('the trailing pass lands past the settle threshold', () => {
        expect(source).toContain('const TIMELINE_SCROLL_IDLE_MS = 100;');
        expect(source).toContain(
            'const TIMELINE_HYDRATION_IDLE_PASS_MS = TIMELINE_SCROLL_IDLE_MS + 16;',
        );
        expect(source).toMatch(
            /idleHydrationTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*?scheduleMarkdownHydration\(\);[\s\S]*?\}, TIMELINE_HYDRATION_IDLE_PASS_MS\);/,
        );
    });

    test('arming is debounced, so a continuing scroll pushes the pass back', () => {
        expect(source).toMatch(
            /const armIdleMarkdownHydration = useEvent\(\(\) => \{[\s\S]*?window\.clearTimeout\(idleHydrationTimerRef\.current\)/,
        );
    });

    test('every scroll arms the pass that runs once scrolling stops', () => {
        const handleScroll = source.slice(source.indexOf('const handleScroll = useEvent('));
        const body = handleScroll.slice(0, handleScroll.indexOf('\n    });'));
        expect(body).toContain('scheduleMarkdownHydration();');
        expect(body).toContain('armIdleMarkdownHydration();');
    });

    test('a capped release schedules the pass that finishes the window', () => {
        const release = source.slice(source.indexOf('const releaseMarkdownHydration = useEvent('));
        const body = release.slice(0, release.indexOf('\n    });'));
        // Only reached once there is something to release, so the loop ends on
        // the first pass that finds the window fully hydrated.
        expect(body).toMatch(
            /if \(batch\.length === 0\) return;[\s\S]*?armIdleMarkdownHydration\(\);/,
        );
    });

    test('the pending pass is dropped on unmount', () => {
        expect(source).toMatch(
            /React\.useEffect\(\(\) => \(\) => \{[\s\S]*?window\.clearTimeout\(idleHydrationTimerRef\.current\);[\s\S]*?\}, \[\]\);/,
        );
    });
});
