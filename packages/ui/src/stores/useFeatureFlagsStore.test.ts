import { describe, expect, test } from 'vitest';

import { LEGEND_TIMELINE_STORAGE_KEY, readLegendTimelineEnabled } from './useFeatureFlagsStore';

const memoryStorage = (value: string | null): Pick<Storage, 'getItem'> => ({
    getItem: (key) => (key === LEGEND_TIMELINE_STORAGE_KEY ? value : null),
});

describe('readLegendTimelineEnabled', () => {
    test('TanStack is the runtime default unless oc:legend-timeline is exactly 1', () => {
        expect(readLegendTimelineEnabled(null)).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(null))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(''))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage('0'))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage('true'))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage('1'))).toBe(true);
    });

    test('a throwing storage reader stays on TanStack', () => {
        expect(readLegendTimelineEnabled({
            getItem: () => {
                throw new Error('blocked');
            },
        })).toBe(false);
    });
});
