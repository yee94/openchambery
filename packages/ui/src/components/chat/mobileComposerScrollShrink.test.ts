import { describe, expect, test } from 'vitest';

import { resolveMobileComposerShrink } from './mobileComposerScrollShrink';

describe('resolveMobileComposerShrink', () => {
    test.each([
        [0, 0],
        [50, 0.5],
        [100, 1],
        [160, 1],
        [-20, 0],
    ])('maps distance %s to shrink %s', (distanceFromBottom, expected) => {
        expect(resolveMobileComposerShrink({
            distanceFromBottom,
            keyboardOpen: false,
            pinnedFull: false,
        })).toBe(expected);
    });

    test('keyboard lock keeps the composer fully expanded', () => {
        expect(resolveMobileComposerShrink({
            distanceFromBottom: 100,
            keyboardOpen: true,
            pinnedFull: false,
        })).toBe(0);
    });

    test('input pin keeps the composer fully expanded', () => {
        expect(resolveMobileComposerShrink({
            distanceFromBottom: 100,
            keyboardOpen: false,
            pinnedFull: true,
        })).toBe(0);
    });
});
