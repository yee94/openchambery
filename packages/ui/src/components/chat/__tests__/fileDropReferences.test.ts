import { describe, expect, test } from 'bun:test';

import {
    collectFileDropReferences,
    isAbsoluteFileDropPath,
    normalizeFileDropPath,
    parseFileDropReferences,
} from '../fileDropReferences';

describe('file drop references', () => {
    test('parses Finder file URLs and absolute paths', () => {
        expect(parseFileDropReferences('file:///Users/example/Release%20Notes')).toEqual([
            'file:///Users/example/Release%20Notes',
        ]);
        expect(parseFileDropReferences('/Users/example/project/src/index.ts')).toEqual([
            '/Users/example/project/src/index.ts',
        ]);
    });

    test('extracts file references from URI lists and VS Code payloads', () => {
        expect(parseFileDropReferences('# Finder URLs\nfile:///Users/example/one.txt\nfile:///Users/example/two')).toEqual([
            'file:///Users/example/one.txt',
            'file:///Users/example/two',
        ]);
        expect(parseFileDropReferences(JSON.stringify({ resources: ['file:///Users/example/project', '/tmp/notes.md'] }))).toEqual([
            'file:///Users/example/project',
            '/tmp/notes.md',
        ]);
    });

    test('ignores Markdown and JSX closing fragments', () => {
        expect(parseFileDropReferences('Dropped files:\n/>\nMore details')).toEqual([]);
        expect(parseFileDropReferences('/>')).toEqual([]);
    });

    test('treats text/plain as one direct file reference', () => {
        const transfer = {
            getData: (type: string) => {
                if (type === 'text/plain') {
                    return 'Notes:\n/tmp/one.txt\n/>\n/tmp/two.txt';
                }
                return '';
            },
        } as Pick<DataTransfer, 'getData'>;

        expect(collectFileDropReferences(transfer)).toEqual([]);

        const pathTransfer = {
            getData: (type: string) => type === 'text/plain' ? '/tmp/one.txt' : '',
        } as Pick<DataTransfer, 'getData'>;

        expect(collectFileDropReferences(pathTransfer)).toEqual(['/tmp/one.txt']);
    });

    test('does not treat slash-command chips as absolute file paths on text/plain paste', () => {
        const slashTransfer = {
            getData: (type: string) => type === 'text/plain' ? '/release' : '',
        } as Pick<DataTransfer, 'getData'>;
        const reservedSlotTransfer = {
            getData: (type: string) => type === 'text/plain' ? '/\u2003release' : '',
        } as Pick<DataTransfer, 'getData'>;
        const slashWithArgsTransfer = {
            getData: (type: string) => (
                type === 'text/plain'
                    ? '/\u2003release  包含当前所有 changes 来一个提交发布 g'
                    : ''
            ),
        } as Pick<DataTransfer, 'getData'>;

        // These used to become `@/release` file mentions via handlePaste.
        expect(collectFileDropReferences(slashTransfer)).toEqual([]);
        expect(collectFileDropReferences(reservedSlotTransfer)).toEqual([]);
        expect(collectFileDropReferences(slashWithArgsTransfer)).toEqual([]);

        // Multi-segment absolute paths still paste as file mentions.
        expect(collectFileDropReferences({
            getData: (type: string) => type === 'text/plain' ? '/Users/example/project/src/index.ts' : '',
        } as Pick<DataTransfer, 'getData'>)).toEqual(['/Users/example/project/src/index.ts']);
    });

    test('reads structured VS Code payloads without parsing plain JSON text', () => {
        const payload = JSON.stringify({ resources: ['file:///Users/example/project', '/tmp/notes.md'] });
        const transfer = {
            getData: (type: string) => type === 'CodeFiles' ? payload : '',
        } as Pick<DataTransfer, 'getData'>;
        const plainTransfer = {
            getData: (type: string) => type === 'text/plain' ? payload : '',
        } as Pick<DataTransfer, 'getData'>;

        expect(collectFileDropReferences(transfer)).toEqual([
            'file:///Users/example/project',
            '/tmp/notes.md',
        ]);
        expect(collectFileDropReferences(plainTransfer)).toEqual([]);
    });

    test('reads every supported transfer type', () => {
        const transfer = {
            getData: (type: string) => type === 'text/uri-list'
                ? 'file:///Users/example/notes.txt'
                : '',
        } as Pick<DataTransfer, 'getData'>;

        expect(collectFileDropReferences(transfer)).toEqual(['file:///Users/example/notes.txt']);
    });

    test('normalizes paths for absolute file mentions', () => {
        expect(normalizeFileDropPath('file:///Users/example/Release%20Notes')).toBe('/Users/example/Release Notes');
        expect(normalizeFileDropPath('file:///C:/workspace/app.ts')).toBe('C:/workspace/app.ts');
        expect(normalizeFileDropPath('file://server/share/app.ts')).toBe('//server/share/app.ts');
        expect(isAbsoluteFileDropPath('/Users/example/project')).toBe(true);
        expect(isAbsoluteFileDropPath('//server/share/project')).toBe(true);
        expect(isAbsoluteFileDropPath('project/src/index.ts')).toBe(false);
    });
});
