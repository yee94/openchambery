import { describe, expect, test } from 'bun:test';

import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    expandCodeSelectionCitations,
    findAttachmentCitationRanges,
    getAttachmentCitationIconPath,
    isInlineAttachmentCitation,
    isCodeSelectionFilePart,
    isDirectoryAttachmentMime,
    isDirectoryAttachmentPath,
    isGenericImageFilename,
    removeAttachmentCitations,
    resolveAttachmentCitationDeletion,
    stripAttachmentCitationSlotsForDelivery,
} from '../attachmentCitations';

describe('attachment citations', () => {
    test('keeps meaningful image names', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'desktop_without_icons.jpg', type: 'image/jpeg' },
        ], [])).toEqual(['desktop_without_icons.jpg']);
    });

    test('renames generic clipboard image names', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'image.png', type: 'image/png' },
            { name: 'Screenshot.png', type: 'image/png' },
        ], [])).toEqual(['image-1.png', 'image-2.png']);
    });

    test('deduplicates meaningful names inside pending attachments', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'desktop.jpg', type: 'image/jpeg' },
            { name: 'desktop.jpg', type: 'image/jpeg' },
        ], ['desktop-2.jpg'])).toEqual(['desktop.jpg', 'desktop-3.jpg']);
    });

    test('continues generated image indexes from existing pending attachments', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'image.png', type: 'image/png' },
            { name: '', type: 'image/webp' },
        ], ['image-1.png'])).toEqual(['image-2.png', 'image-3.webp']);
    });

    test('detects generic names narrowly', () => {
        expect(isGenericImageFilename('image.png')).toBe(true);
        expect(isGenericImageFilename('Screenshot (1).png')).toBe(true);
        expect(isGenericImageFilename('Screen Shot.png')).toBe(true);
        expect(isGenericImageFilename('Screenshot 2026-05-24.png')).toBe(false);
        expect(isGenericImageFilename('desktop_without_icons.jpg')).toBe(false);
    });

    test('builds bracket citations with a reserved icon slot', () => {
        expect(buildAttachmentCitationText(['desktop.jpg', 'icon.png'])).toBe('[\u2003desktop.jpg] [\u2003icon.png]');
    });

    test('strips reserved icon slots before delivery', () => {
        expect(stripAttachmentCitationSlotsForDelivery(
            'see [\u2003desktop.jpg] and [icon.png]',
        )).toBe('see [desktop.jpg] and [icon.png]');
    });

    test('keeps code selections and image references inline while regular files stay in the attachment area', () => {
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'selection' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'image/png' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'file' })).toBe(false);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'text/plain' })).toBe(false);
        expect(isInlineAttachmentCitation({ source: 'server', mimeType: 'application/pdf' })).toBe(false);
    });

    test('expands sent code-selection citations to their absolute paths', () => {
        expect(expandCodeSelectionCitations(
            'check [SidebarFooter.tsx:199-200] and [image-1.png]',
            [{
                filename: 'SidebarFooter.tsx:199-200',
                source: 'vscode',
                vscodeSource: 'selection',
                vscodePath: '/Users/yee/project/src/SidebarFooter.tsx',
            }],
        )).toBe('check [/Users/yee/project/src/SidebarFooter.tsx:199-200] and [image-1.png]');
    });

    test('classifies code-selection file parts as reference-only display data', () => {
        expect(isCodeSelectionFilePart({ filename: 'SidebarFooter.tsx:199-200', mime: 'text/plain' })).toBe(true);
        expect(isCodeSelectionFilePart({ filename: 'notes.txt', mime: 'text/plain' })).toBe(false);
        expect(isCodeSelectionFilePart({ filename: 'image.png:12', mime: 'image/png' })).toBe(false);
    });

    test('finds active attachment citation ranges', () => {
        expect(findAttachmentCitationRanges(
            'desktop [desktop.jpg] link [desktop.jpg](https://example.com) missing [other.jpg]',
            ['desktop.jpg'],
        )).toEqual([{ start: 8, end: 21 }]);
    });

    test('finds reserved-slot attachment citation ranges', () => {
        expect(findAttachmentCitationRanges(
            'see [\u2003desktop.jpg] and [desktop.jpg]',
            ['desktop.jpg'],
        )).toEqual([
            { start: 4, end: 18 },
            { start: 23, end: 36 },
        ]);
    });

    test('removes every citation for a removed attachment', () => {
        expect(removeAttachmentCitations(
            'compare [image-1.png] against [image-2.png], then revisit [image-1.png]',
            ['image-1.png'],
        )).toBe('compare against [image-2.png], then revisit');
    });

    test('removes reserved-slot citations for a removed attachment', () => {
        expect(removeAttachmentCitations(
            'compare [\u2003image-1.png] against [\u2003image-2.png]',
            ['image-1.png'],
        )).toBe('compare against [\u2003image-2.png]');
    });

    test('removes code-selection line suffixes from file-type icon paths', () => {
        expect(getAttachmentCitationIconPath('SidebarFooter.tsx:17-24')).toBe('SidebarFooter.tsx');
        expect(getAttachmentCitationIconPath('README.md:20')).toBe('README.md');
        expect(getAttachmentCitationIconPath('image-1.png')).toBe('image-1.png');
    });

    const edgeDeletionText = 'before [SidebarFooter.tsx:17-24] after';
    for (const { key, cursor } of [
        { key: 'Backspace' as const, cursor: edgeDeletionText.indexOf(']') + 1 },
        { key: 'Delete' as const, cursor: edgeDeletionText.indexOf('[') },
    ]) {
        test(`deletes a whole citation with ${key} from its adjacent edge`, () => {
            expect(resolveAttachmentCitationDeletion(
                edgeDeletionText,
                ['SidebarFooter.tsx:17-24'],
                { key, selectionStart: cursor, selectionEnd: cursor },
            )).toEqual({
                text: 'before after',
                caret: 7,
                removedFilenames: ['SidebarFooter.tsx:17-24'],
            });
        });
    }

    test('deletes a whole citation when Backspace is pressed inside it', () => {
        expect(resolveAttachmentCitationDeletion(
            'before [README.md:20] after',
            ['README.md:20'],
            { key: 'Backspace', selectionStart: 14, selectionEnd: 14 },
        )).toEqual({
            text: 'before after',
            caret: 7,
            removedFilenames: ['README.md:20'],
        });
    });

    test('returns the image filename so deleting its tag removes the linked attachment', () => {
        const text = 'look [image-2.png]';
        expect(resolveAttachmentCitationDeletion(
            text,
            ['image-2.png'],
            { key: 'Backspace', selectionStart: text.length, selectionEnd: text.length },
        )).toEqual({
            text: 'look',
            caret: 4,
            removedFilenames: ['image-2.png'],
        });
    });

    test('deletes the whole preceding citation with Option+Backspace after its separator', () => {
        const text = 'before [SidebarFooter.tsx:17-24] after';
        const cursor = text.indexOf('after');
        expect(resolveAttachmentCitationDeletion(
            text,
            ['SidebarFooter.tsx:17-24'],
            { key: 'Backspace', selectionStart: cursor, selectionEnd: cursor, altKey: true },
        )).toEqual({
            text: 'before after',
            caret: 7,
            removedFilenames: ['SidebarFooter.tsx:17-24'],
        });
    });

    test('deletes the whole following citation with Option+Delete before its separator', () => {
        const text = 'before [README.md:20] after';
        expect(resolveAttachmentCitationDeletion(
            text,
            ['README.md:20'],
            { key: 'Delete', selectionStart: 'before'.length, selectionEnd: 'before'.length, altKey: true },
        )).toEqual({
            text: 'before after',
            caret: 6,
            removedFilenames: ['README.md:20'],
        });
    });

    test('supports repeated backward deletion of adjacent citations', () => {
        const text = '[one.ts:1-2] [two.md:9]';
        const first = resolveAttachmentCitationDeletion(
            text,
            ['one.ts:1-2', 'two.md:9'],
            { key: 'Backspace', selectionStart: text.length, selectionEnd: text.length },
        );
        expect(first).toEqual({
            text: '[one.ts:1-2]',
            caret: 12,
            removedFilenames: ['two.md:9'],
        });
        expect(resolveAttachmentCitationDeletion(
            first?.text ?? '',
            ['one.ts:1-2'],
            { key: 'Backspace', selectionStart: first?.caret ?? 0, selectionEnd: first?.caret ?? 0 },
        )).toEqual({
            text: '',
            caret: 0,
            removedFilenames: ['one.ts:1-2'],
        });
    });

    test('expands a selection across every intersected citation', () => {
        const text = 'a [one.ts:1-2] middle [two.md:9] z';
        expect(resolveAttachmentCitationDeletion(
            text,
            ['one.ts:1-2', 'two.md:9'],
            {
                key: 'Backspace',
                selectionStart: text.indexOf('one.ts') + 2,
                selectionEnd: text.indexOf('two.md') + 3,
            },
        )).toEqual({
            text: 'a z',
            caret: 2,
            removedFilenames: ['one.ts:1-2', 'two.md:9'],
        });
    });

    test('leaves ordinary deletion to the textarea', () => {
        expect(resolveAttachmentCitationDeletion(
            'before [README.md:20] after',
            ['README.md:20'],
            { key: 'Backspace', selectionStart: 3, selectionEnd: 3 },
        )).toBeNull();
    });

    test('recognizes OpenCode directory attachment mime and trailing-slash paths', () => {
        expect(isDirectoryAttachmentMime('application/x-directory')).toBe(true);
        expect(isDirectoryAttachmentMime(' text/plain ')).toBe(false);
        expect(isDirectoryAttachmentPath('/Users/yee.wang/.config/opencode/')).toBe(true);
        expect(isDirectoryAttachmentPath('/Users/yee.wang/.config/opencode')).toBe(false);
    });
});
