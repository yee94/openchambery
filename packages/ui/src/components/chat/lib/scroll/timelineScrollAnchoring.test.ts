import { describe, expect, test } from 'vitest';

import { didPrependTimelineEntries } from './timelineScrollAnchoring';

describe('didPrependTimelineEntries', () => {
    test('older history inserted above the read position is a prepend', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['a', 'b', 'c', 'd'])).toBe(true);
    });

    test('the streaming tail appending is not', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['c', 'd', 'e'])).toBe(false);
    });

    test('a live tail entry being replaced in place is not', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['c', 'd:2'])).toBe(false);
    });

    // Both ends can move in one commit: a prepend lands while the tail streams.
    test('a prepend that arrives with tail growth still counts', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['a', 'b', 'c', 'd', 'e'])).toBe(true);
    });

    test('switching sessions replaces every key and is not a prepend', () => {
        expect(didPrependTimelineEntries(['c', 'd'], ['x', 'y', 'z'])).toBe(false);
    });

    test('the first entries of an empty timeline are not a prepend', () => {
        expect(didPrependTimelineEntries([], ['a', 'b'])).toBe(false);
    });
});
