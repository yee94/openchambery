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

/** Preview-safe turn diff row (summary stats) and optional full body fields. */
export type TurnDiffEntry = {
  file?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  before?: string;
  after?: string;
};

const hasTurnDiffBody = (diff: TurnDiffEntry): boolean => {
  if (typeof diff.patch === 'string' && diff.patch.length > 0) return true;
  if (typeof diff.before === 'string' && diff.before.length > 0) return true;
  if (typeof diff.after === 'string' && diff.after.length > 0) return true;
  return false;
};

/** True when any summary row still needs a full patch/before/after body. */
export const turnDiffSummariesNeedFullBody = (summaries: readonly TurnDiffEntry[]): boolean => {
  for (const summary of summaries) {
    if (!summary.file?.trim()) continue;
    if (!hasTurnDiffBody(summary)) return true;
  }
  return false;
};

/**
 * Merge summary-only turn diffs with on-demand full session.diff rows.
 * Prefers full patch/before/after; keeps summary additions/deletions/status.
 * Summary order and paths are preserved; unknown full-only paths are ignored.
 */
export const mergeTurnDiffSummariesWithFull = (
  summaries: readonly TurnDiffEntry[],
  fullDiffs: readonly TurnDiffEntry[],
): TurnDiffEntry[] => {
  if (summaries.length === 0) return [];
  if (fullDiffs.length === 0) return summaries.slice();

  const fullByPath = new Map<string, TurnDiffEntry>();
  for (const full of fullDiffs) {
    const path = full.file?.trim();
    if (!path) continue;
    fullByPath.set(path, full);
  }

  return summaries.map((summary) => {
    const path = summary.file?.trim();
    if (!path) return summary;
    const full = fullByPath.get(path);
    if (!full) return summary;

    return {
      ...summary,
      patch: typeof full.patch === 'string' ? full.patch : summary.patch,
      before: typeof full.before === 'string' ? full.before : summary.before,
      after: typeof full.after === 'string' ? full.after : summary.after,
      additions: summary.additions ?? full.additions,
      deletions: summary.deletions ?? full.deletions,
      status: summary.status ?? full.status,
    };
  });
};
