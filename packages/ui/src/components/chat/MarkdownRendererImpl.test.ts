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
// `markdownCore` imports the Shiki worker through a Vite-only specifier, so it
// cannot be loaded here; assert on its source the way the binary-reference
// suite below does.
const markdownCoreSource = readFileSync(join(sourceDirectory, 'markdown', 'markdownCore.ts'), 'utf-8');
const markdownParsePipelineSource = readFileSync(join(sourceDirectory, 'markdown', 'markdownParsePipeline.ts'), 'utf-8');
const messageListSource = readFileSync(join(sourceDirectory, 'MessageList.tsx'), 'utf-8');
const decorateSource = readFileSync(join(sourceDirectory, 'markdown', 'decorate.ts'), 'utf-8');
const autoFollowSource = readFileSync(
    join(sourceDirectory, '..', '..', 'hooks', 'useChatAutoFollow.ts'),
    'utf-8',
);

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

describe('stream completion reuses the streamed DOM', () => {
    test('block segmentation keeps the streamed boundaries once the stream ends', () => {
        // Collapsing a finished message back into one whole-document block
        // misses every per-block cache entry and re-morphs the entire message
        // in a single commit, which reads as a full-message flash.
        expect(markdownParsePipelineSource).toContain("const tailMode: MarkdownBlock['mode'] = live ? 'live' : 'full';");
        expect(markdownParsePipelineSource).toContain("mode: isLast ? tailMode : 'full',");
        expect(markdownCoreSource).toContain('parseMarkdownInWorker');
        expect(markdownCoreSource).toContain('shouldUseMainThreadMarkdownParse');
    });

    test('dollar math is lexed through the currency-safe matcher', () => {
        expect(markdownParsePipelineSource).toContain('matchDollarMath');
        expect(markdownParsePipelineSource).toContain('dollarMathExtension');
    });

    test('the non-streaming render yields on a time budget, not once per block', () => {
        expect(markdownCoreSource).toContain('sliceDeadline = nowMs() + RENDER_SLICE_BUDGET_MS;');
    });

    test('first paint lays down one element per async render block', () => {
        expect(markdownRendererSource).toContain('for (const html of renderMarkdownSyncBlocks(text))');
    });

    test('open fences upgrade through the Shiki line worker and prefix-diff', () => {
        expect(markdownRendererSource).toContain('shouldPreserveStreamingFence');
        expect(markdownRendererSource).toContain('upgradeStreamingFenceHighlight');
        expect(markdownRendererSource).toContain('highlightLinesInWorker');
    });

    test('decorated code blocks do not depend on the line-number defer flag', () => {
        // If decorate inlined the gutter, every already-painted code block would
        // be rebuilt the moment the defer flag flips at the end of a stream.
        expect(decorateSource).toContain("body.className = 'px-3 py-2.5 overflow-x-auto';");
        expect(decorateSource).not.toContain('body.appendChild(createCodeLineNumbers(pre));');
        expect(markdownRendererSource).toContain('applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);');
    });

    test('the live tail slot outlives the stream so the finished turn is not remounted', () => {
        // `staticTurns` and `streamingTurn` are rendered by different
        // components; releasing the tail on completion unmounts the turn and
        // rebuilds all of its Markdown from an empty node.
        expect(messageListSource).toContain('hasLiveTail: liveTailActive || stickyLiveTailRef.current');
    });
});

describe('paced streaming reveal scheduling', () => {
    const revealStart = markdownRendererSource.indexOf('const usePacedText');
    const revealEnd = markdownRendererSource.indexOf('// Mermaid layout', revealStart);
    const revealSource = markdownRendererSource.slice(revealStart, revealEnd);

    test('interpolates reveal progress on animation frames', () => {
        expect(revealSource).toContain('window.requestAnimationFrame(tick)');
        expect(revealSource).not.toContain('setTimeout(tick, textPaceMs)');
    });

    test('bounds per-frame work and elapsed-time catch-up', () => {
        expect(markdownRendererSource).toContain('const MIN_REVEAL_CHARS_PER_FRAME = 1;');
        expect(markdownRendererSource).toContain('const MAX_CATCHUP_CHARS_PER_FRAME = 12;');
        expect(revealSource).toContain('Math.min(ts - lastTs, 100)');
    });

    test('keeps word-end snapping and cancels the scheduled frame on cleanup', () => {
        expect(markdownRendererSource).toContain('const TEXT_SNAP = /[\\s.,!?;:)\\]]/;');
        expect(revealSource).toContain('window.cancelAnimationFrame(frame)');
    });
});

describe('markdown hydration while scrolling', () => {
    test('only visible rows are withheld while the list is scrolling', () => {
        // Swapping a size spacer for real Markdown mid-scroll makes the
        // virtualizer compensate a row it already measured, which drags the
        // viewport back toward earlier entries. Off-screen preload has no such
        // cost and must keep running, otherwise the whole window lands in the
        // single commit that follows the scroll.
        expect(messageListSource).toContain('allowVisibleRelease: !isScrolling,');
        expect(messageListSource).not.toContain('deferMarkdownHydrationWhileScrolling');
        expect(messageListSource).not.toContain('deferMarkdownHydrationForMobileScroll');
    });

    test('preload releases stay metered so no commit swaps a screenful at once', () => {
        expect(messageListSource).toContain('preloadReleaseLimit: isScrolling');
        expect(messageListSource).toContain('MARKDOWN_PRELOAD_RELEASE_SCROLLING');
        expect(messageListSource).toContain('MARKDOWN_PRELOAD_RELEASE_IDLE');
    });

    test('the deferred placeholder reserves the height the content last rendered at', () => {
        // The plain-text spacer overshoots badly — fenced code, link targets and
        // table pipes all collapse when rendered — so the swap into real Markdown
        // shrank the row and the virtualizer yanked the scroll offset to match.
        expect(markdownRendererSource).toContain('useMarkdownHeightMemo(');
        expect(markdownRendererSource).toContain('rememberMarkdownHeight(cacheKeyRef.current, height, width)');
    });
});

describe('forced layout while scrolling', () => {
    test('a scroll event reads the scroll box once and reuses the snapshot', () => {
        // Reading scrollTop/scrollHeight/clientHeight repeatedly through the
        // handler forces a layout on every read that lands after React has
        // written to the DOM; it was the largest reflow source in a scroll trace.
        const handlerStart = autoFollowSource.indexOf('const handleScrollEvent = useEvent(');
        const handlerEnd = autoFollowSource.indexOf('React.useEffect(', handlerStart);
        const handler = autoFollowSource.slice(handlerStart, handlerEnd);

        expect(handler).toContain('const geometry = readScrollGeometry(el);');
        expect(/\bel\.(scrollTop|scrollHeight|clientHeight)\b/.test(handler)).toBe(false);
        expect(/\b(canScroll|isNearBottom|distanceFromBottom)\(el\b/.test(handler)).toBe(false);
    });

    test('content ResizeObserver reads the scroll box once and skips a no-op pin', () => {
        // Trace-20260805 shell-tool window: triple geometry reads + redundant
        // scrollTop writes next to ScrollLayer painted as a full-viewport flash.
        const handlerStart = autoFollowSource.indexOf('const handleContentResize = useEvent(');
        const handlerEnd = autoFollowSource.indexOf('const canObserveResize', handlerStart);
        const handler = autoFollowSource.slice(handlerStart, handlerEnd);

        expect(handlerStart).toBeGreaterThan(-1);
        expect(handler).toContain('const geometry = readScrollGeometry(el);');
        expect(handler).toContain('distanceFromBottomOf(geometry) <= AUTO_MATCH_TOLERANCE_PX');
        expect(handler).toContain('markAuto(el)');
        expect(/\bcanScroll\(el\b/.test(handler)).toBe(false);
        expect(/\bupdateOverflowAndButton\(\)/.test(handler)).toBe(false);
    });

    test('revealing rendered Markdown does not measure the container', () => {
        const revealStart = markdownRendererSource.indexOf('const useRichMarkdownReveal =');
        const revealEnd = markdownRendererSource.indexOf('const MarkdownRendererImpl', revealStart);
        const reveal = markdownRendererSource.slice(revealStart, revealEnd);

        expect(reveal).not.toContain('getBoundingClientRect');
        expect(reveal).not.toContain('minHeight');
    });

    test('the rendered Markdown holds the box open, not the placeholder', () => {
        // With the placeholder in flow and the content absolute, every reveal
        // resized the row — the virtualizer then compensated scroll for a size
        // change the user never caused.
        expect(markdownRendererSource).not.toContain("!richReady && 'pointer-events-none absolute inset-x-0 top-0 invisible'");
        expect(markdownRendererSource).toContain("className={cn(markdownContentClassName(variant), !richReady && 'invisible')}");
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
