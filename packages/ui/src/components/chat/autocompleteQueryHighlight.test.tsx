import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  AUTOCOMPLETE_QUERY_HIGHLIGHT_CLASS,
  highlightAutocompleteQuery,
} from './autocompleteQueryHighlight';

describe('highlightAutocompleteQuery', () => {
  test('wraps case-insensitive matches without adding weight', () => {
    const html = renderToStaticMarkup(<>{highlightAutocompleteQuery('Review the review', 'rev')}</>);
    expect(html).toContain('<mark');
    expect(html.match(/<mark/g)?.length).toBe(2);
    expect(html).toContain(AUTOCOMPLETE_QUERY_HIGHLIGHT_CLASS);
    expect(html).not.toContain('font-semibold');
    expect(html).not.toContain('font-bold');
    expect(html).toContain('font-[inherit]');
  });

  test('returns the original string when nothing matches', () => {
    expect(highlightAutocompleteQuery('alpha', 'beta')).toBe('alpha');
    expect(highlightAutocompleteQuery('alpha', '  ')).toBe('alpha');
  });
});
