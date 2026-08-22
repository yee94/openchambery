export const getFirstChangedModifiedLineFromPatch = (patch: string): number | null => {
  if (!patch) {
    return null;
  }

  const lines = patch.split('\n');
  let modifiedLine: number | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (hunkMatch) {
      const parsed = Number.parseInt(hunkMatch[1] ?? '', 10);
      modifiedLine = Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
      continue;
    }

    if (modifiedLine === null) {
      continue;
    }

    if (line.startsWith(' ')) {
      modifiedLine += 1;
      continue;
    }

    if (line.startsWith('+')) {
      return modifiedLine;
    }

    if (line.startsWith('-')) {
      return Math.max(1, modifiedLine);
    }
  }

  return null;
};

export type ToolPatchFile = {
  path: string;
  patch: string;
};

type ToolPatchTurnDiff = {
  file: string;
  patch: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
};

export const createToolPatchTurnDiffs = (files: readonly ToolPatchFile[]): ToolPatchTurnDiff[] => {
  const result: ToolPatchTurnDiff[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const path = file.path.trim();
    const patch = file.patch;
    if (!path || !patch.trim() || seen.has(path)) {
      continue;
    }

    seen.add(path);
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) additions += 1;
      if (line.startsWith('-')) deletions += 1;
    }

    const status = /^---\s+\/dev\/null(?:\s|$)/m.test(patch)
      ? 'added'
      : /^\+\+\+\s+\/dev\/null(?:\s|$)/m.test(patch)
        ? 'deleted'
        : 'modified';

    result.push({ file: path, patch, status, additions, deletions });
  }

  return result;
};
