import { describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
    createMicrotaskBatch,
    createSharedElementSizeBatch,
    installBatchedResizeItem,
    sizeFromResizeObserverEntry,
} from './batchResizeUpdates';

describe('createMicrotaskBatch', () => {
    test('coalesces same-tick enqueues into one apply with last-write-wins keys', async () => {
        const applied: Array<Array<[string, number]>> = [];
        const batch = createMicrotaskBatch<string, number>((items) => {
            applied.push([...items.entries()]);
        });

        batch.enqueue('a', 10);
        batch.enqueue('b', 20);
        batch.enqueue('a', 11);
        expect(applied).toEqual([]);
        expect(batch.pendingCount()).toBe(2);

        await Promise.resolve();
        expect(applied).toEqual([[['a', 11], ['b', 20]]]);
        expect(batch.pendingCount()).toBe(0);

        batch.enqueue('c', 3);
        await Promise.resolve();
        expect(applied).toEqual([
            [['a', 11], ['b', 20]],
            [['c', 3]],
        ]);
    });

    test('flush applies immediately and a later microtask is a no-op', async () => {
        const apply = vi.fn();
        const batch = createMicrotaskBatch<string, number>(apply);
        batch.enqueue('a', 1);
        batch.flush();
        expect(apply).toHaveBeenCalledTimes(1);
        expect([...apply.mock.calls[0][0].entries()]).toEqual([['a', 1]]);
        await Promise.resolve();
        expect(apply).toHaveBeenCalledTimes(1);
    });
});

describe('sizeFromResizeObserverEntry', () => {
    test('prefers border-box sizes so callers never read offsetHeight', () => {
        expect(sizeFromResizeObserverEntry({
            borderBoxSize: [{ inlineSize: 400, blockSize: 120 }],
            contentRect: { width: 1, height: 2 },
        } as unknown as ResizeObserverEntry)).toEqual({ width: 400, height: 120 });

        expect(sizeFromResizeObserverEntry({
            contentRect: { width: 80, height: 24 },
        } as unknown as ResizeObserverEntry)).toEqual({ width: 80, height: 24 });
    });
});

describe('installBatchedResizeItem', () => {
    test('commits React padding once in the measurement microtask, alongside core scroll changes', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let setPadding!: React.Dispatch<React.SetStateAction<number>>;
        let commits = 0;
        const Frame = () => {
            const [padding, update] = React.useState(0);
            setPadding = update;
            React.useLayoutEffect(() => { commits += 1; });
            return React.createElement('div', { style: { paddingTop: padding } });
        };
        await act(async () => { root.render(React.createElement(Frame)); });
        let scrollOffset = 0;
        const virtualizer = { resizeItem: (_index: number, size: number) => {
            scrollOffset += size;
            setPadding(value => value + size);
        } };
        const verifiedPadding: string[] = [];
        const restore = installBatchedResizeItem(virtualizer, () => {
            verifiedPadding.push((host.firstElementChild as HTMLElement).style.paddingTop);
        });
        try {
            await act(async () => {
                virtualizer.resizeItem(0, 32.25);
                virtualizer.resizeItem(1, 44.5);
                await Promise.resolve();
                expect(scrollOffset).toBe(76.75);
                expect((host.firstElementChild as HTMLElement).style.paddingTop).toBe('76.75px');
                expect(commits).toBe(2);
                expect(verifiedPadding).toEqual(['76.75px']);
            });
        } finally {
            restore();
            await act(async () => { root.unmount(); });
            host.remove();
        }
    });

    test('defers per-row resizeItem until one microtask', async () => {
        const calls: Array<[number, number]> = [];
        const virtualizer = {
            resizeItem: (index: number, size: number) => {
                calls.push([index, size]);
            },
        };
        const restore = installBatchedResizeItem(virtualizer);
        virtualizer.resizeItem(0, 100);
        virtualizer.resizeItem(1, 200);
        virtualizer.resizeItem(0, 110);
        expect(calls).toEqual([]);
        await Promise.resolve();
        expect(calls).toEqual([[0, 110], [1, 200]]);
        restore();
        virtualizer.resizeItem(2, 50);
        expect(calls).toEqual([[0, 110], [1, 200], [2, 50]]);
    });
});

describe('createSharedElementSizeBatch', () => {
    test('one observer callback enqueues every entry before apply', async () => {
        const applied: Element[] = [];
        const observed: Element[] = [];
        const callbacks: ResizeObserverCallback[] = [];
        const Original = globalThis.ResizeObserver;
        class FakeObserver {
            constructor(callback: ResizeObserverCallback) {
                callbacks.push(callback);
            }
            observe(element: Element) {
                observed.push(element);
            }
            unobserve() {}
            disconnect() {}
        }
        globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
        try {
            const a = document.createElement('div');
            const b = document.createElement('div');
            const batch = createSharedElementSizeBatch((sizes) => {
                applied.push(...sizes.keys());
            });
            batch.observe(a);
            batch.observe(b);
            expect(observed).toEqual([a, b]);
            const listener = callbacks[0];
            if (!listener) throw new Error('expected ResizeObserver callback');
            listener(
                [
                    { target: a, borderBoxSize: [{ inlineSize: 10, blockSize: 20 }], contentRect: { width: 10, height: 20 } },
                    { target: b, borderBoxSize: [{ inlineSize: 10, blockSize: 40 }], contentRect: { width: 10, height: 40 } },
                ] as unknown as ResizeObserverEntry[],
                {} as ResizeObserver,
            );
            expect(applied).toEqual([]);
            await Promise.resolve();
            expect(applied).toEqual([a, b]);
            batch.disconnect();
        } finally {
            globalThis.ResizeObserver = Original;
        }
    });
});
