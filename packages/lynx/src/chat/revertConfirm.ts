/**
 * Cap ChangesPanel revert confirm — Cap DialogTitle / Description / Cancel /
 * destructive Revert. Cap confirms revert-all + directory; Lynx flat Changes
 * sheet uses the same **centered Dialog** (scrim + panel) for per-file and
 * revert-all — not an elevated-in-sheet card and not MobileResizableSheet.
 * Cap does **not** confirm commit&push — do not add that here.
 */

export type LynxRevertConfirmRequest = {
  /** First path (single-file label / back-compat). */
  path: string;
  /** Cap revert-all paths (deduped). Always ≥1 when request is non-null. */
  paths: readonly string[];
};

export type LynxRevertConfirmDecision = 'cancel' | 'confirm';

const cleanPaths = (input: readonly string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

/**
 * Cap single-file or revert-all confirm request.
 * Empty / whitespace-only paths → null (do not open dialog).
 */
export const requestLynxRevertConfirm = (
  pathOrPaths: string | readonly string[],
): LynxRevertConfirmRequest | null => {
  const paths = cleanPaths(typeof pathOrPaths === 'string' ? [pathOrPaths] : pathOrPaths);
  if (paths.length === 0) return null;
  return { path: paths[0]!, paths };
};

export const resolveLynxRevertConfirm = (
  pending: LynxRevertConfirmRequest | null,
  decision: LynxRevertConfirmDecision,
): {
  pending: null;
  shouldRevert: boolean;
  path: string | null;
  paths: readonly string[] | null;
} => {
  if (!pending) {
    return { pending: null, shouldRevert: false, path: null, paths: null };
  }
  if (decision === 'confirm') {
    return {
      pending: null,
      shouldRevert: true,
      path: pending.path,
      paths: pending.paths,
    };
  }
  return { pending: null, shouldRevert: false, path: null, paths: null };
};
