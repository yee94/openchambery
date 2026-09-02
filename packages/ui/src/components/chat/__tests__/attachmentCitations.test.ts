import { describe, expect, test } from 'bun:test';

import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    collectDetachedAttachmentFilenames,
    inferSimpleDeletionRange,
    reconcileComposerAttachmentTextDeletion,
    expandCodeSelectionCitations,
    expandImageAttachmentCitations,
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

    test('reports attachments orphaned when a replacement drops their citations', () => {
        const previous = `look ${buildAttachmentCitationText(['image-1.png', 'image-2.png'])}`;
        expect(collectDetachedAttachmentFilenames(
            ['image-1.png', 'image-2.png'],
            previous,
            'replaced text',
        )).toEqual(['image-1.png', 'image-2.png']);
    });

    test('keeps attachments whose citations survive a replacement', () => {
        const previous = `look ${buildAttachmentCitationText(['image-1.png', 'image-2.png'])}`;
        expect(collectDetachedAttachmentFilenames(
            ['image-1.png', 'image-2.png'],
            previous,
            `keep ${buildAttachmentCitationText(['image-2.png'])} only`,
        )).toEqual(['image-1.png']);
    });

    test('counts slotless citations as still present', () => {
        const previous = `look ${buildAttachmentCitationText(['image-1.png'])}`;
        expect(collectDetachedAttachmentFilenames(
            ['image-1.png'],
            previous,
            'keep [image-1.png] plain',
        )).toEqual([]);
    });

    test('never detaches when the text did not change', () => {
        const previous = `look ${buildAttachmentCitationText(['image-1.png'])}`;
        expect(collectDetachedAttachmentFilenames(['image-1.png'], previous, previous)).toEqual([]);
    });

    test('infers a simple deletion span from prefix and suffix', () => {
        expect(inferSimpleDeletionRange('look [image-1.png]', 'look [image-1.png')).toEqual({
            start: 17,
            end: 18,
        });
        expect(inferSimpleDeletionRange('abc', 'abc')).toBeNull();
        expect(inferSimpleDeletionRange('ab', 'abc')).toBeNull();
        expect(inferSimpleDeletionRange('hello', 'hi')).toBeNull();
    });

    test('expands a one-character citation edit into a whole-token attachment delete', () => {
        const previous = `look ${buildAttachmentCitationText(['image-2.png'])}`;
        const next = previous.slice(0, -1);
        expect(reconcileComposerAttachmentTextDeletion(previous, next, ['image-2.png'])).toEqual({
            text: 'look',
            caret: 4,
            removedFilenames: ['image-2.png'],
        });
    });

    test('drops attachments when the native field already removed the whole citation', () => {
        const previous = `keep ${buildAttachmentCitationText(['image-1.png'])} extra`;
        expect(reconcileComposerAttachmentTextDeletion(previous, 'keep extra', ['image-1.png'])).toEqual({
            text: 'keep extra',
            caret: 5,
            removedFilenames: ['image-1.png'],
        });
    });

    test('leaves ordinary native typing alone', () => {
        expect(reconcileComposerAttachmentTextDeletion(
            'hello',
            'hell',
            ['image-1.png'],
        )).toBeNull();
    });

    test('strips reserved icon slots before delivery', () => {
        expect(stripAttachmentCitationSlotsForDelivery(
            'see [\u2003desktop.jpg] and [icon.png]',
        )).toBe('see [desktop.jpg] and [icon.png]');
    });

    test('treats images, documents, and VS Code files as inline citations', () => {
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'selection' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'image/png' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'vscode', vscodeSource: 'file' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'text/plain' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'server', mimeType: 'application/pdf' })).toBe(true);
        expect(isInlineAttachmentCitation({ source: 'local', mimeType: 'application/json' })).toBe(true);
    });

    test('expands sent code-selection citations to their absolute paths', () => {
        expect(expandCodeSelectionCitations(
            'check [SidebarFooter.tsx:199-200] and [image-1.png]',
            [{
                filename: 'SidebarFooter.tsx:199-200',
                source: 'vscode',
                vscodeSource: 'selection',
                vscodePath: '/Users/example/project/src/SidebarFooter.tsx',
            }],
        )).toBe('check [/Users/example/project/src/SidebarFooter.tsx:199-200] and [image-1.png]');
    });

    test('expands sent image citations to their durable host paths', () => {
        expect(expandImageAttachmentCitations(
            'what is [\u2003image-1.png] vs [image-2.png]',
            [
                { filename: 'image-1.png', path: '/data/openchamber/prompt-attachments/aa/one.png' },
                { filename: 'image-2.png', path: '/data/openchamber/prompt-attachments/bb/two.png' },
            ],
        )).toBe('what is [/data/openchamber/prompt-attachments/aa/one.png] vs [/data/openchamber/prompt-attachments/bb/two.png]');
    });

    test('does not rewrite image citations that are already absolute paths', () => {
        expect(expandImageAttachmentCitations(
            'see [/data/openchamber/prompt-attachments/aa/one.png]',
            [{ filename: '/data/openchamber/prompt-attachments/aa/one.png', path: '/other/one.png' }],
        )).toBe('see [/data/openchamber/prompt-attachments/aa/one.png]');
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

    test('strips the reserved icon well from removed image filenames', () => {
        const text = 'look [\u2003image-2.png]';
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
        expect(isDirectoryAttachmentPath('/Users/example/.config/opencode/')).toBe(true);
        expect(isDirectoryAttachmentPath('/Users/example/.config/opencode')).toBe(false);
    });
});
