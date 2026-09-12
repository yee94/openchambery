/**
 * Cap-parity markdown model for Expo RN chat.
 *
 * Cap WebView uses marked (gfm:true, breaks:false) in markdownParsePipeline /
 * MarkdownRendererImpl, with markstream-react as an optional DOM renderer.
 * Neither Markstream nor the morphdom/DOMPurify/Shiki pipeline is RN-portable.
 * We reuse Cap's marked lexer settings and render tokens as RN views.
 */

import { marked, type Token, type Tokens } from 'marked';

/** Match Cap markdownParsePipeline parser options. */
const CAP_MARKED_OPTIONS = {
  gfm: true,
  breaks: false,
} as const;

marked.setOptions(CAP_MARKED_OPTIONS);

export type ChatMarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: ChatMarkdownInline[] }
  | { kind: 'em'; children: ChatMarkdownInline[] }
  | { kind: 'codespan'; text: string }
  | { kind: 'link'; href: string; title?: string; children: ChatMarkdownInline[] }
  | { kind: 'br' }
  | { kind: 'del'; children: ChatMarkdownInline[] };

export type ChatMarkdownBlock =
  | { kind: 'paragraph'; children: ChatMarkdownInline[] }
  | { kind: 'heading'; depth: number; children: ChatMarkdownInline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ChatMarkdownInline[][] }
  | { kind: 'blockquote'; children: ChatMarkdownBlock[] }
  | { kind: 'hr' }
  | { kind: 'space' }
  | { kind: 'plain'; text: string };

export type ChatMarkdownDoc = {
  blocks: ChatMarkdownBlock[];
};

const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

/** Cap-style external link gate — only http(s)/mailto/tel open. */
export const isSafeMarkdownHref = (href: string): boolean => {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return false;
  return SAFE_HREF.test(trimmed);
};

const inlineFromTokens = (tokens: Token[] | undefined): ChatMarkdownInline[] => {
  if (!tokens || tokens.length === 0) return [];
  const out: ChatMarkdownInline[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          out.push(...inlineFromTokens(t.tokens));
        } else {
          out.push({ kind: 'text', text: t.text ?? t.raw ?? '' });
        }
        break;
      }
      case 'escape': {
        const t = token as Tokens.Escape;
        out.push({ kind: 'text', text: t.text ?? '' });
        break;
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        out.push({ kind: 'strong', children: inlineFromTokens(t.tokens) });
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        out.push({ kind: 'em', children: inlineFromTokens(t.tokens) });
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        out.push({ kind: 'codespan', text: t.text ?? '' });
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        out.push({
          kind: 'link',
          href: t.href ?? '',
          title: t.title || undefined,
          children: inlineFromTokens(t.tokens),
        });
        break;
      }
      case 'br':
        out.push({ kind: 'br' });
        break;
      case 'del': {
        const t = token as Tokens.Del;
        out.push({ kind: 'del', children: inlineFromTokens(t.tokens) });
        break;
      }
      case 'html': {
        // Strip raw HTML for RN — Cap sanitizes; we drop tags and keep nothing dangerous.
        const t = token as Tokens.HTML;
        const stripped = (t.text ?? t.raw ?? '').replace(/<[^>]+>/g, '');
        if (stripped) out.push({ kind: 'text', text: stripped });
        break;
      }
      case 'image': {
        const t = token as Tokens.Image;
        out.push({ kind: 'text', text: t.text || t.href || '[image]' });
        break;
      }
      default: {
        const anyTok = token as { text?: string; raw?: string; tokens?: Token[] };
        if (anyTok.tokens) {
          out.push(...inlineFromTokens(anyTok.tokens));
        } else if (typeof anyTok.text === 'string') {
          out.push({ kind: 'text', text: anyTok.text });
        } else if (typeof anyTok.raw === 'string') {
          out.push({ kind: 'text', text: anyTok.raw });
        }
        break;
      }
    }
  }
  return out;
};

const listItemInlines = (item: Tokens.ListItem): ChatMarkdownInline[] => {
  // List items nest block tokens; flatten paragraph/text content for compact RN bubbles.
  const children = item.tokens ?? [];
  const inlines: ChatMarkdownInline[] = [];
  for (const child of children) {
    if (child.type === 'paragraph' || child.type === 'text') {
      const t = child as Tokens.Paragraph | Tokens.Text;
      inlines.push(...inlineFromTokens(t.tokens ?? [{ type: 'text', raw: t.text ?? '', text: t.text ?? '' } as Tokens.Text]));
    } else if (child.type === 'space') {
      inlines.push({ kind: 'text', text: ' ' });
    } else {
      const anyTok = child as { tokens?: Token[]; text?: string; raw?: string };
      if (anyTok.tokens) inlines.push(...inlineFromTokens(anyTok.tokens));
      else if (anyTok.text) inlines.push({ kind: 'text', text: anyTok.text });
      else if (anyTok.raw) inlines.push({ kind: 'text', text: anyTok.raw });
    }
  }
  return inlines;
};

const blockFromToken = (token: Token): ChatMarkdownBlock | null => {
  switch (token.type) {
    case 'space':
      return { kind: 'space' };
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return { kind: 'paragraph', children: inlineFromTokens(t.tokens) };
    }
    case 'heading': {
      const t = token as Tokens.Heading;
      return {
        kind: 'heading',
        depth: Math.min(6, Math.max(1, t.depth ?? 1)),
        children: inlineFromTokens(t.tokens),
      };
    }
    case 'code': {
      const t = token as Tokens.Code;
      return { kind: 'code', lang: t.lang ?? null, text: t.text ?? '' };
    }
    case 'list': {
      const t = token as Tokens.List;
      return {
        kind: 'list',
        ordered: Boolean(t.ordered),
        start: typeof t.start === 'number' ? t.start : 1,
        items: (t.items ?? []).map(listItemInlines),
      };
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const children: ChatMarkdownBlock[] = [];
      for (const child of t.tokens ?? []) {
        const b = blockFromToken(child);
        if (b) children.push(b);
      }
      return { kind: 'blockquote', children };
    }
    case 'hr':
      return { kind: 'hr' };
    case 'html': {
      const t = token as Tokens.HTML;
      const stripped = (t.text ?? t.raw ?? '').replace(/<[^>]+>/g, '').trim();
      return stripped ? { kind: 'plain', text: stripped } : null;
    }
    case 'text': {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        return { kind: 'paragraph', children: inlineFromTokens(t.tokens) };
      }
      return { kind: 'plain', text: t.text ?? t.raw ?? '' };
    }
    default: {
      const anyTok = token as { raw?: string; text?: string };
      const fallback = anyTok.text ?? anyTok.raw;
      return fallback ? { kind: 'plain', text: fallback } : null;
    }
  }
};

/**
 * Lex markdown with Cap marked options. Never throws — falls back to plain text.
 */
export const parseChatMarkdown = (source: string): ChatMarkdownDoc => {
  try {
    if (!source) return { blocks: [] };
    const tokens = marked.lexer(source, CAP_MARKED_OPTIONS) as Token[];
    const blocks: ChatMarkdownBlock[] = [];
    for (const token of tokens) {
      const block = blockFromToken(token);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0 && source.trim()) {
      return { blocks: [{ kind: 'plain', text: source }] };
    }
    return { blocks };
  } catch {
    return { blocks: [{ kind: 'plain', text: source }] };
  }
};

/** Flatten inlines to plain string (tests / a11y). */
export const flattenInlineText = (nodes: ChatMarkdownInline[]): string =>
  nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'codespan':
          return n.text;
        case 'br':
          return '\n';
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return flattenInlineText(n.children);
        default:
          return '';
      }
    })
    .join('');
