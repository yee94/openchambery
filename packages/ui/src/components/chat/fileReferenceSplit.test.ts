import { describe, expect, test } from 'vitest';
import { splitParagraphPathTokens } from './fileReferenceSplit';

describe('splitParagraphPathTokens', () => {
  test('wraps a bare absolute path in ordinary prose', () => {
    expect(splitParagraphPathTokens('see /tmp/report.html please')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'path', value: '/tmp/report.html' },
      { kind: 'text', value: ' please' },
    ]);
  });

  test('keeps http(s) URLs as ordinary text', () => {
    expect(splitParagraphPathTokens('docs at https://example.com/foo.ts')).toEqual([
      { kind: 'text', value: 'docs at https://example.com/foo.ts' },
    ]);
  });

  test('does not treat a sentence without a slash as a path', () => {
    expect(splitParagraphPathTokens('the value is 56.312')).toEqual([
      { kind: 'text', value: 'the value is 56.312' },
    ]);
  });

  test('splits multiple absolute paths in one paragraph', () => {
    const segments = splitParagraphPathTokens('wrote /tmp/a.png and /Users/dev/notes.md');
    expect(segments.filter((segment) => segment.kind === 'path').map((segment) => segment.value)).toEqual([
      '/tmp/a.png',
      '/Users/dev/notes.md',
    ]);
  });
});
