import { describe, expect, it } from 'vitest';

import {
  flattenInlineText,
  isSafeMarkdownHref,
  parseChatMarkdown,
} from '@/lib/chatMarkdownModel';

describe('chatMarkdownModel (Cap marked parity)', () => {
  it('parses headings, emphasis, lists, fences, links, inline code', () => {
    const src = [
      '# Title',
      '',
      'Hello **bold** and *italic* plus `code`.',
      '',
      '- one',
      '- two',
      '',
      '1. alpha',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'See [docs](https://example.com/path).',
    ].join('\n');

    const doc = parseChatMarkdown(src);
    const kinds = doc.blocks.map((b) => b.kind).filter((k) => k !== 'space');
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('list');
    expect(kinds).toContain('code');

    const heading = doc.blocks.find((b) => b.kind === 'heading');
    expect(heading?.kind === 'heading' && heading.depth).toBe(1);
    expect(heading?.kind === 'heading' && flattenInlineText(heading.children)).toBe('Title');

    const para = doc.blocks.find((b) => b.kind === 'paragraph');
    expect(para?.kind).toBe('paragraph');
    if (para?.kind === 'paragraph') {
      const kindsInline = para.children.map((c) => c.kind);
      expect(kindsInline).toContain('strong');
      expect(kindsInline).toContain('em');
      expect(kindsInline).toContain('codespan');
    }

    const code = doc.blocks.find((b) => b.kind === 'code');
    expect(code?.kind === 'code' && code.lang).toBe('ts');
    expect(code?.kind === 'code' && code.text).toContain('const x = 1');

    const withLink = doc.blocks.find(
      (b) => b.kind === 'paragraph' && b.children.some((c) => c.kind === 'link'),
    );
    expect(withLink?.kind).toBe('paragraph');
    if (withLink?.kind === 'paragraph') {
      const link = withLink.children.find((c) => c.kind === 'link');
      expect(link?.kind === 'link' && link.href).toBe('https://example.com/path');
    }
  });

  it('uses Cap marked options (gfm on, breaks off)', () => {
    // Single newline should NOT become a hard break when breaks:false
    const doc = parseChatMarkdown('line one\nline two');
    const para = doc.blocks.find((b) => b.kind === 'paragraph');
    expect(para?.kind).toBe('paragraph');
    if (para?.kind === 'paragraph') {
      expect(para.children.some((c) => c.kind === 'br')).toBe(false);
      expect(flattenInlineText(para.children)).toContain('line one');
      expect(flattenInlineText(para.children)).toContain('line two');
    }
  });

  it('never throws on empty / garbage and falls back', () => {
    expect(parseChatMarkdown('').blocks).toEqual([]);
    expect(() => parseChatMarkdown('```\nunclosed')).not.toThrow();
    const junk = parseChatMarkdown('\u0000');
    expect(Array.isArray(junk.blocks)).toBe(true);
  });

  it('gates unsafe hrefs like Cap external-link policy', () => {
    expect(isSafeMarkdownHref('https://ok.example')).toBe(true);
    expect(isSafeMarkdownHref('http://ok.example')).toBe(true);
    expect(isSafeMarkdownHref('mailto:a@b.c')).toBe(true);
    expect(isSafeMarkdownHref('tel:+123')).toBe(true);
    expect(isSafeMarkdownHref('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownHref('file:///etc/passwd')).toBe(false);
    expect(isSafeMarkdownHref('#anchor')).toBe(false);
    expect(isSafeMarkdownHref('/relative')).toBe(false);
  });
});
