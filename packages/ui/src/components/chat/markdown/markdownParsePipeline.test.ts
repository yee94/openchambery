import { describe, expect, test } from 'vitest';

import {
    hasOpenFence,
    healMarkdown,
    markdownBlockId,
    parseMarkdownBlocksUnsafe,
    parseMarkdownUnsafe,
    shouldUseMainThreadMarkdownParse,
    streamBlocks,
    SYNC_MARKDOWN_FAST_PATH_CHARS,
} from './markdownParsePipeline';

describe('markdown parse pipeline', () => {
    test('keeps streamed block boundaries after the stream ends', () => {
        const text = 'Hello\n\n```ts\nconst x = 1\n```\n\nDone';
        const live = streamBlocks(text, true);
        const done = streamBlocks(text, false);
        expect(live.map((block) => block.raw)).toEqual(done.map((block) => block.raw));
        expect(live.at(-1)?.mode).toBe('live');
        expect(done.at(-1)?.mode).toBe('full');
        expect(live.map(markdownBlockId).slice(0, -1)).toEqual(done.map(markdownBlockId).slice(0, -1));
    });

    test('isolates an open fence so it does not highlight or corrupt earlier blocks', () => {
        const text = 'Intro\n\n```ts\nconst x = 1\n';
        expect(hasOpenFence('```ts\nconst x = 1\n')).toBe(true);
        expect(hasOpenFence('```ts\nconst x = 1\n```')).toBe(false);
        const blocks = streamBlocks(text, true);
        const fence = blocks[blocks.length - 1];
        expect(fence?.highlight).toBe(false);
        expect(fence?.src.startsWith('```')).toBe(true);
    });

    test('heals incomplete markdown without throwing', () => {
        expect(healMarkdown('**bold')).toContain('**');
        expect(healMarkdown('[link](http://example.com')).toBeTruthy();
    });

    test('parses paragraphs and leaves script tags for the sanitizer', () => {
        const html = parseMarkdownUnsafe('# Title\n\n<script>alert(1)</script>');
        expect(html).toContain('<h1>');
        expect(html).toContain('script');
    });

    test('small fence-free text stays on the main-thread fast path', () => {
        expect(shouldUseMainThreadMarkdownParse('hello', false)).toBe(true);
        expect(shouldUseMainThreadMarkdownParse('```ts\nconst x = 1\n```', false)).toBe(false);
        expect(shouldUseMainThreadMarkdownParse('x'.repeat(SYNC_MARKDOWN_FAST_PATH_CHARS + 1), false)).toBe(false);
        expect(shouldUseMainThreadMarkdownParse('hello', true)).toBe(false);
    });

    test('unsafe block projection matches stream block count', () => {
        const blocks = parseMarkdownBlocksUnsafe('One\n\nTwo', false);
        expect(blocks).toHaveLength(2);
        expect(blocks.every((block) => block.html.length > 0)).toBe(true);
    });
});
