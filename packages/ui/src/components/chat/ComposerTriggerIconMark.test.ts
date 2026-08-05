import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    composerTriggerIconDisplay,
    composerTriggerIconVisual,
} from '@/composer/inline-visual';

const markSource = readFileSync(
    join(import.meta.dir, 'ComposerTriggerIconMark.tsx'),
    'utf8',
);

describe('ComposerTriggerIconMark', () => {
    test('reserved slash chips keep the ordinary equal-inset contract', () => {
        const spec = { trigger: '/', icon: 'command', label: 'release' };
        const display = composerTriggerIconDisplay(spec);
        expect(composerTriggerIconVisual(spec, display)).toMatchObject({
            trigger: '/\u2003',
            label: 'release',
            slot: 'reserved',
        });
        expect(markSource).toContain('COMPOSER_TRIGGER_ICON_LABEL_GAP');
        expect(markSource).toContain('align-baseline');
        // overflow-hidden on the trigger span breaks the alphabetic baseline and
        // lifts the icon above the label — keep the ordinary command alignment.
        expect(markSource).not.toMatch(/className="[^"]*overflow-hidden/);
        expect(markSource).not.toMatch(/className=\{[^}]*overflow-hidden/);
    });
});
