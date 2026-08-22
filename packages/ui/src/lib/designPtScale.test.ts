import { describe, expect, test } from 'vitest';
import { clampDesignPtScale, computeDesignPtScale } from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns 1 when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBe(1);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBe(1);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBe(1);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBe(1);
  });

  test('maps Android CSS px toward the 163pt iPhone inch', () => {
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBeCloseTo(1.047, 3);
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBeCloseTo(0.902, 3);
  });

  test('clamps extreme buckets', () => {
    expect(computeDesignPtScale({ xdpi: 800, ydpi: 800, density: 2 })).toBe(1.2);
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });
});
