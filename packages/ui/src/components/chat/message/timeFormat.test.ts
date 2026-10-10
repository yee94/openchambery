import { describe, expect, test } from 'vitest';
import { formatAbsoluteMessageTimestamp } from './timeFormat';

describe('formatAbsoluteMessageTimestamp', () => {
    test('formats local date and minute, zero-padded, without seconds', () => {
        const timestamp = new Date(2026, 0, 5, 3, 4, 59).getTime();
        expect(formatAbsoluteMessageTimestamp(timestamp)).toBe('2026-01-05 03:04');
    });

    test('keeps afternoon hours in 24-hour form', () => {
        const timestamp = new Date(2026, 9, 10, 15, 53, 1).getTime();
        expect(formatAbsoluteMessageTimestamp(timestamp)).toBe('2026-10-10 15:53');
    });

    test('returns empty for invalid timestamps', () => {
        expect(formatAbsoluteMessageTimestamp(Number.NaN)).toBe('');
        expect(formatAbsoluteMessageTimestamp(Number.POSITIVE_INFINITY)).toBe('');
    });
});
