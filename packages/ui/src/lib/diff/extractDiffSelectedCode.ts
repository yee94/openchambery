import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';

/**
 * Extract selected line text from a Pierre diff selection.
 *
 * For partial (patch) diffs, `SelectedLineRange` uses file line numbers while
 * `additionLines` / `deletionLines` only contain hunk-covered lines — map via hunks.
 * For full-file diffs, treat range as 1-based indexes into those arrays.
 * Without `fileDiff`, fall back to splitting `original` / `modified`.
 */
export function extractDiffSelectedCode(
  original: string,
  modified: string,
  fileDiff: FileDiffMetadata | undefined,
  range: SelectedLineRange,
): string {
  // Default to additions/modified when side is ambiguous (users mostly select new code)
  const isDeletions = range.side === 'deletions';
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);

  if (!fileDiff) {
    const content = isDeletions ? original : modified;
    const lines = content.split('\n');
    const startLine = Math.max(1, from);
    const endLine = Math.min(lines.length, to);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  const sourceLines = isDeletions ? fileDiff.deletionLines : fileDiff.additionLines;
  const selected: string[] = [];

  for (let fileLine = from; fileLine <= to; fileLine += 1) {
    const index = fileDiff.isPartial
      ? mapPartialFileLineToIndex(fileDiff, fileLine, isDeletions)
      : fileLine - 1;

    if (index === null || index < 0 || index >= sourceLines.length) continue;

    const entry = sourceLines[index] ?? '';
    selected.push(entry.endsWith('\n') ? entry.slice(0, -1) : entry);
  }

  return selected.join('\n');
}

function mapPartialFileLineToIndex(
  fileDiff: FileDiffMetadata,
  fileLine: number,
  isDeletions: boolean,
): number | null {
  for (const hunk of fileDiff.hunks) {
    if (isDeletions) {
      if (fileLine >= hunk.deletionStart && fileLine < hunk.deletionStart + hunk.deletionCount) {
        return hunk.deletionLineIndex + (fileLine - hunk.deletionStart);
      }
    } else if (fileLine >= hunk.additionStart && fileLine < hunk.additionStart + hunk.additionCount) {
      return hunk.additionLineIndex + (fileLine - hunk.additionStart);
    }
  }
  return null;
}
