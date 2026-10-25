import { describe, expect, test, vi } from 'vitest';

import {
    MARKSTREAM_REACT_STORAGE_KEY,
    readMarkstreamReactEnabled,
} from './useFeatureFlagsStore';

const memoryStorage = (
    key: string,
    value: string | null,
): Pick<Storage, 'getItem'> => ({
    getItem: (requested) => (requested === key ? value : null),
});

describe('retired timeline flag', () => {
    test('ignores a persisted Legend opt-in at store initialization', async () => {
        const getItem = vi.fn((key: string) => key === 'oc:legend-timeline' ? '1' : null);
        vi.stubGlobal('localStorage', { getItem });
        vi.resetModules();
        try {
            const { useFeatureFlagsStore } = await import('./useFeatureFlagsStore');
            expect(getItem).not.toHaveBeenCalledWith('oc:legend-timeline');
            expect(useFeatureFlagsStore.getState()).not.toHaveProperty('legendTimelineEnabled');
            expect(useFeatureFlagsStore.getState()).not.toHaveProperty('setLegendTimelineEnabled');
            expect(useFeatureFlagsStore.getState().markstreamReactEnabled).toBe(true);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
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
