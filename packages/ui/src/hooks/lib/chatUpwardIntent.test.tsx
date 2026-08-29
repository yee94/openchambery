import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'vitest';

import { useHistoryUpwardIntent } from './chatUpwardIntent';

/**
 * Earlier history loads from two triggers: an ordinary scroll event, and an
 * explicit upward gesture. The second one is what covers "already at the top and
 * still pulling up", where no scroll event fires at all — so losing it means
 * older messages become unreachable rather than merely slow to arrive.
 *
 * These listeners used to live inside auto-follow, which the legend timeline
 * switches off. This suite pins them to the standalone hook instead.
 */
const mountHook = async (
    scrollRef: React.RefObject<HTMLDivElement | null>,
    onUpwardIntent: () => void,
    enabled = true,
) => {
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    scrollRef.current = scroller;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const Probe: React.FC = () => {
        useHistoryUpwardIntent({ scrollRef, enabled, onUpwardIntent });
        return null;
    };

    await act(async () => {
        root.render(<Probe />);
    });

    return {
        scroller,
        cleanup: async () => {
            await act(async () => {
                root.unmount();
            });
            host.remove();
            scroller.remove();
        },
    };
};

describe('useHistoryUpwardIntent', () => {
    test('fires on an upward wheel gesture', async () => {
        let calls = 0;
        const scrollRef = React.createRef<HTMLDivElement>();
        const { scroller, cleanup } = await mountHook(scrollRef, () => { calls += 1; });

        await act(async () => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
        });

        expect(calls).toBe(1);
        await cleanup();
    });

    test('ignores downward wheel gestures', async () => {
        let calls = 0;
        const scrollRef = React.createRef<HTMLDivElement>();
        const { scroller, cleanup } = await mountHook(scrollRef, () => { calls += 1; });

        await act(async () => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
        });

        expect(calls).toBe(0);
        await cleanup();
    });

    test('fires on release keys and ignores modified ones', async () => {
        let calls = 0;
        const scrollRef = React.createRef<HTMLDivElement>();
        const { scroller, cleanup } = await mountHook(scrollRef, () => { calls += 1; });

        await act(async () => {
            scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
            scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', metaKey: true, bubbles: true }));
        });

        expect(calls).toBe(1);
        await cleanup();
    });

    test('a nested scroller that can still scroll up consumes the gesture', async () => {
        let calls = 0;
        const scrollRef = React.createRef<HTMLDivElement>();
        const { scroller, cleanup } = await mountHook(scrollRef, () => { calls += 1; });

        const nested = document.createElement('div');
        scroller.appendChild(nested);
        Object.defineProperty(nested, 'scrollTop', { value: 20, configurable: true });
        Object.defineProperty(nested, 'scrollHeight', { value: 500, configurable: true });
        Object.defineProperty(nested, 'clientHeight', { value: 100, configurable: true });

        await act(async () => {
            nested.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
        });

        expect(calls).toBe(0);
        await cleanup();
    });

    test('attaches nothing while disabled', async () => {
        let calls = 0;
        const scrollRef = React.createRef<HTMLDivElement>();
        const { scroller, cleanup } = await mountHook(scrollRef, () => { calls += 1; }, false);

        await act(async () => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
        });

        expect(calls).toBe(0);
        await cleanup();
    });
});
