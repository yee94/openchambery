import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { TimelineList } from './TimelineList';

const here = dirname(fileURLToPath(import.meta.url));

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

const SCROLL_DATASET = { scrollbar: 'chat', scrollShadow: 'true', orientation: 'vertical' };

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
        expect(scrollRef.current?.dataset.scrollShadow).toBe('true');
        expect(scrollRef.current?.dataset.orientation).toBe('vertical');
        expect(host.querySelector('[data-scrollbar="chat"]')).toBe(scrollRef.current);

        await cleanup();
    });
});

describe('TimelineList scroll-shadow wiring', () => {
    test('keeps the list-owned scroller on the same mask the old viewport used', () => {
        const timelineSource = readFileSync(join(here, 'TimelineList.tsx'), 'utf-8');
        const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf-8');
        expect(timelineSource).toContain('prepareScrollShadowElement');
        expect(timelineSource).toContain('applyVerticalScrollShadow');
        expect(messageListSource).toContain('hideTopScrollShadow={isMobile && stickyUserHeader}');
        expect(messageListSource).toContain('hideBottomScrollShadow={isMobile}');
    });
});
