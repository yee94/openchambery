import { describe, expect, test } from 'vitest';

import {
  buildLynxOriginalModifiedPreview,
  lynxPierreDiffLineToken,
  parseLynxUnifiedDiffLines,
  planLynxPierreDiff,
  summarizeLynxDiffStats,
} from './pierreDiff';

describe('Lynx PierreDiff portable text', () => {
  test('binary has no text preview', () => {
    const plan = planLynxPierreDiff({ binary: true });
    expect(plan.hasTextPreview).toBe(false);
    expect(plan.pierreViewer).toBe('stub');
    expect(plan.presentation).toBe('none');
    expect(plan.lines).toEqual([]);
  });

  test('unified diff → portable lines + stats (Pierre still stub)', () => {
    const plan = planLynxPierreDiff({ unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n context\n' });
    expect(plan.hasTextPreview).toBe(true);
    expect(plan.pierreViewer).toBe('stub');
    expect(plan.presentation).toBe('portable-text');
    expect(plan.note).toContain('PierreDiff');
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
    // del must not collapse onto hunk/muted
    expect(lynxPierreDiffLineToken('del')).not.toBe(lynxPierreDiffLineToken('hunk'));
  });
});
