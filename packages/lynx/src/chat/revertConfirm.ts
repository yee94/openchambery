/**
 * Cap ChangesPanel revert confirm — Cap DialogTitle / Description / Cancel /
 * destructive Revert. Cap confirms revert-all + directory; Lynx flat Changes
 * sheet uses the same **centered Dialog** (scrim + panel) for per-file revert —
 * not an elevated-in-sheet card and not MobileResizableSheet. Cap does **not**
 * confirm commit&push — do not add that here.
 */

export type LynxRevertConfirmRequest = {
  path: string;
};

export type LynxRevertConfirmDecision = 'cancel' | 'confirm';

export const requestLynxRevertConfirm = (path: string): LynxRevertConfirmRequest | null => {
  const trimmed = path.trim();
  if (!trimmed) return null;
  return { path: trimmed };
};

export const resolveLynxRevertConfirm = (
  pending: LynxRevertConfirmRequest | null,
  decision: LynxRevertConfirmDecision,
): { pending: null; shouldRevert: boolean; path: string | null } => {
  if (!pending) {
    return { pending: null, shouldRevert: false, path: null };
  }
  if (decision === 'confirm') {
    return { pending: null, shouldRevert: true, path: pending.path };
  }
  return { pending: null, shouldRevert: false, path: null };
};
