import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_SCALE_MAX,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android cap when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
  });

  test('caps Android design pt at 1 even when physical math is above 1', () => {
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(1);
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBeCloseTo(0.9, 2);
  });

  test('still allows values below the Android cap and clamps extremes', () => {
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 })).toBeCloseTo(0.85, 2);
    expect(computeDesignPtScale({ xdpi: 800, ydpi: 800, density: 2 })).toBe(1);
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.9, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.9px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.9');
  });

  test('iOS readability bump is the same 10/9 ratio as lifting the Android ceiling', () => {
    expect(ANDROID_DESIGN_PT_SCALE_MAX).toBe(1);
    expect(IOS_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(IOS_DESIGN_PT_SCALE, root);
    expect(root.style.getPropertyValue('--dpt-n')).toBe(String(IOS_DESIGN_PT_SCALE));
  });

  test('device-info resize restore never exceeds the Android cap from stale cache', () => {
    window.localStorage.setItem('openchamber.designPtScale.v1', '1.04');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    window.localStorage.removeItem('openchamber.designPtScale.v1');
    expect(readCachedDesignPtScale()).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('iOS cache restore always uses the readability bump, not a stale 1.0', () => {
    window.localStorage.setItem('openchamber.designPtScale.v1', '1');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'ios',
    };
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    window.localStorage.removeItem('openchamber.designPtScale.v1');
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });
});
