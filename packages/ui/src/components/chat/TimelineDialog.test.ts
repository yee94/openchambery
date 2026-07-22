import { describe, expect, test } from 'bun:test';

import { PRIMARY_SESSION_SURFACE_CAPABILITIES } from './SessionSurfaceContext';
import { getTimelineActionAvailability } from './timelineActions';

describe('TimelineDialog actions', () => {
    test('keeps revert available and hides fork on the Assistant surface', () => {
        expect(getTimelineActionAvailability({
            ...PRIMARY_SESSION_SURFACE_CAPABILITIES,
            forkSession: false,
        })).toEqual({ revert: true, fork: false });
    });

    test('shows revert and fork on the primary surface', () => {
        expect(getTimelineActionAvailability(PRIMARY_SESSION_SURFACE_CAPABILITIES)).toEqual({
            revert: true,
            fork: true,
        });
    });
});
