import type { ComposerAutocompleteListRow, ComposerAutocompleteVisibleRows } from './types';

export const composerAutocompleteRowsEqual = (
  left: readonly ComposerAutocompleteListRow[],
  right: readonly ComposerAutocompleteListRow[],
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return other != null
      && row.id === other.id
      && row.title === other.title
      && (row.subtitle ?? '') === (other.subtitle ?? '')
      && (row.badge ?? '') === (other.badge ?? '')
      && row.iconName === other.iconName;
  });
};

export const composerAutocompleteVisibleRowsEqual = (
  left: ComposerAutocompleteVisibleRows,
  right: ComposerAutocompleteVisibleRows,
): boolean => (
  left.highlightedIndex === right.highlightedIndex
  && composerAutocompleteRowsEqual(left.rows, right.rows)
);

export const commitComposerAutocompleteRows = (
  previous: ComposerAutocompleteListRow[],
  next: readonly ComposerAutocompleteListRow[],
): ComposerAutocompleteListRow[] => (
  composerAutocompleteRowsEqual(previous, next) ? previous : next.slice()
);

export const emitComposerAutocompleteRows = (
  onRowsChange: ((payload: ComposerAutocompleteVisibleRows) => void) | undefined,
  last: { current: ComposerAutocompleteVisibleRows | null },
  next: ComposerAutocompleteVisibleRows,
): void => {
  if (!onRowsChange) return;
  if (last.current && composerAutocompleteVisibleRowsEqual(last.current, next)) return;
  last.current = next;
  onRowsChange(next);
};

export const resetComposerAutocompleteRows = (
  onRowsChange: ((payload: ComposerAutocompleteVisibleRows) => void) | undefined,
  last: { current: ComposerAutocompleteVisibleRows | null },
): void => {
  last.current = null;
  onRowsChange?.({ rows: [], highlightedIndex: 0 });
};
