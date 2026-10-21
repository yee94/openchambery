import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { VirtualItem } from '@tanstack/react-virtual';
import { shouldAdjustHistoryScrollOnItemSizeChange } from './historyItemSizeAdjustment';

const messageListSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../MessageList.tsx'),
    'utf8',
);

const item = (start: number, size: number): VirtualItem => ({ index: 0, key: 'row', start, size, end: start + size, lane: 0 });
const state = (scrollOffset: number, measured?: number) => ({
    scrollOffset,
    itemSizeCache: new Map(measured === undefined ? [] : [['row', measured]]),
});

describe('history row-size scroll adjustment', () => {
    test('compensates a hydrated row fully above an upward reader', () => {
        // Markdown hydration shrinks a row above the viewport after load-more
        // while the reader is scrolling backward; core skips this case.
        expect(shouldAdjustHistoryScrollOnItemSizeChange(item(1000, 750), -77, state(2039, 750))).toBe(true);
    });

    test('never compensates a row spanning the fold, so growth below the anchor stays put', () => {
        expect(shouldAdjustHistoryScrollOnItemSizeChange(item(1800, 600), 40, state(2039, 600))).toBe(false);
        expect(shouldAdjustHistoryScrollOnItemSizeChange(item(2100, 300), 40, state(2039, 300))).toBe(false);
    });

    test('MessageList installs the rule on the history virtualizer before batched resize', () => {
        // The rule is inert unless wired: TanStack falls back to its default,
        // which skips rows above an upward reader and reintroduces load-more jumps.
        expect(messageListSource).toMatch(
            /\.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustHistoryScrollOnItemSizeChange;\s*return installBatchedResizeItem\(/,
        );
    });

    test('first measurement compensates any row starting above the fold', () => {
        expect(shouldAdjustHistoryScrollOnItemSizeChange(item(1800, 320), 200, state(2039))).toBe(true);
        expect(shouldAdjustHistoryScrollOnItemSizeChange(item(2039, 320), 200, state(2039))).toBe(false);
    });
});
