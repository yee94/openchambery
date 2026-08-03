import { marked, type Tokens } from 'marked';
import remend from 'remend';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { DualLimitLru } from '@/lib/dualLimitLru';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '@/lib/messages/inlineMessageLinks';
import { isVSCodeRuntime } from '@/lib/desktop';
import { parseCodeFenceInfo, type CodeFenceInfo } from './codeFenceInfo';
import { highlightCodeInWorker } from './markdown-worker';
import type { MarkdownWorkerPriority } from './markdown-worker-protocol';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Streaming block segmentation (port of OpenCode's markdown-stream)
// ---------------------------------------------------------------------------

type MarkdownBlock = {
  raw: string;
  src: string;
  mode: 'full' | 'live';
  // When false, skip syntax highlighting for this block. Set for the actively
  // streaming open code fence so we don't re-tokenize a growing block ~40x/sec
  // (O(n^2)); it highlights once the fence closes and becomes a stable block.
  highlight: boolean;
};

const hasReferenceDefinitions = (text: string): boolean =>
  /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);

// Returns true when `raw` opens a fenced code block whose closing fence has not
// arrived yet — meaning the block is still streaming and must be rendered as
// raw text, not parsed.
const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

const heal = (text: string): string => {
  try {
    return remend(text, { linkMode: 'text-only' });
  } catch {
    return text;
  }
};

/**
 * Split markdown into render blocks. Heals incomplete syntax and isolates an
 * unclosed trailing code fence into its own block so a partial fence does not
 * corrupt the parse of stable content above it.
 *
 * Segmentation is deliberately identical whether or not the stream is still
 * live: only `mode` differs (the trailing block is `live` while streaming). A
 * completed message therefore lands on the SAME per-block boundaries — and the
 * same block hashes — the stream already rendered, so finishing a turn reuses
 * the per-block HTML cache and morphs nothing instead of tearing the whole
 * message down and re-parsing/re-highlighting it in one shot.
 */
const segmentBlocks = (text: string, live: boolean): MarkdownBlock[] => {
  const tailMode: MarkdownBlock['mode'] = live ? 'live' : 'full';
  // Reference-style links/footnotes span multiple tokens (definition elsewhere);
  // keep them as a single block so per-block parsing doesn't break the refs.
  if (hasReferenceDefinitions(text)) {
    return [{ raw: text, src: heal(text), mode: tailMode, highlight: true }];
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as Tokens.Generic[];
  } catch {
    return [{ raw: text, src: heal(text), mode: tailMode, highlight: true }];
  }

  let tail = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i]?.type !== 'space') {
      tail = i;
      break;
    }
  }
  if (tail < 0) return [{ raw: text, src: heal(text), mode: tailMode, highlight: true }];

  // Split into per-token blocks. Stable leading blocks become `full` (complete,
  // cache-stable, not re-healed); only the trailing block is `live` and gets
  // re-parsed as content streams in. This keeps per-step work proportional to
  // the last block rather than the whole message.
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.type === 'space') continue;
    const raw = token.raw ?? '';
    const isLast = i === tail;
    const openFence = token.type === 'code' && hasOpenFence(raw);
    blocks.push({
      raw,
      src: openFence ? raw : heal(raw),
      mode: isLast ? tailMode : 'full',
      highlight: !openFence,
    });
  }

  if (blocks.length === 0) {
    return [{ raw: text, src: heal(text), mode: tailMode, highlight: true }];
  }
  return blocks;
};

// Segmentation runs twice for the same text on a cold mount: once for the
// synchronous first paint and once for the async pipeline. Lexing a long
// message twice per hydrated row is enough to show up while scrolling through
// history, so hand the second caller the blocks the first one already computed.
const SEGMENTATION_CACHE_MAX = 16;
const segmentationCache = new Map<string, MarkdownBlock[]>();

const streamBlocks = (text: string, live: boolean): MarkdownBlock[] => {
  const key = `${live ? 1 : 0}:${text}`;
  const cached = segmentationCache.get(key);
  if (cached) {
    segmentationCache.delete(key);
    segmentationCache.set(key, cached);
    return cached;
  }

  const blocks = segmentBlocks(text, live);
  while (segmentationCache.size >= SEGMENTATION_CACHE_MAX) {
    const oldest = segmentationCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    segmentationCache.delete(oldest);
  }
  segmentationCache.set(key, blocks);
  return blocks;
};

// ---------------------------------------------------------------------------
// marked parser (HTML string output) with safe external links
// ---------------------------------------------------------------------------

// Math delimiters that use backslashes — `\(...\)` (inline) and `\[...\]`
// (display) — must be caught during lexing: marked treats `\(`/`\[` as
// backslash escapes and strips the slash before any HTML post-process can see
// them. Registering them as tokenizers also makes them code-safe for free
// (marked tokenizes code spans/fences first, so these never fire inside code).
// Single-dollar `$...$` is intentionally NOT supported — it collides with
// currency text ($50, US$ 680); only `$$...$$` survives as display math (see
// renderMathExpressions). This mirrors KaTeX auto-render's default delimiters.
type MathToken = { type: string; raw: string; text: string };

const renderKatex = (math: string, raw: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: false });
  } catch {
    return raw;
  }
};

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    const index = src.indexOf('\\(');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, false);
  },
};

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const index = src.indexOf('\\[');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: Tokens.Generic) {
    const math = token as MathToken;
    return renderKatex(math.text, math.raw, true);
  },
};

const parser = marked.use({
  gfm: true,
  breaks: false,
  extensions: [inlineMathExtension, blockMathExtension],
  renderer: {
    link({ href, title, text }) {
      const target = href ?? '';
      const agentName = parseAgentHref(target);
      if (agentName) {
        return `<a href="${escapeAttr(buildAgentMentionUrl(agentName))}" data-openchamber-agent-mention="true" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      const skillName = parseSkillHref(target);
      if (skillName) {
        return `<a href="${escapeAttr(target)}" data-skill-name="${escapeAttr(skillName)}" class="text-primary hover:underline">${text}</a>`;
      }
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(target)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

// ---------------------------------------------------------------------------
// Math (KaTeX) — post-process the parsed HTML, skipping code/pre/kbd content
// ---------------------------------------------------------------------------

// Only `$$...$$` (display) is handled here. Single-dollar `$...$` inline math is
// deliberately omitted: it parses currency text ($50, US$ 680, "$50M to $72M")
// as math and corrupts it. Inline math is supported via `\(...\)` (see the
// marked extensions above). `$$` survives marked untouched (no backslash), so
// post-processing the parsed HTML — skipping code via renderMathExpressions —
// stays correct and code-safe.
const renderMathInText = (text: string): string =>
  text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: true, throwOnError: false });
    } catch {
      return `$$${math}$$`;
    }
  });

const renderMathExpressions = (html: string): string => {
  // No `$` anywhere means no math to render — skip the split + regex passes on
  // the hot streaming path (the overwhelming majority of blocks have no math).
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  return html
    .split(codeBlockPattern)
    .map((part, index) => (index % 2 === 1 ? part : renderMathInText(part)))
    .join('');
};

// ---------------------------------------------------------------------------
// Syntax highlighting (Shiki via @pierre/diffs shared highlighter)
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

// Skip syntax highlighting for very large blocks — tokenizing thousands of
// lines blocks the main thread. Plain (escaped) code is shown instead.
const CODE_HIGHLIGHT_LINE_LIMIT = 1200;
const VSCODE_CODE_HIGHLIGHT_LINE_LIMIT = 200;

const exceedsLineLimit = (value: string, limit: number): boolean => {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10 && ++lines > limit) return true;
  }
  return false;
};

const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// Only a reference needs its own label; leaving plain fences with the single
// attribute they had before keeps them morphing to identical markup.
const codeLangAttrs = (info: CodeFenceInfo): string => (
  info.reference
    ? `data-md-lang="${escapeAttr(info.lang)}" data-md-label="${escapeAttr(info.label)}"`
    : `data-md-lang="${escapeAttr(info.lang)}"`
);

const highlightCodeBlocks = async (
  html: string,
  signal: AbortSignal | undefined,
  priority: MarkdownWorkerPriority,
): Promise<string | null> => {
  if (signal?.aborted) return null;
  const matches = [...html.matchAll(CODE_BLOCK_RE)];
  if (matches.length === 0) return html;

  const lineLimit = isVSCodeRuntime() ? VSCODE_CODE_HIGHLIGHT_LINE_LIMIT : CODE_HIGHLIGHT_LINE_LIMIT;

  let result = html;
  for (const match of matches) {
    if (signal?.aborted) return null;
    const [full, rawLang, escapedCode] = match;
    const info = parseCodeFenceInfo(rawLang);
    // Leave mermaid fences untouched so the decorate pass can render them as
    // diagrams (highlighting would strip the `language-mermaid` class). A
    // reference to a `.mmd` file is source, not a diagram, so it still colors.
    if (info.lang === 'mermaid' && !info.reference) continue;

    const code = unescapeHtml(escapedCode ?? '');

    // Oversized block: skip highlight, keep plain code but stamp the language.
    if (exceedsLineLimit(code, lineLimit)) {
      result = result.replace(full, () => full.replace('<pre', `<pre ${codeLangAttrs(info)}`));
      continue;
    }

    // Tokenize off the main thread. On failure the worker resolves to null and
    // we keep the original escaped <pre><code> (no main-thread highlight).
    const highlighted = await highlightCodeInWorker(code, info.lang, { signal, priority });
    if (signal?.aborted) return null;
    if (highlighted) {
      // Stamp the language so the decorate pass can show a header label.
      const stamped = highlighted.replace(/^<pre/, `<pre ${codeLangAttrs(info)}`);
      result = result.replace(full, () => stamped);
    }
  }

  return result;
};

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

// FNV-1a 32-bit hash of the block content.
const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const stringBytes = (value: string): number => value.length * 2;

const cacheRenderedBlock = (key: string, entry: { hash: string; html: string }): void => {
  htmlCache.set(
    key,
    entry,
    stringBytes(key) + stringBytes(entry.hash) + stringBytes(entry.html),
  );
};

const parseBlock = async (
  block: MarkdownBlock,
  signal: AbortSignal | undefined,
  priority: MarkdownWorkerPriority,
): Promise<string | null> => {
  if (signal?.aborted) return null;
  const parsed = await Promise.resolve(parser.parse(block.src));
  if (signal?.aborted) return null;
  const withMath = renderMathExpressions(parsed);
  if (signal?.aborted) return null;
  const highlighted = block.highlight
    ? await highlightCodeBlocks(withMath, signal, priority)
    : withMath;
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
const syncCacheKey = (text: string): string => `${hash(text)}:${text.length}`;

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

// Markdown -> HTML for one block, everything except sanitization.
const renderSyncUnsafe = (text: string): string => (
  renderMathExpressions(parser.parse(text) as string)
);

export const renderMarkdownSync = (text: string): string => {
  if (!text) return '';
  const cached = readSyncCache(text);
  if (cached !== undefined) {
    return cached;
  }
  const html = sanitize(renderSyncUnsafe(text));
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
    pendingHtml.push(renderSyncUnsafe(src));
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

// How long a non-streaming render may keep the main thread before yielding to
// the next paint.
const RENDER_SLICE_BUDGET_MS = 8;

const nowMs = (): number => (
  typeof performance !== 'undefined' ? performance.now() : Date.now()
);

// Resolves after the next paint, or `false` as soon as the render is aborted.
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

/**
 * Render markdown into an array of per-block sanitized HTML. Streaming-aware:
 * splits into blocks, caches per-block, heals incomplete syntax. Returning
 * blocks (instead of one joined string) lets the renderer re-morph only the
 * block that changed, keeping per-step streaming cost ~O(last block).
 */
export const renderMarkdownBlocks = async (
  text: string,
  streaming: boolean,
  cacheKey: string,
  signal?: AbortSignal,
): Promise<RenderedBlock[]> => {
  if (!text) return [];

  const blocks = streamBlocks(text, streaming);
  const priority: MarkdownWorkerPriority = streaming ? 'visible' : 'background';
  const renderBlock = async (block: MarkdownBlock, index: number): Promise<RenderedBlock | null> => {
    if (signal?.aborted) return null;
    const contentHash = hash(block.raw);
    const id = `${contentHash}:${block.mode}:${block.highlight ? 1 : 0}`;
    const key = `${cacheKey}:${index}:${block.mode}`;
    const cached = htmlCache.get(key);
    if (cached && cached.hash === contentHash) {
      return { id, html: cached.html };
    }
    const html = await parseBlock(block, signal, priority);
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