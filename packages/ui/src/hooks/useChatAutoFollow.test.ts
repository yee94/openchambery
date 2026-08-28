import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isWithinSessionOpenPinGrace,
    SESSION_OPEN_PIN_GRACE_MS,
} from './useChatAutoFollow';

const here = dirname(fileURLToPath(import.meta.url));

describe('session-open pin grace', () => {
    test('ignores leftover gestures until the grace expires', () => {
        expect(isWithinSessionOpenPinGrace(100, 550)).toBe(true);
        expect(isWithinSessionOpenPinGrace(550, 550)).toBe(false);
        expect(isWithinSessionOpenPinGrace(551, 550)).toBe(false);
    });

    test('restoreSnapshot arms the grace and force-pins on mobile', () => {
        const source = readFileSync(join(here, 'useChatAutoFollow.ts'), 'utf8');
        expect(source).toContain('armSessionOpenPinGrace()');
        expect(source).toContain('forceBottomDefeatingMomentum()');
        expect(source).toContain('isWithinSessionOpenPinGrace(now(), sessionOpenPinGraceUntilRef.current)');
        expect(SESSION_OPEN_PIN_GRACE_MS).toBeGreaterThan(0);
    });
});
