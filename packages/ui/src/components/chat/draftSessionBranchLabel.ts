/**
 * Resolve the draft branch chip label from known project-root / worktree options.
 *
 * Never falls back to a directory basename — that painted the project folder name
 * on the branch chip (e.g. "openchamber-yee" instead of "main") and blocked the
 * live git current-branch query inside DraftSessionBranchSelector.
 */
export function resolveDraftSessionBranchLabel(input: {
  selectedDirectory: string | null;
  projectRootOption: { value: string; label: string } | null;
  worktreeOptions: Array<{ value: string; label: string }>;
}): string | null {
  const selectedValue =
    input.selectedDirectory
    ?? input.projectRootOption?.value
    ?? input.worktreeOptions[0]?.value
    ?? null;
  if (!selectedValue) {
    return null;
  }
  if (input.projectRootOption?.value === selectedValue) {
    const label = input.projectRootOption.label?.trim();
    return label || null;
  }
  const worktree = input.worktreeOptions.find((option) => option.value === selectedValue);
  const worktreeLabel = worktree?.label?.trim();
  return worktreeLabel || null;
}

/**
 * True when a parent-supplied chip label is just the directory basename, which
 * is never a meaningful branch name for display.
 */
export function isDirectoryBasenameLabel(
  label: string | null | undefined,
  directory: string | null | undefined,
): boolean {
  if (!label || !directory) {
    return false;
  }
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) {
    return false;
  }
  const baseName = normalized === '/' ? '/' : (normalized.split('/').pop() || '');
  return Boolean(baseName) && label === baseName;
}
