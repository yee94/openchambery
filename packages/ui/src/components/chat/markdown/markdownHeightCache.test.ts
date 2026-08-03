import { beforeEach, describe, expect, test } from 'bun:test';

import {
    clearMarkdownHeightCache,
    markdownHeightCacheKey,
    markdownHeightCacheSize,
    recallMarkdownHeight,
    rememberMarkdownHeight,
} from './markdownHeightCache';

const key = (content: string, variant = 'assistant') => markdownHeightCacheKey(content, variant);

describe('markdown height cache', () => {
    beforeEach(() => {
        clearMarkdownHeightCache();
    });

    test('recalls a rounded height for the same content and variant', () => {
        rememberMarkdownHeight(key('# hello'), 412.6, 800);
        expect(recallMarkdownHeight(key('# hello'))).toBe(413);
    });

    test('separates the same source rendered under different variants', () => {
        rememberMarkdownHeight(key('# hello', 'assistant'), 400, 800);
        rememberMarkdownHeight(key('# hello', 'tool'), 120, 800);

        expect(recallMarkdownHeight(key('# hello', 'assistant'))).toBe(400);
        expect(recallMarkdownHeight(key('# hello', 'tool'))).toBe(120);
    });

    test('misses for content it has never measured', () => {
        rememberMarkdownHeight(key('# hello'), 400, 800);
        expect(recallMarkdownHeight(key('# goodbye'))).toBeUndefined();
    });

    test('drops every entry once the column is measured at a new width', () => {
        rememberMarkdownHeight(key('a'), 100, 800);
        rememberMarkdownHeight(key('b'), 200, 800);
        expect(markdownHeightCacheSize()).toBe(2);

        rememberMarkdownHeight(key('c'), 300, 640);

        expect(recallMarkdownHeight(key('a'))).toBeUndefined();
        expect(recallMarkdownHeight(key('b'))).toBeUndefined();
        expect(recallMarkdownHeight(key('c'))).toBe(300);
    });

    test('keeps entries while the width only wobbles below a pixel', () => {
        rememberMarkdownHeight(key('a'), 100, 800.2);
        rememberMarkdownHeight(key('b'), 200, 799.8);

        expect(recallMarkdownHeight(key('a'))).toBe(100);
        expect(recallMarkdownHeight(key('b'))).toBe(200);
    });

    test('ignores degenerate measurements from detached or collapsed nodes', () => {
        rememberMarkdownHeight(key('a'), 0, 800);
        rememberMarkdownHeight(key('b'), 100, 0);
        rememberMarkdownHeight(key('c'), Number.NaN, 800);
        rememberMarkdownHeight(key('d'), Number.POSITIVE_INFINITY, 800);

        expect(markdownHeightCacheSize()).toBe(0);
    });

    test('a degenerate measurement does not invalidate the cache', () => {
        rememberMarkdownHeight(key('a'), 100, 800);
        rememberMarkdownHeight(key('b'), 0, 640);

        expect(recallMarkdownHeight(key('a'))).toBe(100);
    });

    test('remeasuring the same content overwrites the previous height', () => {
        rememberMarkdownHeight(key('a'), 100, 800);
        rememberMarkdownHeight(key('a'), 260, 800);

        expect(recallMarkdownHeight(key('a'))).toBe(260);
        expect(markdownHeightCacheSize()).toBe(1);
    });

    test('distinguishes same-length content that differs in body', () => {
        expect(key('abcd')).not.toBe(key('abce'));
    });
});
