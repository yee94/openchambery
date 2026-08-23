import { describe, expect, test } from 'vitest';
import { rewriteLengthToDesignPt, shouldRewriteProp } from '../../../../scripts/postcss-dpt-font-size.mjs';

describe('rewriteLengthToDesignPt', () => {
  test('converts px and rem font sizes, including leading-dot decimals', () => {
    expect(rewriteLengthToDesignPt('15px')).toBe('calc(15 * var(--dpt))');
    expect(rewriteLengthToDesignPt('0.9375rem')).toBe('calc(15 * var(--dpt))');
    // Mobile CSS writes leading-dot rem (e.g. .8125rem) — must convert too.
    expect(rewriteLengthToDesignPt('.9375rem')).toBe('calc(15 * var(--dpt))');
    expect(rewriteLengthToDesignPt('.8125rem')).toBe('calc(13 * var(--dpt))');
    expect(rewriteLengthToDesignPt('.75rem')).toBe('calc(12 * var(--dpt))');
    expect(rewriteLengthToDesignPt('.6875rem')).toBe('calc(11 * var(--dpt))');
  });

  test('leaves hairlines, zeros, unitless, and already-converted values', () => {
    expect(rewriteLengthToDesignPt('1px')).toBe('1px');
    expect(rewriteLengthToDesignPt('0')).toBe('0');
    expect(rewriteLengthToDesignPt('1.375')).toBe('1.375');
    expect(rewriteLengthToDesignPt('calc(14 * var(--dpt))')).toBe('calc(14 * var(--dpt))');
  });

  test('typography size custom props convert while geometry vars stay untouched', () => {
    // Rewritten by the plugin's prop filter (tested via declaration flow); the
    // value rewrite itself is size-agnostic:
    expect(rewriteLengthToDesignPt('2rem')).toBe('calc(32 * var(--dpt))');
    expect(rewriteLengthToDesignPt('.625rem')).toBe('calc(10 * var(--dpt))');
    // var() references never rewrite — they ride the underlying chain.
    expect(rewriteLengthToDesignPt('var(--text-ui-label)')).toBe('var(--text-ui-label)');
  });

  test('prop filter admits typography size vars and rejects geometry vars', () => {
    expect(shouldRewriteProp('font-size')).toBe(true);
    expect(shouldRewriteProp('line-height')).toBe(true);
    expect(shouldRewriteProp('--text-sm')).toBe(true);
    expect(shouldRewriteProp('--oc-mobile-root-title-size')).toBe(true);
    expect(shouldRewriteProp('--oc-mobile-entity-meta-size')).toBe(true);
    expect(shouldRewriteProp('--oc-mobile-detail-subtitle-size')).toBe(true);
    expect(shouldRewriteProp('--oc-settings-section-title-size')).toBe(true);
    expect(shouldRewriteProp('--form-helper-font-size')).toBe(true);
    // Geometry must never scale: keyboard inset, dock height, icon size…
    expect(shouldRewriteProp('--oc-mobile-dock-height')).toBe(false);
    expect(shouldRewriteProp('--oc-header-height')).toBe(false);
    expect(shouldRewriteProp('--oc-mobile-project-icon-size')).toBe(false);
    expect(shouldRewriteProp('--form-control-line-height')).toBe(true); // line-height rides dpt
    expect(shouldRewriteProp('--oc-safe-area-top')).toBe(false);
    expect(shouldRewriteProp('width')).toBe(false);
  });
});
