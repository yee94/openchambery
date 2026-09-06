import { describe, expect, it } from 'vitest';

import { highlightTextSegments } from '@/lib/highlightText';

describe('highlightTextSegments', () => {
  it('splits case-insensitive keyword matches', () => {
    expect(highlightTextSegments('Fix Mobile Search', 'mobile')).toEqual([
      { text: 'Fix ', highlighted: false },
      { text: 'Mobile', highlighted: true },
      { text: ' Search', highlighted: false },
    ]);
  });

  it('returns a single non-highlight segment for empty query', () => {
    expect(highlightTextSegments('abc', '  ')).toEqual([{ text: 'abc', highlighted: false }]);
  });
});
