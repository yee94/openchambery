import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    TIMELINE_ANCHORING_ATTRIBUTE,
    TIMELINE_PREPEND_SETTLE_MS,
} from './lib/scroll/timelineScrollAnchoring';
import { TimelineList } from './TimelineList';

/**
 * Loading older history inserts rows above the read position at their estimated
 * heights; they are measured a frame or two later, and those corrections are
 * only invisible while the list is compensating for them. The list is told to
 * compensate for a bounded window after each prepend, and it announces that
 * window on its scroll element so the mobile composer's scroll observer can sit
 * the re-anchoring out instead of reading it as a gesture.
 */
const TUNING = {
    resolvePreloadEntries: () => 2,
    resolvePreloadReleaseWhileScrolling: () => 1,
    resolveVisibleReleaseLimit: () => 4,
};

type Entry = { key: string; kind: string };

const entries = (...keys: string[]): Entry[] => keys.map((key) => ({ key, kind: 'turn' }));

describe('TimelineList prepend settle window', () => {
    let host: HTMLElement;
    let root: Root;
    let scrollRef: React.RefObject<HTMLDivElement | null>;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        host = document.createElement('div');
        document.body.appendChild(host);
        scrollRef = React.createRef<HTMLDivElement>();
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        host.remove();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    const render = async (rows: Entry[]) => {
        await act(async () => {
            root.render(
                <TimelineList<Entry>
                    entries={rows}
                    timelineCacheKey="test::prepend"
                    estimatedItemSize={40}
                    hydrationTuning={TUNING}
                    renderEntry={(entry) => <div>{entry.key}</div>}
                    scrollElementRef={scrollRef}
                />,
            );
        });
    };

    const isAnchoring = () => scrollRef.current?.hasAttribute(TIMELINE_ANCHORING_ATTRIBUTE) ?? false;

    test('announces re-anchoring while a prepend settles, then releases it', async () => {
        await render(entries('turn-3', 'turn-4'));
        expect(isAnchoring()).toBe(false);

        await render(entries('turn-1', 'turn-2', 'turn-3', 'turn-4'));
        expect(isAnchoring()).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(TIMELINE_PREPEND_SETTLE_MS + 1);
        });
        expect(isAnchoring()).toBe(false);
    });

    test('a second prepend restarts the window', async () => {
        await render(entries('turn-3', 'turn-4'));
        await render(entries('turn-2', 'turn-3', 'turn-4'));
        expect(isAnchoring()).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(TIMELINE_PREPEND_SETTLE_MS - 100);
        });
        await render(entries('turn-1', 'turn-2', 'turn-3', 'turn-4'));

        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        expect(isAnchoring()).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(TIMELINE_PREPEND_SETTLE_MS);
        });
        expect(isAnchoring()).toBe(false);
    });

    test('the streaming tail appending is not a prepend', async () => {
        await render(entries('turn-3', 'turn-4'));
        await render(entries('turn-3', 'turn-4', 'turn-5'));
        expect(isAnchoring()).toBe(false);
    });
});
