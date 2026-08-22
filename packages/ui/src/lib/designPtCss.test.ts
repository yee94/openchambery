import { describe, expect, test } from 'vitest';
import { rewriteLengthToDesignPt } from '../../../../scripts/postcss-dpt-font-size.mjs';

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
});
