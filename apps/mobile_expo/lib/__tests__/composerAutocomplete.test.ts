import { describe, expect, it } from 'vitest';

import {
  acceptComposerAutocompleteRow,
  filterRowsByQuery,
  resolveComposerAutocompleteReplaceRange,
  resolveComposerAutocompleteTrigger,
} from '@/lib/composerAutocomplete';

describe('composerAutocomplete triggers', () => {
  it('opens leading slash-command before first space', () => {
    expect(resolveComposerAutocompleteTrigger('/un', 3)).toEqual({
      kind: 'slash-command',
      query: 'un',
      tokenStart: 0,
      tokenEnd: 3,
    });
  });

  it('opens mid-line slash skills on word boundary', () => {
    expect(resolveComposerAutocompleteTrigger('please /rev', 11)).toEqual({
      kind: 'slash-skill',
      query: 'rev',
      tokenStart: 7,
      tokenEnd: 11,
    });
  });

  it('opens # snippet and @ mention', () => {
    expect(resolveComposerAutocompleteTrigger('see #foo', 8)?.kind).toBe('snippet');
    expect(resolveComposerAutocompleteTrigger('hi @src', 7)).toEqual({
      kind: 'mention',
      query: 'src',
      tokenStart: 3,
      tokenEnd: 7,
    });
  });

  it('does not open skill mid-word', () => {
    expect(resolveComposerAutocompleteTrigger('http://x', 8)).toBeNull();
  });

  it('accepts suggestion using open trigger even with stale caret', () => {
    const text = 'see @src';
    const trigger = resolveComposerAutocompleteTrigger(text, 8);
    expect(resolveComposerAutocompleteReplaceRange(text, 0, trigger)).toEqual({
      start: 4,
      end: 8,
    });
    const accepted = acceptComposerAutocompleteRow(text, 0, trigger, '@src/foo.ts');
    expect(accepted?.text).toBe('see @src/foo.ts ');
    expect(accepted?.caret).toBe(16);
  });

  it('filters rows by query', () => {
    const rows = filterRowsByQuery(
      [
        { title: '/undo', subtitle: 'Undo' },
        { title: '/help', subtitle: 'Help' },
        { title: '/review', subtitle: 'Review' },
      ],
      're',
    );
    expect(rows.map((row) => row.title)).toEqual(['/review']);
  });
});
