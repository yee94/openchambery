import { describe, expect, test } from 'vitest';
import { rewriteLengthToDesignPt } from './postcss-dpt-font-size.mjs';

describe('rewriteLengthToDesignPt', () => {
  test('converts px and rem font sizes', () => {
    expect(rewriteLengthToDesignPt('15px')).toBe('calc(15 * var(--dpt))');
    expect(rewriteLengthToDesignPt('0.9375rem')).toBe('calc(15 * var(--dpt))');
  });

  test('leaves hairlines, zeros, unitless, and already-converted values', () => {
    expect(rewriteLengthToDesignPt('1px')).toBe('1px');
    expect(rewriteLengthToDesignPt('0')).toBe('0');
    expect(rewriteLengthToDesignPt('1.375')).toBe('1.375');
    expect(rewriteLengthToDesignPt('calc(14 * var(--dpt))')).toBe('calc(14 * var(--dpt))');
  });
});
