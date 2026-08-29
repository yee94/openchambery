import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'vitest';

import { TimelineList } from './TimelineList';

/**
 * The DOM-based chat machinery (overlay scrollbar, `data-turn-entry` lookups,
 * viewport anchor capture, scroll spy) resolves the scroll container from a
 * single `scrollRef`. On this path the list owns that container, and the list's
 * `refScrollView` publishes a ScrollView *methods* object rather than an
 * element — so without unwrapping, every one of those consumers would silently
 * no-op against a non-element.
 */
const TUNING = {
    resolvePreloadEntries: () => 2,
    resolvePreloadReleaseWhileScrolling: () => 1,
    resolveVisibleReleaseLimit: () => 4,
};

const SCROLL_DATASET = { scrollbar: 'chat' };

const renderTimeline = async (scrollRef: React.RefObject<HTMLDivElement | null>) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
        root.render(
            <TimelineList<{ key: string; kind: string }>
                entries={[{ key: 'a', kind: 'turn' }, { key: 'b', kind: 'turn' }]}
                timelineCacheKey="test::timeline"
                estimatedItemSize={40}
                hydrationTuning={TUNING}
                renderEntry={(entry) => <div>{entry.key}</div>}
                scrollElementRef={scrollRef}
                scrollElementDataset={SCROLL_DATASET}
                className="chat-scroll"
            />,
        );
    });

    return {
        host,
        cleanup: async () => {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        },
    };
};

describe('TimelineList scroll element bridge', () => {
    test('publishes the list-owned scroll element as a real element', async () => {
        const scrollRef = React.createRef<HTMLDivElement>();
        const { cleanup } = await renderTimeline(scrollRef);

        expect(scrollRef.current).toBeInstanceOf(HTMLElement);
        expect(typeof scrollRef.current?.scrollTop).toBe('number');
        expect(typeof scrollRef.current?.querySelector).toBe('function');

        await cleanup();
    });

    // Row-level assertions are deliberately absent: the test DOM reports 0×0
    // layout, so the list resolves an empty viewport and mounts no rows. What
    // matters here is which object reaches `scrollRef`, which is layout-independent.

    test('the published element is the scroller the class name landed on', async () => {
        const scrollRef = React.createRef<HTMLDivElement>();
        const { cleanup } = await renderTimeline(scrollRef);

        expect(scrollRef.current?.classList.contains('chat-scroll')).toBe(true);

        await cleanup();
    });

    /**
     * `data-scrollbar="chat"` is not decoration: attachments, the activity
     * disclosure scroll compensation and the transcript container fallback all
     * find the scroller with `closest('[data-scrollbar="chat"]')`, the chat
     * scrollbar skin is keyed on it, and the mobile head inset selector hangs
     * off it. The old path declared it in JSX; here it can only be written when
     * the list publishes its element.
     */
    test('writes the dataset consumers resolve the scroller by', async () => {
        const scrollRef = React.createRef<HTMLDivElement>();
        const { host, cleanup } = await renderTimeline(scrollRef);

        expect(scrollRef.current?.dataset.scrollbar).toBe('chat');
        expect(host.querySelector('[data-scrollbar="chat"]')).toBe(scrollRef.current);

        await cleanup();
    });
});
