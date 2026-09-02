import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_READABILITY_BUMP,
  ANDROID_DESIGN_PT_SCALE_MAX,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android 0.95 cap when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBe(0.95);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBe(0.95);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBe(0.95);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBe(0.95);
  });

  test('typical ~0.9 physical scale lifts to 0.95 instead of staying put', () => {
    expect(ANDROID_DESIGN_PT_READABILITY_BUMP).toBeCloseTo(0.95 / 0.9, 8);
    // (294 / 2) / 163 ≈ 0.902 — a cap-only change would still be 0.9.
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBe(0.95);
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(0.95);
  });

  test('still allows values below the Android cap after the 0.9→0.95 lift', () => {
    // clamp(0.798) = 0.85, then × (0.95/0.9) ≈ 0.897
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 })).toBeCloseTo(
      0.85 * ANDROID_DESIGN_PT_READABILITY_BUMP,
      5,
    );
    expect(computeDesignPtScale({ xdpi: 800, ydpi: 800, density: 2 })).toBe(0.95);
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.95, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.95px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.95');
  });

  test('iOS stays at 10/9; Android cap is 0.95 not 1', () => {
    expect(ANDROID_DESIGN_PT_SCALE_MAX).toBe(0.95);
    expect(ANDROID_DESIGN_PT_SCALE_MAX).toBeLessThan(1);
    expect(IOS_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
  });

  test('device-info resize restore never exceeds the Android cap from stale cache', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '1.04');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(0.95);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(0.95);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores the previous 0.9 cache key so the lift is not written back', () => {
    window.localStorage.setItem('openchamber.designPtScale.v6', '0.9');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(0.95);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('openchamber.designPtScale.v6');
  });

  test('iOS cache restore always uses 10/9, not a stale 1.0', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '1');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'ios',
    };
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });
});
