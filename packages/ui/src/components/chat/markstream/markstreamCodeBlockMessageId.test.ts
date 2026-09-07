import { describe, expect, test } from 'vitest';
import { markstreamCodeBlockMessageId } from './markstreamCodeBlockMessageId';

describe('markstreamCodeBlockMessageId', () => {
  test('encodes part id so two parts of the same message do not share a cache slot', () => {
    const a = markstreamCodeBlockMessageId({
      messageId: 'msg-1',
      partId: 'part-a',
      indexKey: 'markdown-renderer-0',
      language: 'typescript',
    });
    const b = markstreamCodeBlockMessageId({
      messageId: 'msg-1',
      partId: 'part-b',
      indexKey: 'markdown-renderer-0',
      language: 'typescript',
    });
    expect(a).not.toBe(b);
    expect(a).toContain('part-part-a');
    expect(b).toContain('part-part-b');
  });

  test('prefers Markstream indexKey over language so same-lang blocks stay distinct', () => {
    const first = markstreamCodeBlockMessageId({
      messageId: 'msg-1',
      partId: 'part-a',
      indexKey: 'markdown-renderer-1',
      language: 'typescript',
    });
    const second = markstreamCodeBlockMessageId({
      messageId: 'msg-1',
      partId: 'part-a',
      indexKey: 'markdown-renderer-3',
      language: 'typescript',
    });
    expect(first).not.toBe(second);
    expect(first).toContain('markdown-renderer-1');
    expect(second).toContain('markdown-renderer-3');
  });

  test('falls back to language then code when indexKey is absent', () => {
    expect(markstreamCodeBlockMessageId({
      messageId: 'msg-1',
      language: 'go',
    })).toBe('msg-1:body:code:go');
    expect(markstreamCodeBlockMessageId({
      messageId: 'msg-1',
    })).toBe('msg-1:body:code:code');
  });
});
