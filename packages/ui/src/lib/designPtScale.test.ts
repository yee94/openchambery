import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_SCALE_MAX,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android cap when metrics are missing or dirty', () => {
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

  test('iOS stays at 10/9 while Android uses physical math capped at 0.9', () => {
    expect(ANDROID_DESIGN_PT_SCALE_MAX).toBe(0.9);
    expect(IOS_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(IOS_DESIGN_PT_SCALE, root);
    expect(root.style.getPropertyValue('--dpt-n')).toBe(String(IOS_DESIGN_PT_SCALE));
  });

  test('device-info resize restore never exceeds the Android cap from stale cache', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '1.04');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(0.9);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(0.9);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores older pinned-1 / 10/9 cache keys', () => {
    window.localStorage.setItem('openchamber.designPtScale.v4', String(10 / 9));
    window.localStorage.setItem('openchamber.designPtScale.v5', '1');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(0.9);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('openchamber.designPtScale.v4');
    window.localStorage.removeItem('openchamber.designPtScale.v5');
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
