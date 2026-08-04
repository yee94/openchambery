import { describe, expect, test } from 'bun:test';
import {
    COMPOSER_TRIGGER_ICON_SLOT,
    parseSlashCommandInvocation,
    stripComposerTriggerIconSlotsForPlainText,
} from './inline-visual';

describe('stripComposerTriggerIconSlotsForPlainText', () => {
    test('strips reserved slots from slash, session, and citation chips', () => {
        expect(stripComposerTriggerIconSlotsForPlainText(
            `/${COMPOSER_TRIGGER_ICON_SLOT}release  包含当前所有 changes`,
        )).toBe('/release  包含当前所有 changes');
        expect(stripComposerTriggerIconSlotsForPlainText(
            `@${COMPOSER_TRIGGER_ICON_SLOT}Prior chat [${COMPOSER_TRIGGER_ICON_SLOT}shot.png]`,
        )).toBe('@Prior chat [shot.png]');
    });

    test('leaves compact chips and ordinary text unchanged', () => {
        expect(stripComposerTriggerIconSlotsForPlainText('/release keep going')).toBe('/release keep going');
        expect(stripComposerTriggerIconSlotsForPlainText('plain prose')).toBe('plain prose');
    });
});

describe('parseSlashCommandInvocation', () => {
    test('parses compact slash heads and trailing arguments', () => {
        expect(parseSlashCommandInvocation('/release')).toEqual({
            commandName: 'release',
            argumentsText: '',
        });
        expect(parseSlashCommandInvocation('/release  包含当前所有 changes 来一个提交发布 g')).toEqual({
            commandName: 'release',
            argumentsText: '包含当前所有 changes 来一个提交发布 g',
        });
    });

    test('does not treat the reserved icon em-space as an argument separator', () => {
        expect(parseSlashCommandInvocation(
            `/${COMPOSER_TRIGGER_ICON_SLOT}release  包含当前所有 changes 来一个提交发布 g`,
        )).toEqual({
            commandName: 'release',
            argumentsText: '包含当前所有 changes 来一个提交发布 g',
        });
        expect(parseSlashCommandInvocation(`/${COMPOSER_TRIGGER_ICON_SLOT}undo`)).toEqual({
            commandName: 'undo',
            argumentsText: '',
        });
    });

    test('rejects non-slash text and a bare slash chip without a name', () => {
        expect(parseSlashCommandInvocation('release please')).toBeNull();
        expect(parseSlashCommandInvocation(`/${COMPOSER_TRIGGER_ICON_SLOT}`)).toBeNull();
        expect(parseSlashCommandInvocation('/')).toBeNull();
    });
});
