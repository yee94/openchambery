import { describe, expect, test } from 'bun:test';

import { getInitialHistoryOverscan, getNextHistoryOverscan } from './historyOverscan';

describe('history overscan staging', () => {
    test('uses the full product overscan on first paint when it fits the cold budget', () => {
        expect(getInitialHistoryOverscan(8)).toBe(8);
        expect(getInitialHistoryOverscan(1)).toBe(1);
        expect(getInitialHistoryOverscan(0)).toBe(0);
    });

    test('caps only when the product overscan exceeds the cold first-paint budget', () => {
        // Mobile product overscan is 16; cold paint stays at 8, then one jump.
        expect(getInitialHistoryOverscan(16)).toBe(8);
    });

    test('expands to the full target in a single step', () => {
        expect(getNextHistoryOverscan(8, 16)).toBe(16);
        expect(getNextHistoryOverscan(2, 8)).toBe(8);
        expect(getNextHistoryOverscan(8, 8)).toBe(8);
        expect(getNextHistoryOverscan(0, 16)).toBe(16);
    });
});
