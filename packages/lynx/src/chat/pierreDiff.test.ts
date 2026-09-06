import { describe, expect, test } from 'vitest';

import {
  LYNX_CHANGE_ROW_SPACING,
  LYNX_PIERRE_DIFF_BLOCKERS,
  buildLynxOriginalModifiedPreview,
  lynxChangeStatusCode,
  lynxChangeStatusToken,
  lynxPierreDiffLineToken,
  parseLynxUnifiedDiffLines,
  planLynxPierreDiff,
  resolveLynxPierreDiffFeature,
  summarizeLynxDiffStats,
} from './pierreDiff';

describe('Lynx PierreDiff portable text', () => {
  test('binary has no text preview; pierre unavailable', () => {
    const plan = planLynxPierreDiff({ binary: true, preferPierre: true });
    expect(plan.hasTextPreview).toBe(false);
    expect(plan.pierreViewer).toBe('unavailable');
    expect(plan.presentation).toBe('none');
    expect(plan.lines).toEqual([]);
  });

  test('unified diff → portable lines + stats (Pierre unavailable)', () => {
    const plan = planLynxPierreDiff({
      unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n context\n',
      preferPierre: true,
    });
    expect(plan.hasTextPreview).toBe(true);
    expect(plan.pierreViewer).toBe('unavailable');
    expect(plan.presentation).toBe('portable-text');
    expect(plan.note).toMatch(/portable|Pierre|@pierre/i);
    expect(plan.stats).toEqual({ insertions: 1, deletions: 1 });
    expect(plan.lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add', 'context', 'empty']);
  });

  test('parse classifies meta / hunk / add / del / context', () => {
    const lines = parseLynxUnifiedDiffLines(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n',
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'meta', 'meta', 'meta', 'hunk', 'del', 'add', 'context', 'empty',
    ]);
    expect(summarizeLynxDiffStats(lines)).toEqual({ insertions: 1, deletions: 1 });
  });

  test('original+modified fallback builds portable preview', () => {
    const preview = buildLynxOriginalModifiedPreview('a.ts', 'old', 'new');
    expect(preview).toContain('--- a/a.ts');
    expect(preview).toContain('-old');
    expect(preview).toContain('+new');
    const plan = planLynxPierreDiff({ original: 'old', modified: 'new', path: 'a.ts' });
    expect(plan.presentation).toBe('portable-text');
    expect(plan.stats.deletions).toBeGreaterThan(0);
    expect(plan.stats.insertions).toBeGreaterThan(0);
  });

  test('line tokens distinguish add/del from hunk/muted (Cap status colors)', () => {
    expect(lynxPierreDiffLineToken('add')).toBe('status.success');
    expect(lynxPierreDiffLineToken('del')).toBe('status.error');
    expect(lynxPierreDiffLineToken('hunk')).toBe('surface.mutedForeground');
    expect(lynxPierreDiffLineToken('meta')).toBe('surface.mutedForeground');
    expect(lynxPierreDiffLineToken('empty')).toBe('surface.mutedForeground');
    expect(lynxPierreDiffLineToken('context')).toBe('surface.foreground');
    expect(lynxPierreDiffLineToken('del')).not.toBe(lynxPierreDiffLineToken('hunk'));
  });

  test('feature path: preferPierre still activates portable-text with blockers', () => {
    const feature = resolveLynxPierreDiffFeature({ preferPierre: true });
    expect(feature.requested).toBe('pierre');
    expect(feature.active).toBe('portable-text');
    expect(feature.pierreViewer).toBe('unavailable');
    expect(feature.blockers.length).toBeGreaterThanOrEqual(3);
    expect(feature.blockers.some((b) => b.includes('Shadow DOM'))).toBe(true);
    expect(feature.blockers.some((b) => b.includes('react-dom'))).toBe(true);
    expect(LYNX_PIERRE_DIFF_BLOCKERS[0]).toContain('@pierre/diffs');
  });

  test('Cap ChangeRow spacing constants match measurable Cap source', () => {
    // packages/ui/.../ChangeRow.tsx: size-6, gap-1.5, mx-0.5, h-8, w-3.5
    expect(LYNX_CHANGE_ROW_SPACING.actionSizePx).toBe(24);
    expect(LYNX_CHANGE_ROW_SPACING.contentGapPx).toBe(6);
    expect(LYNX_CHANGE_ROW_SPACING.statsSlashMarginPx).toBe(2);
    expect(LYNX_CHANGE_ROW_SPACING.rowMinHeightPx).toBe(32);
    expect(LYNX_CHANGE_ROW_SPACING.chipMarginLeftPx).toBe(0);
    expect(LYNX_CHANGE_ROW_SPACING.statusCodeWidthPx).toBe(14);
  });

  test('status code / token map Cap ChangeRow descriptors', () => {
    expect(lynxChangeStatusCode('modified')).toBe('M');
    expect(lynxChangeStatusCode('untracked')).toBe('?');
    expect(lynxChangeStatusCode('A')).toBe('A');
    expect(lynxChangeStatusCode('deleted')).toBe('D');
    expect(lynxChangeStatusToken('A')).toBe('status.success');
    expect(lynxChangeStatusToken('D')).toBe('status.error');
    expect(lynxChangeStatusToken('?')).toBe('primary.base');
  });
});
