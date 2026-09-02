import { describe, expect, test, vi } from 'vitest';

import {
  commitComposerAutocompleteRows,
  composerAutocompleteRowsEqual,
  emitComposerAutocompleteRows,
} from './visible-rows';
import type { ComposerAutocompleteListRow, ComposerAutocompleteVisibleRows } from './types';

const row = (id: string): ComposerAutocompleteListRow => ({
  id,
  title: `/${id}`,
  iconName: 'command',
});

describe('composer autocomplete visible rows', () => {
  test('treats copied rows with the same fields as equal', () => {
    expect(composerAutocompleteRowsEqual([row('undo')], [{ ...row('undo') }])).toBe(true);
    expect(composerAutocompleteRowsEqual([row('undo')], [row('redo')])).toBe(false);
  });

  test('commit keeps the previous reference when content matches', () => {
    const previous = [row('undo')];
    expect(commitComposerAutocompleteRows(previous, [{ ...row('undo') }])).toBe(previous);
    expect(commitComposerAutocompleteRows(previous, [row('redo')])).toEqual([row('redo')]);
  });

  test('emit skips a parent update when the visible payload did not change', () => {
    const onRowsChange = vi.fn();
    const last: { current: ComposerAutocompleteVisibleRows | null } = { current: null };
    const payload = { rows: [row('undo')], highlightedIndex: 0 };
    emitComposerAutocompleteRows(onRowsChange, last, payload);
    emitComposerAutocompleteRows(onRowsChange, last, { rows: [{ ...row('undo') }], highlightedIndex: 0 });
    expect(onRowsChange).toHaveBeenCalledTimes(1);
  });
});
