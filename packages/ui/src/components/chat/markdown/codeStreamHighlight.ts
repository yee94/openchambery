/**
 * Incremental highlight for an open/streaming fence.
 *
 * Closed fences stay on the full `codeToHtml` path. While the fence is still
 * growing, tokenize off-thread (`highlightLines`) and patch only the suffix:
 * unchanged leading line nodes are reused, the first differing line is
 * replaced, and trailing lines are appended or removed.
 */

export const STREAM_FENCE_ATTR = 'data-md-stream-fence';
export const STREAM_LINE_ATTR = 'data-md-stream-line';
export const STREAM_SRC_ATTR = 'data-md-stream-src';
export const STREAM_APPLIED_ATTR = 'data-md-stream-applied';

export type PrefixDiffResult = {
    reused: number;
    replaced: number;
    added: number;
    removed: number;
};

export const firstDifferingIndex = <T>(previous: readonly T[], next: readonly T[]): number => {
    const limit = Math.min(previous.length, next.length);
    for (let index = 0; index < limit; index += 1) {
        if (previous[index] !== next[index]) {
            return index;
        }
    }
    return limit;
};

const lineElements = (code: HTMLElement): HTMLElement[] => (
    Array.from(code.children).filter((node): node is HTMLElement => (
        node instanceof HTMLElement && node.hasAttribute(STREAM_LINE_ATTR)
    ))
);

const createLine = (html: string, index: number): HTMLElement => {
    const line = document.createElement('span');
    line.setAttribute(STREAM_LINE_ATTR, String(index));
    line.className = 'line';
    line.innerHTML = html;
    return line;
};

/**
 * Patch `code` so its children match `nextLines` (per-line inner HTML from
 * the Shiki worker). Leading equal lines keep their DOM nodes.
 */
export const applyPrefixDiffHtmlLines = (
    code: HTMLElement,
    nextLines: readonly string[],
): PrefixDiffResult => {
    const existing = lineElements(code);
    const previous = existing.map((line) => line.innerHTML);
    const shared = firstDifferingIndex(previous, nextLines);

    if (existing.length === 0 && code.childNodes.length > 0 && nextLines.length > 0) {
        code.replaceChildren();
        for (let index = 0; index < nextLines.length; index += 1) {
            code.appendChild(createLine(nextLines[index] ?? '', index));
        }
        return { reused: 0, replaced: 0, added: nextLines.length, removed: 0 };
    }

    let replaced = 0;
    if (shared < existing.length && shared < nextLines.length) {
        const line = existing[shared];
        if (line) {
            line.innerHTML = nextLines[shared] ?? '';
            line.setAttribute(STREAM_LINE_ATTR, String(shared));
            replaced = 1;
        }
    }

    let removed = 0;
    for (let index = existing.length - 1; index >= shared + replaced; index -= 1) {
        existing[index]?.remove();
        removed += 1;
    }

    let added = 0;
    for (let index = shared + replaced; index < nextLines.length; index += 1) {
        code.appendChild(createLine(nextLines[index] ?? '', index));
        added += 1;
    }

    const reused = shared;
    return { reused, replaced, added, removed };
};

export const stampOpenFenceHtml = (html: string): string => {
    if (html.includes(`${STREAM_FENCE_ATTR}=`)) return html;
    const lastPre = html.toLowerCase().lastIndexOf('<pre');
    if (lastPre < 0) return html;
    return `${html.slice(0, lastPre)}${html.slice(lastPre).replace(/<pre\b/i, `<pre ${STREAM_FENCE_ATTR}="true"`)}`;
};

/** Incoming morph HTML carries the latest fence text; keep highlighted children. */
export const shouldPreserveStreamingFence = (fromEl: Node, toEl: Node): boolean => {
    if (!(fromEl instanceof HTMLElement) || !(toEl instanceof HTMLElement)) return false;
    if (fromEl.getAttribute(STREAM_FENCE_ATTR) !== 'true') return false;
    if (toEl.getAttribute(STREAM_FENCE_ATTR) !== 'true') return false;
    const fromCode = fromEl.tagName === 'CODE' ? fromEl : fromEl.querySelector('code');
    const toCode = toEl.tagName === 'CODE' ? toEl : toEl.querySelector('code');
    if (fromCode instanceof HTMLElement && toCode instanceof HTMLElement) {
        fromCode.setAttribute(STREAM_SRC_ATTR, toCode.textContent ?? '');
    }
    return true;
};

export const streamingFenceSource = (code: HTMLElement): string => (
    code.getAttribute(STREAM_SRC_ATTR) ?? code.textContent ?? ''
);

export const findStreamingFenceCode = (root: ParentNode): HTMLElement[] => {
    const pres = root.querySelectorAll(`pre[${STREAM_FENCE_ATTR}="true"]`);
    const codes: HTMLElement[] = [];
    pres.forEach((pre) => {
        const code = pre.querySelector('code');
        if (code instanceof HTMLElement) {
            codes.push(code);
        }
    });
    return codes;
};

export const languageFromCodeElement = (code: HTMLElement): string => {
    const labeled = code.closest('pre')?.getAttribute('data-md-lang');
    if (labeled) return labeled;
    const match = code.className.match(/language-([^\s"]+)/);
    return match?.[1] || 'text';
};

export type HighlightLinesFn = (
    code: string,
    lang: string,
    options?: { signal?: AbortSignal; priority?: 'visible' | 'background' },
) => Promise<string[] | null>;

/**
 * Tokenize open fences off-thread and patch only the changed suffix.
 * Failure leaves the previous (or stamped plain) markup in place.
 */
export const upgradeStreamingFenceHighlight = async (
    root: ParentNode,
    highlightLines: HighlightLinesFn,
    options?: { signal?: AbortSignal; priority?: 'visible' | 'background' },
): Promise<void> => {
    if (options?.signal?.aborted) return;
    const codes = findStreamingFenceCode(root);
    await Promise.all(codes.map(async (code) => {
        const source = streamingFenceSource(code);
        if (!source || options?.signal?.aborted) return;
        if (code.getAttribute(STREAM_APPLIED_ATTR) === source) return;
        const lang = languageFromCodeElement(code);
        if (lang === 'mermaid') return;
        const lines = await highlightLines(source, lang, options);
        if (!lines || options?.signal?.aborted || !root.contains(code)) return;
        applyPrefixDiffHtmlLines(code, lines);
        code.setAttribute(STREAM_APPLIED_ATTR, source);
        code.removeAttribute(STREAM_SRC_ATTR);
    }));
};
