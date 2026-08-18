import { describe, expect, test } from 'bun:test';

import {
    findAttachmentCitationRanges,
    isInlineAttachmentCitation,
    removeAttachmentCitations,
    stripInlineAttachmentCitationsFromDraft,
} from './inline-attachment-sync';

describe('inline attachment citation sync', () => {
    test('classifies every attached file as an inline citation', () => {
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'image/png' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'selection' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'file' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'text/plain' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'server', mimeType: 'application/json' })).toBe(true);
    });

    test('strips reserved-slot citations from draft text', () => {
        const text = 'see [\u2003image-1.png] and keep @file';
        const mentionStart = text.indexOf('@file');
        expect(stripInlineAttachmentCitationsFromDraft(
            text,
            ['image-1.png'],
            [{ kind: 'file', value: 'file', path: 'file', label: 'file', range: { start: mentionStart, end: mentionStart + '@file'.length } }],
            undefined,
        )).toEqual({
            text: 'see and keep @file',
            mentions: [{ kind: 'file', value: 'file', path: 'file', label: 'file', range: { start: 'see and keep '.length, end: 'see and keep @file'.length } }],
            composerReferences: undefined,
            changed: true,
        });
    });

    test('rebases composer references past a removed citation', () => {
        const text = '[\u2003image-1.png] @Session';
        const sessionStart = text.indexOf('@Session');
        const result = stripInlineAttachmentCitationsFromDraft(
            text,
            ['image-1.png'],
            [],
            [{ id: 's', kind: 'session', sessionId: 'session', display: '@Session', start: sessionStart, end: sessionStart + '@Session'.length }],
        );
        expect(result).toEqual({
            text: '@Session',
            mentions: [],
            composerReferences: [{ id: 's', kind: 'session', sessionId: 'session', display: '@Session', start: 0, end: 8 }],
            changed: true,
        });
    });

    test('is a no-op when the citation is already gone', () => {
        expect(stripInlineAttachmentCitationsFromDraft(
            'plain text',
            ['image-1.png'],
            [],
            [],
        )).toEqual({
            text: 'plain text',
            mentions: [],
            composerReferences: [],
            changed: false,
        });
    });

    test('keeps removeAttachmentCitations aligned with draft strip text', () => {
        const text = 'compare [\u2003image-1.png] against [\u2003image-2.png]';
        const start = text.indexOf('[');
        const end = text.indexOf(']') + 1;
        expect(removeAttachmentCitations(text, ['image-1.png'])).toBe(
            stripInlineAttachmentCitationsFromDraft(text, ['image-1.png'], [], undefined).text,
        );
        expect(findAttachmentCitationRanges(text, ['image-1.png'])).toEqual([{ start, end }]);
    });
});
