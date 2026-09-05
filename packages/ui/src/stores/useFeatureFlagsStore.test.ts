import { describe, expect, test } from 'vitest';

import {
    LEGEND_TIMELINE_STORAGE_KEY,
    MARKSTREAM_REACT_STORAGE_KEY,
    readLegendTimelineEnabled,
    readMarkstreamReactEnabled,
} from './useFeatureFlagsStore';

const memoryStorage = (
    key: string,
    value: string | null,
): Pick<Storage, 'getItem'> => ({
    getItem: (requested) => (requested === key ? value : null),
});

describe('readLegendTimelineEnabled', () => {
    test('TanStack is the runtime default unless oc:legend-timeline is exactly 1', () => {
        expect(readLegendTimelineEnabled(null)).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(LEGEND_TIMELINE_STORAGE_KEY, null))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(LEGEND_TIMELINE_STORAGE_KEY, ''))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(LEGEND_TIMELINE_STORAGE_KEY, '0'))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(LEGEND_TIMELINE_STORAGE_KEY, 'true'))).toBe(false);
        expect(readLegendTimelineEnabled(memoryStorage(LEGEND_TIMELINE_STORAGE_KEY, '1'))).toBe(true);
    });

    test('a throwing storage reader stays on TanStack', () => {
        expect(readLegendTimelineEnabled({
            getItem: () => {
                throw new Error('blocked');
            },
        })).toBe(false);
    });
});

describe('readMarkstreamReactEnabled', () => {
    test('Markstream is the default unless oc:markstream-react is exactly 0', () => {
        expect(readMarkstreamReactEnabled(null)).toBe(true);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, null))).toBe(true);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, ''))).toBe(true);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, '1'))).toBe(true);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, 'true'))).toBe(true);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, '0'))).toBe(false);
    });

    test('a throwing storage reader stays on Markstream', () => {
        expect(readMarkstreamReactEnabled({
            getItem: () => {
                throw new Error('blocked');
            },
        })).toBe(true);
    });
});
