import { describe, expect, test } from 'bun:test';

import { getInitialHistoryOverscan, getNextHistoryOverscan } from './historyOverscan';

describe('history overscan staging', () => {
    test('starts with a narrow mount window', () => {
        expect(getInitialHistoryOverscan(8)).toBe(2);
        expect(getInitialHistoryOverscan(1)).toBe(1);
    });

    test('expands incrementally without exceeding the target', () => {
        expect(getNextHistoryOverscan(2, 8)).toBe(4);
        expect(getNextHistoryOverscan(7, 8)).toBe(8);
        expect(getNextHistoryOverscan(8, 8)).toBe(8);
    });
});
