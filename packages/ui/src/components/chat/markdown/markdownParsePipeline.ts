import { marked, type Tokens } from 'marked';
import remend from 'remend';
import katex from 'katex';
import { buildAgentMentionUrl, parseAgentHref, parseSkillHref } from '../../../lib/messages/inlineMessageLinks';
import { parseCodeFenceInfo, type CodeFenceInfo } from './codeFenceInfo';
import { findDollarMathStart, matchDollarMath } from './markdownMath';

/**
 * DOM-free markdown parse: segment, heal, marked, KaTeX. Safe for the Shiki
 * worker. Sanitization stays on the main thread (DOMPurify needs `document`).
 */

export type MarkdownBlock = {
  raw: string;
  src: string;
  mode: 'full' | 'live';
  // When false, skip syntax highlighting for this block. Set for the actively
  // streaming open code fence so we don't re-tokenize a growing block ~40x/sec
  // (O(n^2)); it highlights once the fence closes and becomes a stable block.
  highlight: boolean;
};

export type ParsedMarkdownBlock = {
  id: string;
  html: string;
  highlight: boolean;
};

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const hashMarkdown = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

export const markdownBlockId = (block: MarkdownBlock): string => (
  `${hashMarkdown(block.raw)}:${block.mode}:${block.highlight ? 1 : 0}`
);

const hasReferenceDefinitions = (text: string): boolean =>
  /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);

export const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

export const healMarkdown = (text: string): string => {
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
export const segmentBlocks = (text: string, live: boolean): MarkdownBlock[] => {
  const tailMode: MarkdownBlock['mode'] = live ? 'live' : 'full';
  // Reference-style links/footnotes span multiple tokens (definition elsewhere);
  // keep them as a single block so per-block parsing doesn't break the refs.
  if (hasReferenceDefinitions(text)) {
    return [{ raw: text, src: healMarkdown(text), mode: tailMode, highlight: true }];
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as Tokens.Generic[];
  } catch {
    return [{ raw: text, src: healMarkdown(text), mode: tailMode, highlight: true }];
  }

  let tail = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i]?.type !== 'space') {
      tail = i;
      break;
    }
  }
  if (tail < 0) return [{ raw: text, src: healMarkdown(text), mode: tailMode, highlight: true }];

  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.type === 'space') continue;
    const raw = token.raw ?? '';
    const isLast = i === tail;
    const openFence = token.type === 'code' && hasOpenFence(raw);
    blocks.push({
      raw,
      src: openFence ? raw : healMarkdown(raw),
      mode: isLast ? tailMode : 'full',
      highlight: !openFence,
    });
  }

  if (blocks.length === 0) {
    return [{ raw: text, src: healMarkdown(text), mode: tailMode, highlight: true }];
  }
  return blocks;
};

const SEGMENTATION_CACHE_MAX = 16;
const segmentationCache = new Map<string, MarkdownBlock[]>();

export const streamBlocks = (text: string, live: boolean): MarkdownBlock[] => {
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

type DollarMathToken = MathToken & { display: boolean };

const dollarMathExtension = {
  name: 'dollarMath',
  level: 'inline' as const,
  start(src: string) {
    return findDollarMathStart(src);
  },
  tokenizer(src: string): DollarMathToken | undefined {
    const match = matchDollarMath(src);
    if (!match) return undefined;
    return { type: 'dollarMath', raw: match.raw, text: match.text, display: match.display };
  },
  renderer(token: Tokens.Generic) {
    const math = token as DollarMathToken;
    return renderKatex(math.text, math.raw, math.display);
  },
};

const parser = marked.use({
  gfm: true,
  breaks: false,
  extensions: [inlineMathExtension, blockMathExtension, dollarMathExtension],
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

const renderMathInText = (text: string): string =>
  text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: true, throwOnError: false });
    } catch {
      return `$$${math}$$`;
    }
  });

export const renderMathExpressions = (html: string): string => {
  if (html.indexOf('$') === -1) return html;

  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi;
  return html
    .split(codeBlockPattern)
    .map((part, index) => (index % 2 === 1 ? part : renderMathInText(part)))
    .join('');
};

export const parseMarkdownUnsafe = (text: string): string => (
  renderMathExpressions(parser.parse(text) as string)
);

export const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

export const CODE_HIGHLIGHT_LINE_LIMIT = 1200;
export const VSCODE_CODE_HIGHLIGHT_LINE_LIMIT = 200;

export const exceedsLineLimit = (value: string, limit: number): boolean => {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10 && ++lines > limit) return true;
  }
  return false;
};

export const unescapeHtml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

export const codeLangAttrs = (info: CodeFenceInfo): string => (
  info.reference
    ? `data-md-lang="${escapeAttr(info.lang)}" data-md-label="${escapeAttr(info.label)}"`
    : `data-md-lang="${escapeAttr(info.lang)}"`
);

export type HighlightCodeFn = (
  code: string,
  lang: string,
) => Promise<string | null>;

export const applyCodeHighlights = async (
  html: string,
  highlight: HighlightCodeFn,
  options: { lineLimit: number; isCancelled?: () => boolean },
): Promise<string | null> => {
  if (options.isCancelled?.()) return null;
  const matches = [...html.matchAll(CODE_BLOCK_RE)];
  if (matches.length === 0) return html;

  let result = html;
  for (const match of matches) {
    if (options.isCancelled?.()) return null;
    const [full, rawLang, escapedCode] = match;
    const info = parseCodeFenceInfo(rawLang);
    if (info.lang === 'mermaid' && !info.reference) continue;

    const code = unescapeHtml(escapedCode ?? '');
    if (exceedsLineLimit(code, options.lineLimit)) {
      result = result.replace(full, () => full.replace('<pre', `<pre ${codeLangAttrs(info)}`));
      continue;
    }

    const highlighted = await highlight(code, info.lang);
    if (options.isCancelled?.()) return null;
    if (highlighted) {
      const stamped = highlighted.replace(/^<pre/, `<pre ${codeLangAttrs(info)}`);
      result = result.replace(full, () => stamped);
    }
  }

  return result;
};

/** Short, fence-free text stays on the main-thread sync path — a worker hop costs more than marked. */
export const SYNC_MARKDOWN_FAST_PATH_CHARS = 480;

export const shouldUseMainThreadMarkdownParse = (text: string, streaming: boolean): boolean => (
  !streaming && text.length <= SYNC_MARKDOWN_FAST_PATH_CHARS && !text.includes('```')
);

export const parseMarkdownBlocksUnsafe = (
  text: string,
  streaming: boolean,
): ParsedMarkdownBlock[] => {
  if (!text) return [];
  return streamBlocks(text, streaming).map((block) => ({
    id: markdownBlockId(block),
    html: parseMarkdownUnsafe(block.src),
    highlight: block.highlight,
  }));
};
