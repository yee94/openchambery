import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
    MarkdownLoadingPlaceholder,
    normalizeTableLinesForEstimate,
} from './MarkdownLoadingSkeleton';

describe('normalizeTableLinesForEstimate', () => {
    test('collapses table rows to single lines and separators to nothing', () => {
        const table = [
            '| Column A | Column B | Column C |',
            '| --- | :---: | ---: |',
            '| a fairly long cell value | another cell | 42 |',
        ].join('\n');

        expect(normalizeTableLinesForEstimate(table)).toBe('x\n\nx');
    });

    test('leaves non-table lines untouched', () => {
        const text = '# Heading\n\nplain paragraph with | a pipe\n- list item';
        expect(normalizeTableLinesForEstimate(text)).toBe(text);
    });

    test('keeps pipes that do not form table rows', () => {
        expect(normalizeTableLinesForEstimate('a | b | c')).toBe('a | b | c');
    });
});

describe('MarkdownLoadingPlaceholder table height', () => {
    test('the fallback size spacer renders table-normalized source', () => {
        const table = [
            '| header-one | header-two |',
            '| --- | --- |',
            `| ${'long cell '.repeat(20)}| tail |`,
        ].join('\n');

        const markup = renderToStaticMarkup(
            <MarkdownLoadingPlaceholder content={table} animated={false} />,
        );

        // The raw pipes must not reserve height as wrapped plain text.
        expect(markup).not.toContain('| --- | --- |');
        expect(markup).not.toContain('header-one');
        // Normalized rows keep exactly one spacer line each (header + data row).
        expect(markup).toContain('x\n\nx');
    });
});
