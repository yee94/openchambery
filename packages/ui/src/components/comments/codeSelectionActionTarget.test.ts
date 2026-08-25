import { describe, expect, test } from 'vitest';

import {
  shouldDismissDiffSelectionAction,
  shouldShowDiffSelectionActionFromPointerUp,
} from './codeSelectionActionTarget';

describe('shouldDismissDiffSelectionAction', () => {
  test('keeps the bubble when the event is inside it', () => {
    const root = document.createElement('div');
    root.setAttribute('data-code-selection-action', 'true');
    const button = document.createElement('button');
    root.append(button);

    expect(shouldDismissDiffSelectionAction(button, [button, root])).toBe(false);
  });

  test('keeps the bubble when a line-number click will replace the selection', () => {
    const numberCell = document.createElement('span');
    numberCell.setAttribute('data-column-number', '308');
    const label = document.createElement('span');
    numberCell.append(label);

    expect(shouldDismissDiffSelectionAction(numberCell, [numberCell])).toBe(false);
    expect(shouldDismissDiffSelectionAction(label, [label, numberCell])).toBe(false);
  });

  test('dismisses when clicking elsewhere, including empty space inside the diff', () => {
    const codeLine = document.createElement('span');
    codeLine.setAttribute('data-line', '314');

    expect(shouldDismissDiffSelectionAction(codeLine, [codeLine])).toBe(true);
    expect(shouldDismissDiffSelectionAction(document.createElement('div'))).toBe(true);
    expect(shouldDismissDiffSelectionAction(null)).toBe(true);
  });
});

describe('shouldShowDiffSelectionActionFromPointerUp', () => {
  test('does not resurrect the bubble from leftover text after a blur click', () => {
    expect(shouldShowDiffSelectionActionFromPointerUp(false, 'const session = await createSession({')).toBe(false);
  });

  test('shows the bubble only after a real text-selection gesture', () => {
    expect(shouldShowDiffSelectionActionFromPointerUp(true, 'const session = await createSession({')).toBe(true);
    expect(shouldShowDiffSelectionActionFromPointerUp(true, '   ')).toBe(false);
    expect(shouldShowDiffSelectionActionFromPointerUp(true, null)).toBe(false);
  });
});
