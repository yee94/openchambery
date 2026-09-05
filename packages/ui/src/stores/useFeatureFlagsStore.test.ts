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
    test('the current Markdown renderer stays default unless oc:markstream-react is exactly 1', () => {
        expect(readMarkstreamReactEnabled(null)).toBe(false);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, null))).toBe(false);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, ''))).toBe(false);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, '0'))).toBe(false);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, 'true'))).toBe(false);
        expect(readMarkstreamReactEnabled(memoryStorage(MARKSTREAM_REACT_STORAGE_KEY, '1'))).toBe(true);
    });

    test('a throwing storage reader stays on the current Markdown renderer', () => {
        expect(readMarkstreamReactEnabled({
            getItem: () => {
                throw new Error('blocked');
            },
        })).toBe(false);
    });
});
