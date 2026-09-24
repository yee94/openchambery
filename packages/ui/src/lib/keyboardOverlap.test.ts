import { describe, expect, test } from 'vitest';

import { keyboardOverlapPx, parseCssPx } from './keyboardOverlap';

describe('keyboardOverlapPx', () => {
  test('uses the larger of the CSS inset and the visual viewport overlap', () => {
    expect(keyboardOverlapPx({
      cssInsetPx: 0,
      innerHeight: 800,
      visualHeight: 500,
      visualOffsetTop: 0,
    })).toBe(300);
    expect(keyboardOverlapPx({
      cssInsetPx: 320,
      innerHeight: 800,
      visualHeight: 800,
      visualOffsetTop: 0,
    })).toBe(320);
  });

  test('does not add the two sources', () => {
    expect(keyboardOverlapPx({
      cssInsetPx: 300,
      innerHeight: 800,
      visualHeight: 500,
      visualOffsetTop: 0,
    })).toBe(300);
  });

  test('ignores a missing visual viewport and negative inset', () => {
    expect(keyboardOverlapPx({ cssInsetPx: -4, innerHeight: 800 })).toBe(0);
    expect(parseCssPx('12px')).toBe(12);
    expect(parseCssPx('')).toBe(0);
  });
});
