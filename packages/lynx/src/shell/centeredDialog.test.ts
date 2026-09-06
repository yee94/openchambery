import { describe, expect, test } from 'vitest';

import {
  LYNX_CENTERED_DIALOG,
  LYNX_CENTERED_DIALOG_MAX_WIDTH_PX,
  LYNX_CENTERED_DIALOG_NOTES,
  LYNX_CENTERED_DIALOG_SCRIM,
  shouldAllowLynxCenteredDialogDismiss,
} from './centeredDialog';

describe('Lynx Cap centered Dialog spirit', () => {
  test('is centered modal, not bottom sheet or elevated-in-sheet card', () => {
    expect(LYNX_CENTERED_DIALOG.placement).toBe('centered-modal');
    expect(LYNX_CENTERED_DIALOG.bottomSheet).toBe(false);
    expect(LYNX_CENTERED_DIALOG.elevatedInSheetCard).toBe(false);
    expect(LYNX_CENTERED_DIALOG.insideGlassContentView).toBe(false);
    expect(LYNX_CENTERED_DIALOG.dismissOnScrim).toBe(true);
    expect(LYNX_CENTERED_DIALOG.maxWidthPx).toBe(LYNX_CENTERED_DIALOG_MAX_WIDTH_PX);
    expect(LYNX_CENTERED_DIALOG.maxWidthPx).toBe(448);
    expect(LYNX_CENTERED_DIALOG.scrim).toBe(LYNX_CENTERED_DIALOG_SCRIM);
    expect(LYNX_CENTERED_DIALOG.zIndex).toBe(50);
  });

  test('Cap busy blocks dismiss (revert-all isRevertingAll spirit)', () => {
    expect(shouldAllowLynxCenteredDialogDismiss(false)).toBe(true);
    expect(shouldAllowLynxCenteredDialogDismiss(true)).toBe(false);
  });

  test('notes call out Dialog vs half-sheet vs elevated card', () => {
    const joined = LYNX_CENTERED_DIALOG_NOTES.join(' ');
    expect(joined).toMatch(/scrim/i);
    expect(joined).toMatch(/centered/i);
    expect(joined).toMatch(/not half-sheet/i);
    expect(joined).toMatch(/elevated-in-scroll/i);
    expect(joined).toMatch(/NOT DONE/);
  });
});
