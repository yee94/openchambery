import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isLikelyFileReferencePath,
    parseFileReference,
    type ParsedFileReference,
} from './fileReferenceParser';

const parse = (value: string): ParsedFileReference | null => parseFileReference(value);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const markdownRendererSource = readFileSync(join(sourceDirectory, 'MarkdownRendererImpl.tsx'), 'utf-8');

describe('parseFileReference', () => {
    test('returns null for empty or whitespace input', () => {
        expect(parse('')).toBeNull();
        expect(parse('   ')).toBeNull();
    });

    test('parses bare path', () => {
        expect(parse('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
    });

    test('parses path with single line', () => {
        expect(parse('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
    });

    test('parses path with line and column', () => {
        expect(parse('src/foo.ts:42:8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
    });

    test('parses path with line range', () => {
        expect(parse('src/foo.ts:42-58')).toEqual({
            path: 'src/foo.ts',
            line: 42,
            endLine: 58,
        });
    });

    test('parses path with single-line range (start equals end)', () => {
        expect(parse('src/foo.ts:10-10')).toEqual({
            path: 'src/foo.ts',
            line: 10,
            endLine: 10,
        });
    });

    test('rejects range with end before start', () => {
        expect(parse('src/foo.ts:20-10')).toBeNull();
    });

    test('falls back to path-only when range endpoint is non-numeric', () => {
        // `src/foo.ts:10-abc` and `src/foo.ts:abc-20` are malformed; the
        // line info is discarded and only the path is returned (the trailing
        // `:`-suffix is stripped).
        expect(parse('src/foo.ts:10-abc')).toEqual({ path: 'src/foo.ts' });
        expect(parse('src/foo.ts:abc-20')).toEqual({ path: 'src/foo.ts' });
    });

    test('strips backtick and quote wrapping from range forms', () => {
        expect(parse('`src/foo.ts:10-20`')).toEqual({
            path: 'src/foo.ts',
            line: 10,
            endLine: 20,
        });
        expect(parse('"src/foo.ts:1-3"')).toEqual({
            path: 'src/foo.ts',
            line: 1,
            endLine: 3,
        });
    });

    test('parses absolute Windows path with line range', () => {
        expect(parse('C:/repo/src/foo.ts:5-9')).toEqual({
            path: 'C:/repo/src/foo.ts',
            line: 5,
            endLine: 9,
        });
    });

    test('preserves line:col form (does not interpret as range)', () => {
        expect(parse('src/foo.ts:42:8')).toEqual({
            path: 'src/foo.ts',
            line: 42,
            column: 8,
        });
    });

    test('preserves hash form', () => {
        expect(parse('src/foo.ts#L42C8')).toEqual({
            path: 'src/foo.ts',
            line: 42,
            column: 8,
        });
        expect(parse('src/foo.ts#L42')).toEqual({
            path: 'src/foo.ts',
            line: 42,
        });
    });

    test('range form takes precedence over line-only when suffix matches digits-dash-digits', () => {
        const result = parse('src/foo.ts:42-58');
        expect(result).toEqual({ path: 'src/foo.ts', line: 42, endLine: 58 });
    });
});

describe('isLikelyFileReferencePath', () => {
    test('rejects decimal measurements and timestamp-like numeric tokens', () => {
        expect(isLikelyFileReferencePath('00.731')).toBe(false);
        expect(isLikelyFileReferencePath('56.312')).toBe(false);
        expect(isLikelyFileReferencePath('2026.07')).toBe(false);
    });

    test('keeps extension-bearing source paths and known extensionless files', () => {
        expect(isLikelyFileReferencePath('src/consumer.ts')).toBe(true);
        expect(isLikelyFileReferencePath('.omo/notepads/run/learnings.md')).toBe(true);
        expect(isLikelyFileReferencePath('Dockerfile')).toBe(true);
        expect(isLikelyFileReferencePath('.gitignore')).toBe(true);
    });
});

describe('binary file references', () => {
    test('routes binary links through the desktop path opener before the context preview', () => {
        const binaryHandlingStart = markdownRendererSource.indexOf("sourceElement.getAttribute('data-openchamber-file-binary') === 'true'");
        const contextPreviewStart = markdownRendererSource.indexOf('const contextDirectory = getContextDirectory', binaryHandlingStart);

        expect(binaryHandlingStart).toBeGreaterThan(-1);
        const binaryHandling = markdownRendererSource.slice(binaryHandlingStart, contextPreviewStart);
        expect(binaryHandling).toContain('!isImageFile(resolved.resolvedPath)');
        expect(binaryHandling).toContain('await openDesktopPath(resolved.resolvedPath)');
        expect(markdownRendererSource).toContain('isMobileSurface && info.isBinary && !isImageFile(latestResolved.resolvedPath)');
    });
});
