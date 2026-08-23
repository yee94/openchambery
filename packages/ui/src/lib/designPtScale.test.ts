import { describe, expect, test } from 'vitest';
import { applyDesignPtScaleToRoot, clampDesignPtScale, computeDesignPtScale } from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android experiment cap when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBe(0.9);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBe(0.9);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBe(0.9);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBe(0.9);
  });

  test('caps Android design pt at 0.9 even when physical math is near 1', () => {
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(0.9);
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBe(0.9);
  });

  test('still allows values below the Android cap and clamps extremes', () => {
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 })).toBeCloseTo(0.85, 2);
    expect(computeDesignPtScale({ xdpi: 800, ydpi: 800, density: 2 })).toBe(0.9);
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.9, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.9px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.9');
  });
});
