import { describe, expect, test } from 'vitest';

import {
    COMPACT_MOBILE_COMPOSER_HEIGHT_PX,
    compensateMobileComposerDistance,
    resolveMobileComposerShrink,
} from './mobileComposerScrollShrink';

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

describe('compensateMobileComposerDistance', () => {
    test('is identity while fully expanded', () => {
        expect(compensateMobileComposerDistance(50, 0, 112)).toBe(50);
        expect(compensateMobileComposerDistance(50, -3, 112)).toBe(50);
    });

    test('adds back the retracted stage pixels', () => {
        const stage = 112;
        const retracted = stage - COMPACT_MOBILE_COMPOSER_HEIGHT_PX;
        expect(compensateMobileComposerDistance(30, 1, stage)).toBe(30 + retracted);
        expect(compensateMobileComposerDistance(30, 0.5, stage)).toBe(30 + 0.5 * retracted);
    });

    test('clamps shrink input and never subtracts', () => {
        expect(compensateMobileComposerDistance(30, 5, 112)).toBe(30 + (112 - COMPACT_MOBILE_COMPOSER_HEIGHT_PX));
        expect(compensateMobileComposerDistance(30, 1, 20)).toBe(30);
        expect(compensateMobileComposerDistance(30, 1, 0)).toBe(30);
    });
});
