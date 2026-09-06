/**
 * Cap PierreDiffViewer — Lynx portable text presentation (not Pierre runtime).
 *
 * Cap Changes sheet mounts `@/components/views/PierreDiffViewer` (`@pierre/diffs`
 * + PIERRE_RUNTIME_BASE_CSS). Lynx already loads real `/api/git/file-diff` +
 * `/api/git/diff` text. This module parses unified diff into line kinds + stats
 * for monospace colored text — **no** invented Pierre CSS / DOM iframe / worker.
 *
 * Source: packages/ui/src/apps/MobileChangesSurface.tsx
 */

export type LynxPierreDiffLineKind =
  | 'add'
  | 'del'
  | 'context'
  | 'hunk'
  | 'meta'
  | 'empty';

export type LynxPierreDiffLine = {
  kind: LynxPierreDiffLineKind;
  text: string;
};

export type LynxPierreDiffStats = {
  insertions: number;
  deletions: number;
};

export type LynxPierreDiffPlan = {
  /** Real file/turn diff text is available from Cap APIs. */
  hasTextPreview: boolean;
  /** PierreDiff interactive viewer — Cap `@pierre/diffs` not ported. */
  pierreViewer: 'stub';
  /** Portable Lynx presentation of Cap git text (not Pierre chrome). */
  presentation: 'portable-text' | 'none';
  note: string;
  lines: LynxPierreDiffLine[];
  stats: LynxPierreDiffStats;
};

/** Cap-style unified-diff line classification (JS-portable; no Pierre). */
export const parseLynxUnifiedDiffLines = (unifiedDiff: string | null | undefined): LynxPierreDiffLine[] => {
  const raw = unifiedDiff ?? '';
  if (!raw.length) return [];
  return raw.split('\n').map((text) => {
    if (text.length === 0) return { kind: 'empty' as const, text };
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) {
      return { kind: 'meta' as const, text };
    }
    if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
    if (text.startsWith('+')) return { kind: 'add' as const, text };
    if (text.startsWith('-')) return { kind: 'del' as const, text };
    return { kind: 'context' as const, text };
  });
};

export const summarizeLynxDiffStats = (lines: readonly LynxPierreDiffLine[]): LynxPierreDiffStats => {
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === 'add') insertions += 1;
    else if (line.kind === 'del') deletions += 1;
  }
  return { insertions, deletions };
};

/**
 * Build original+modified portable preview when unified is missing but Cap
 * file-diff returned both sides (MobileChangesSurface spirit).
 */
export const buildLynxOriginalModifiedPreview = (
  path: string,
  original: string | null | undefined,
  modified: string | null | undefined,
): string => {
  const file = path.trim() || 'file';
  const before = (original ?? '').split('\n');
  const after = (modified ?? '').split('\n');
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ preview @@',
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n');
};

export const planLynxPierreDiff = (input?: {
  unifiedDiff?: string | null;
  original?: string | null;
  modified?: string | null;
  binary?: boolean;
  path?: string | null;
}): LynxPierreDiffPlan => {
  if (input?.binary) {
    return {
      hasTextPreview: false,
      pierreViewer: 'stub',
      presentation: 'none',
      note: 'Binary file — no PierreDiff / text preview.',
      lines: [],
      stats: { insertions: 0, deletions: 0 },
    };
  }

  let unified = input?.unifiedDiff?.trim() ? input.unifiedDiff : null;
  if (!unified && (input?.original?.length || input?.modified?.length)) {
    unified = buildLynxOriginalModifiedPreview(
      input?.path ?? 'file',
      input?.original,
      input?.modified,
    );
  }

  const lines = parseLynxUnifiedDiffLines(unified);
  const stats = summarizeLynxDiffStats(lines);
  const hasText = lines.length > 0;

  return {
    hasTextPreview: hasText,
    pierreViewer: 'stub',
    presentation: hasText ? 'portable-text' : 'none',
    note: hasText
      ? 'Portable text diff (line kinds + stats). Cap PierreDiffViewer / @pierre/diffs not ported.'
      : 'No diff text yet. PierreDiff viewer stub — Cap @pierre/diffs not wired in Lynx.',
    lines,
    stats,
  };
};

export const LYNX_PIERRE_DIFF_STUB_NOTES = [
  'Cap PierreDiffViewer + PIERRE_RUNTIME_BASE_CSS are web components — not claimed in Lynx.',
  'Lynx Changes sheet keeps real git file-diff / diff API text; portable line/stats presentation is JS-only.',
  'Do not invent a Lynx Pierre CSS runtime or DOM iframe.',
] as const;

/**
 * Cap-like portable line colors (ChangeRow A/D spirit) — not Pierre CSS.
 * add → status.success (green); del → status.error (red); hunk/meta stay muted
 * so deletions are distinguishable from hunk headers.
 */
export const lynxPierreDiffLineToken = (
  kind: LynxPierreDiffLineKind,
): 'status.success' | 'status.error' | 'surface.mutedForeground' | 'surface.foreground' => {
  switch (kind) {
    case 'add':
      return 'status.success';
    case 'del':
      return 'status.error';
    case 'hunk':
    case 'meta':
    case 'empty':
      return 'surface.mutedForeground';
    case 'context':
    default:
      return 'surface.foreground';
  }
};
