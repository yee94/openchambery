import DOMPurify from 'dompurify';
import { DualLimitLru } from '@/lib/dualLimitLru';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { isVSCodeRuntime } from '@/lib/desktop';
import { highlightCodeInWorker, parseMarkdownInWorker } from './markdown-worker';
import type { MarkdownParsedBlock } from './markdown-worker-protocol';
import type { MarkdownWorkerPriority } from './markdown-worker-protocol';
import {
  applyCodeHighlights,
  CODE_HIGHLIGHT_LINE_LIMIT,
  hashMarkdown,
  markdownBlockId,
  parseMarkdownUnsafe,
  shouldUseMainThreadMarkdownParse,
  streamBlocks,
  VSCODE_CODE_HIGHLIGHT_LINE_LIMIT,
  type MarkdownBlock,
} from './markdownParsePipeline';

// ---------------------------------------------------------------------------
// Sanitization (DOMPurify) — allow Shiki/KaTeX/SVG output
// ---------------------------------------------------------------------------

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['svg', 'path', 'g', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'marker'],
  ADD_ATTR: ['d', 'viewBox', 'preserveAspectRatio', 'xmlns', 'target', 'fill', 'stroke', 'stroke-width', 'transform', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'style'],
  FORBID_TAGS: ['script'],
  FORBID_CONTENTS: ['script'],
};

let sanitizeHookInstalled = false;

const ensureSanitizeHook = (): void => {
  if (sanitizeHookInstalled) return;
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return;
  sanitizeHookInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (!(node instanceof HTMLImageElement) || data.attrName !== 'src') return;
    const source = typeof data.attrValue === 'string' ? data.attrValue : '';
    // DOMPurify strips file: URLs before Relay decoration can resolve them.
    // Keep the original locator in a safe data attribute; the decorator replaces
    // the browser-owned source with an opaque native virtual URL before display.
    if (!/^file:/i.test(source)) return;
    node.setAttribute('data-md-image-source', source);
    data.keepAttr = false;
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== '_blank') return;
    node.setAttribute('rel', 'noopener noreferrer');
  });
};

const sanitize = (html: string): string => {
  if (!DOMPurify.isSupported) return '';
  ensureSanitizeHook();
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
};

// Marks block boundaries while a batch shares one sanitize pass. Data
// attributes survive DOMPurify, and the wrapper is unwrapped again below.
const BLOCK_MARKER_ATTR = 'data-md-sanitize-block';

/**
 * Sanitize many blocks in a single DOMPurify pass.
 *
 * Every `DOMPurify.sanitize` call builds and parses its own document, a fixed
 * cost that dwarfs the markup for a short block. Sanitizing block-by-block
 * multiplied it by the block count, which is what made a cold mount of a long
 * message expensive. Wrapping the blocks in marked containers pays it once.
 */
const sanitizeBatch = (htmls: string[]): string[] => {
  if (htmls.length === 0) return [];
  if (htmls.length === 1) return [sanitize(htmls[0])];
  if (!DOMPurify.isSupported || typeof document === 'undefined') {
    return htmls.map((html) => sanitize(html));
  }

  const joined = htmls
    .map((html, index) => `<div ${BLOCK_MARKER_ATTR}="${index}">${html}</div>`)
    .join('');
  const host = document.createElement('div');
  host.innerHTML = sanitize(joined);

  const results = htmls.map(() => '');
  host.querySelectorAll(`[${BLOCK_MARKER_ATTR}]`).forEach((node) => {
    const index = Number(node.getAttribute(BLOCK_MARKER_ATTR));
    if (Number.isInteger(index) && index >= 0 && index < results.length) {
      results[index] = node.innerHTML;
    }
  });
  return results;
};

const resolveHighlightLineLimit = (): number => (
  isVSCodeRuntime() ? VSCODE_CODE_HIGHLIGHT_LINE_LIMIT : CODE_HIGHLIGHT_LINE_LIMIT
);

// ---------------------------------------------------------------------------
// Per-block HTML cache (LRU, mirrors OpenCode's checksum cache)
// ---------------------------------------------------------------------------

const CACHE_MAX = 240;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SYNC_CACHE_MAX = 160;
const SYNC_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const htmlCache = new DualLimitLru<string, { hash: string; html: string }>({
  maxEntries: CACHE_MAX,
  maxBytes: CACHE_MAX_BYTES,
});
const syncHtmlCache = new DualLimitLru<string, { source: string; html: string }>({
  maxEntries: SYNC_CACHE_MAX,
  maxBytes: SYNC_CACHE_MAX_BYTES,
});

const stringBytes = (value: string): number => value.length * 2;

const cacheRenderedBlock = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.set(
    key,
    entry,
    stringBytes(key) + stringBytes(entry.hash) + stringBytes(entry.html),
  );
};

const highlightCodeBlocks = async (
  html: string,
  signal: AbortSignal | undefined,
  priority: MarkdownWorkerPriority,
): Promise<string | null> => applyCodeHighlights(
  html,
  (code, lang) => highlightCodeInWorker(code, lang, { signal, priority }),
  { lineLimit: resolveHighlightLineLimit(), isCancelled: () => Boolean(signal?.aborted) },
);

const parseBlockOnMain = async (
  block: MarkdownBlock,
  signal: AbortSignal | undefined,
  priority: MarkdownWorkerPriority,
): Promise<string | null> => {
  if (signal?.aborted) return null;
  const parsed = parseMarkdownUnsafe(block.src);
  if (signal?.aborted) return null;
  const highlighted = block.highlight
    ? await highlightCodeBlocks(parsed, signal, priority)
    : parsed;
  if (highlighted === null || signal?.aborted) return null;
  const sanitized = sanitize(highlighted);
  return signal?.aborted ? null : sanitized;
};

/**
 * Synchronous styled render for the first paint, before the async pipeline
 * (Shiki-in-worker highlight) resolves. Produces the SAME structural HTML as
 * `renderMarkdownBlocks` minus syntax coloring: paragraphs, lists, code blocks
 * and bold all render at their final width, so the async pass only upgrades
 * code-block colors — no flash of full-width raw markdown source. `parser.parse`
 * is synchronous (marked is not configured `async`), so this never blocks on a
 * worker round-trip.
 */
const syncCacheKey = (text: string): string => `${hashMarkdown(text)}:${text.length}`;

const readSyncCache = (text: string): string | undefined => {
  const cached = syncHtmlCache.get(syncCacheKey(text));
  return cached?.source === text ? cached.html : undefined;
};

const writeSyncCache = (text: string, html: string): void => {
  const key = syncCacheKey(text);
  syncHtmlCache.set(
    key,
    { source: text, html },
    stringBytes(key) + stringBytes(text) + stringBytes(html),
  );
};

export const renderMarkdownSync = (text: string): string => {
  if (!text) return '';
  const cached = readSyncCache(text);
  if (cached !== undefined) {
    return cached;
  }
  const html = sanitize(parseMarkdownUnsafe(text));
  writeSyncCache(text, html);
  return html;
};

/**
 * Same first-paint render as `renderMarkdownSync`, but split on the block
 * boundaries `renderMarkdownBlocks` will use. The first paint therefore lays
 * down the block elements the async pass expects, so upgrading to the
 * highlighted DOM morphs each block in place instead of reshaping a single
 * whole-document block into many.
 */
export const renderMarkdownSyncBlocks = (text: string): string[] => {
  if (!text) return [];
  const sources = streamBlocks(text, false).map((block) => block.src);
  const results: string[] = new Array(sources.length).fill('');
  const pendingIndexes: number[] = [];
  const pendingHtml: string[] = [];

  sources.forEach((src, index) => {
    const cached = readSyncCache(src);
    if (cached !== undefined) {
      results[index] = cached;
      return;
    }
    pendingIndexes.push(index);
    pendingHtml.push(parseMarkdownUnsafe(src));
  });

  const sanitized = sanitizeBatch(pendingHtml);
  pendingIndexes.forEach((index, slot) => {
    const html = sanitized[slot] ?? '';
    results[index] = html;
    writeSyncCache(sources[index], html);
  });

  return results;
};

export type RenderedBlock = {
  // Stable identity across renders for per-block DOM reconciliation. Encodes
  // content + mode + highlight so any change forces that block (and only that
  // block) to re-morph; unchanged leading blocks are skipped entirely.
  id: string;
  html: string;
};

const RENDER_SLICE_BUDGET_MS = 8;

const nowMs = (): number => (
  typeof performance !== 'undefined' ? performance.now() : Date.now()
);

const waitForAfterPaint = (signal?: AbortSignal): Promise<boolean> => {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      resolve(value);
    };
    const cancel = scheduleAfterPaintTask(() => {
      finish(!signal?.aborted);
    }, { priority: 'visible' });
    const handleAbort = () => {
      cancel();
      finish(false);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
};

const readCachedRenderedBlocks = (
  blocks: MarkdownBlock[],
  cacheKey: string,
): RenderedBlock[] | null => {
  const rendered: RenderedBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) return null;
    const contentHash = hashMarkdown(block.raw);
    const key = `${cacheKey}:${index}:${block.mode}`;
    const cached = htmlCache.get(key);
    if (!cached || cached.hash !== contentHash) {
      return null;
    }
    rendered.push({ id: markdownBlockId(block), html: cached.html });
  }
  return rendered;
};

const commitParsedBlocks = (
  blocks: MarkdownBlock[],
  parsed: MarkdownParsedBlock[],
  cacheKey: string,
): RenderedBlock[] => {
  const sanitized = sanitizeBatch(parsed.map((block) => block.html));
  return parsed.map((block, index) => {
    const source = blocks[index];
    const html = sanitized[index] ?? '';
    if (source) {
      cacheRenderedBlock(`${cacheKey}:${index}:${source.mode}`, {
        hash: hashMarkdown(source.raw),
        html,
      });
    }
    return { id: block.id, html };
  });
};

const renderMarkdownBlocksOnMain = async (
  blocks: MarkdownBlock[],
  cacheKey: string,
  streaming: boolean,
  signal: AbortSignal | undefined,
): Promise<RenderedBlock[]> => {
  const priority: MarkdownWorkerPriority = streaming ? 'visible' : 'background';
  const renderBlock = async (block: MarkdownBlock, index: number): Promise<RenderedBlock | null> => {
    if (signal?.aborted) return null;
    const contentHash = hashMarkdown(block.raw);
    const id = markdownBlockId(block);
    const key = `${cacheKey}:${index}:${block.mode}`;
    const cached = htmlCache.get(key);
    if (cached && cached.hash === contentHash) {
      return { id, html: cached.html };
    }
    const html = await parseBlockOnMain(block, signal, priority);
    if (html === null || signal?.aborted) return null;
    cacheRenderedBlock(key, { hash: contentHash, html });
    return { id, html };
  };

  if (streaming) {
    const results = await Promise.all(blocks.map(renderBlock));
    return results.filter((result): result is RenderedBlock => result !== null);
  }

  // Non-streaming renders yield to paint so a long message never blocks the
  // frame, but yielding once per block would cost one frame per block now that
  // a finished message keeps the streamed segmentation (the caller only commits
  // once every block has resolved). Yield on a time budget instead: cache hits
  // and cheap blocks drain within a single slice, and only genuinely expensive
  // work pushes the next slice to the following paint.
  const rendered: RenderedBlock[] = [];
  let sliceDeadline = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (signal?.aborted) {
      break;
    }
    const block = blocks[index];
    if (!block) {
      continue;
    }
    if (nowMs() >= sliceDeadline) {
      if (!await waitForAfterPaint(signal)) {
        break;
      }
      sliceDeadline = nowMs() + RENDER_SLICE_BUDGET_MS;
    }
    const result = await renderBlock(block, index);
    if (result) {
      rendered.push(result);
    }
  }
  return rendered;
};

/**
 * Render markdown into an array of per-block sanitized HTML. Streaming-aware:
 * splits into blocks, caches per-block, heals incomplete syntax. Returning
 * blocks (instead of one joined string) lets the renderer re-morph only the
 * block that changed, keeping per-step streaming cost ~O(last block).
 *
 * Long messages parse off-thread. Short fence-free text stays on the sync
 * main-thread path. A worker failure falls back to the main parser so a
 * message is never blanked.
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  cacheKey: string,
  signal?: AbortSignal,
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = streamBlocks(text, streaming);
  const cached = readCachedRenderedBlocks(blocks, cacheKey);
  if (cached) {
    return cached;
  }

  const priority: MarkdownWorkerPriority = streaming ? 'visible' : 'background';
  const pending: MarkdownBlock[] = [];
  const pendingIndexes: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const cachedBlock = htmlCache.get(`${cacheKey}:${index}:${block.mode}`);
    if (cachedBlock && cachedBlock.hash === hashMarkdown(block.raw)) {
      continue;
    }
    pending.push(block);
    pendingIndexes.push(index);
  }

  if (!shouldUseMainThreadMarkdownParse(text, streaming) && pending.length > 0) {
    try {
      const parsed = await parseMarkdownInWorker({
        streaming,
        highlight: true,
        highlightLineLimit: resolveHighlightLineLimit(),
        signal,
        priority,
        blocks: pending,
      });
      if (signal?.aborted) return [];
      if (parsed && parsed.length === pending.length) {
        const merged: MarkdownParsedBlock[] = blocks.map((block, index) => {
          const pendingSlot = pendingIndexes.indexOf(index);
          if (pendingSlot >= 0) {
            return parsed[pendingSlot] ?? { id: markdownBlockId(block), html: '', highlight: block.highlight };
          }
          const cachedBlock = htmlCache.get(`${cacheKey}:${index}:${block.mode}`);
          return {
            id: markdownBlockId(block),
            html: cachedBlock?.html ?? '',
            highlight: block.highlight,
          };
        });
        return commitParsedBlocks(blocks, merged, cacheKey);
      }
    } catch {
      // Worker crash / unsupported environment: fall through to main parse.
    }
  }

  return renderMarkdownBlocksOnMain(blocks, cacheKey, streaming, signal);
};
