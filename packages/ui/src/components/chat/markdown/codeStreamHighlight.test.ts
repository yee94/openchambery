import { describe, expect, test } from 'vitest';

import {
    applyPrefixDiffHtmlLines,
    firstDifferingIndex,
    shouldPreserveStreamingFence,
    stampOpenFenceHtml,
    STREAM_FENCE_ATTR,
    STREAM_LINE_ATTR,
    STREAM_SRC_ATTR,
    upgradeStreamingFenceHighlight,
} from './codeStreamHighlight';

const lineHtml = (code: HTMLElement): string[] => (
    Array.from(code.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .map((node) => node.innerHTML)
);

describe('prefix-diff streaming highlight', () => {
    test('firstDifferingIndex finds the suffix start', () => {
        expect(firstDifferingIndex(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
        expect(firstDifferingIndex(['a', 'x'], ['a', 'y'])).toBe(1);
        expect(firstDifferingIndex(['a'], ['a'])).toBe(1);
        expect(firstDifferingIndex([], ['a'])).toBe(0);
    });

    test('reuses leading line nodes and only appends the suffix', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, [
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
        ]);
        const first = code.children[0];
        const second = code.children[1];
        const result = applyPrefixDiffHtmlLines(code, [
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
            '<span>y = 2</span>',
        ]);
        expect(result).toEqual({ reused: 2, replaced: 0, added: 1, removed: 0 });
        expect(code.children[0]).toBe(first);
        expect(code.children[1]).toBe(second);
        expect(lineHtml(code)).toEqual([
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
            '<span>y = 2</span>',
        ]);
    });

    test('replaces only the first differing line and truncates the suffix', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['one', 'two', 'three']);
        const first = code.children[0];
        const result = applyPrefixDiffHtmlLines(code, ['one', 'TWO']);
        expect(result).toEqual({ reused: 1, replaced: 1, added: 0, removed: 1 });
        expect(code.children[0]).toBe(first);
        expect(lineHtml(code)).toEqual(['one', 'TWO']);
        expect(code.children[1]?.getAttribute(STREAM_LINE_ATTR)).toBe('1');
    });

    test('a no-op update keeps every node', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['a', 'b']);
        const nodes = Array.from(code.children);
        const result = applyPrefixDiffHtmlLines(code, ['a', 'b']);
        expect(result).toEqual({ reused: 2, replaced: 0, added: 0, removed: 0 });
        expect(Array.from(code.children)).toEqual(nodes);
    });

    test('plain-text first paint is replaced by line spans', () => {
        const code = document.createElement('code');
        code.textContent = 'const x = 1';
        const result = applyPrefixDiffHtmlLines(code, ['<span>const x = 1</span>']);
        expect(result.added).toBe(1);
        expect(code.textContent).toBe('const x = 1');
        expect(code.children[0]?.getAttribute(STREAM_LINE_ATTR)).toBe('0');
    });

    test('open fences are stamped for the incremental pass', () => {
        expect(stampOpenFenceHtml('<pre><code>x</code></pre>')).toContain(`${STREAM_FENCE_ATTR}="true"`);
        const already = `<pre ${STREAM_FENCE_ATTR}="true"><code>x</code></pre>`;
        expect(stampOpenFenceHtml(already)).toBe(already);
    });

    test('stamps the last pre when earlier closed fences exist', () => {
        const html = '<pre><code>done</code></pre><pre><code>live</code></pre>';
        const stamped = stampOpenFenceHtml(html);
        expect(stamped.startsWith('<pre><code>done')).toBe(true);
        expect(stamped).toContain(`<pre ${STREAM_FENCE_ATTR}="true"><code>live`);
    });

    test('morph preserve copies the incoming fence text and skips the subtree', () => {
        const from = document.createElement('pre');
        from.setAttribute(STREAM_FENCE_ATTR, 'true');
        const fromCode = document.createElement('code');
        fromCode.textContent = 'const x = 1';
        from.appendChild(fromCode);

        const to = document.createElement('pre');
        to.setAttribute(STREAM_FENCE_ATTR, 'true');
        const toCode = document.createElement('code');
        toCode.textContent = 'const x = 12';
        to.appendChild(toCode);

        expect(shouldPreserveStreamingFence(from, to)).toBe(true);
        expect(fromCode.getAttribute(STREAM_SRC_ATTR)).toBe('const x = 12');
        expect(shouldPreserveStreamingFence(document.createElement('pre'), to)).toBe(false);
    });

    test('upgradeStreamingFenceHighlight patches via prefix-diff and ignores worker failure', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true"><code class="language-ts">const x = 1</code></pre>`;
        const code = root.querySelector('code');
        expect(code).toBeTruthy();

        await upgradeStreamingFenceHighlight(root, async () => ['<span>const x = 1</span>']);
        expect(lineHtml(code!)).toEqual(['<span>const x = 1</span>']);
        const first = code!.children[0];

        code!.setAttribute(STREAM_SRC_ATTR, 'const x = 1\nconst y = 2');
        await upgradeStreamingFenceHighlight(root, async () => [
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);
        expect(code!.children[0]).toBe(first);
        expect(lineHtml(code!)).toEqual([
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);

        await upgradeStreamingFenceHighlight(root, async () => null);
        expect(lineHtml(code!)).toEqual([
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);
    });
});
