/**
 * Coalesce ResizeObserver → measure writes.
 *
 * Each virtualized row used to read `offsetHeight` and call `resizeItem` /
 * `setItemSize` inside its own observer callback. A batch of rows revealing
 * together then forced layout once per row. Collect sizes from observer
 * entries (no layout read) and apply them in one `queueMicrotask`.
 */

import { flushSync } from 'react-dom';

export type ElementBoxSize = {
    width: number;
    height: number;
};

export type MicrotaskBatch<Key, Value> = {
    enqueue: (key: Key, value: Value) => void;
    flush: () => void;
    clear: () => void;
    pendingCount: () => number;
};

export const createMicrotaskBatch = <Key, Value>(
    apply: (batch: ReadonlyMap<Key, Value>) => void,
): MicrotaskBatch<Key, Value> => {
    const pending = new Map<Key, Value>();
    let scheduled = false;

    const flush = () => {
        scheduled = false;
        if (pending.size === 0) return;
        const batch = new Map(pending);
        pending.clear();
        apply(batch);
    };

    return {
        enqueue(key, value) {
            pending.set(key, value);
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(flush);
        },
        flush,
        clear() {
            pending.clear();
            scheduled = false;
        },
        pendingCount: () => pending.size,
    };
};

export const sizeFromResizeObserverEntry = (
    entry: ResizeObserverEntry,
): ElementBoxSize => {
    const box = entry.borderBoxSize?.[0];
    if (box) {
        return { width: box.inlineSize, height: box.blockSize };
    }
    return { width: entry.contentRect.width, height: entry.contentRect.height };
};

export type SharedElementSizeBatch = {
    observe: (element: Element) => void;
    unobserve: (element: Element) => void;
    disconnect: () => void;
};

/**
 * One ResizeObserver for many row roots. Sizes come from the entry, then
 * flush together so `setItemSize` / `resizeItem` cannot interleave layout.
 */
export const createSharedElementSizeBatch = (
    apply: (sizes: ReadonlyMap<Element, ElementBoxSize>) => void,
): SharedElementSizeBatch => {
    const batch = createMicrotaskBatch<Element, ElementBoxSize>(apply);
    const observer = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
                batch.enqueue(entry.target, sizeFromResizeObserverEntry(entry));
            }
        });

    return {
        observe(element) {
            observer?.observe(element);
        },
        unobserve(element) {
            observer?.unobserve(element);
        },
        disconnect() {
            observer?.disconnect();
            batch.clear();
        },
    };
};

type ResizeItemTarget = {
    resizeItem: (index: number, size: number) => void;
};

/**
 * Wrap TanStack `resizeItem` so a shared observer's per-entry callbacks
 * become one microtask of size writes (and one scroll-adjustment storm).
 */
export const installBatchedResizeItem = (virtualizer: ResizeItemTarget, afterMeasure?: () => void): () => void => {
    const original = virtualizer.resizeItem.bind(virtualizer);
    let disposing = false;
    const batch = createMicrotaskBatch<number, number>((items) => {
        const apply = () => {
            for (const [index, size] of items) original(index, size);
        };
        // Core changes scroll offsets while measuring. Commit the matching
        // React virtual padding in the same pre-paint microtask, not next frame.
        if (disposing) apply();
        else {
            flushSync(apply);
            afterMeasure?.();
        }
    });
    virtualizer.resizeItem = (index, size) => {
        batch.enqueue(index, size);
    };
    return () => {
        disposing = true;
        virtualizer.resizeItem = original;
        batch.flush();
    };
};
