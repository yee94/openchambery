import { describe, expect, test } from 'vitest';

import { planLynxPierreDiff } from './pierreDiff';

describe('Lynx PierreDiff stub', () => {
  test('binary has no text preview', () => {
    const plan = planLynxPierreDiff({ binary: true });
    expect(plan.hasTextPreview).toBe(false);
    expect(plan.pierreViewer).toBe('stub');
  });

  test('unified diff → text preview + stub viewer note', () => {
    const plan = planLynxPierreDiff({ unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' });
    expect(plan.hasTextPreview).toBe(true);
    expect(plan.pierreViewer).toBe('stub');
    expect(plan.note).toContain('PierreDiff');
  });
});
