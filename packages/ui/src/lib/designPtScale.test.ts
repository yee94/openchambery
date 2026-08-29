import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_SCALE_DEFAULT,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  MOBILE_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('Android and iOS share the same 10/9 mobile scale', () => {
    expect(MOBILE_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
    expect(IOS_DESIGN_PT_SCALE).toBe(MOBILE_DESIGN_PT_SCALE);
    expect(ANDROID_DESIGN_PT_SCALE_DEFAULT).toBe(MOBILE_DESIGN_PT_SCALE);
    expect(computeDesignPtScale(null)).toBe(MOBILE_DESIGN_PT_SCALE);
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBe(MOBILE_DESIGN_PT_SCALE);
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(MOBILE_DESIGN_PT_SCALE);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.9, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.9px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.9');
  });

  test('applies the shared 10/9 scale to the root', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(MOBILE_DESIGN_PT_SCALE, root);
    expect(root.style.getPropertyValue('--dpt-n')).toBe(String(MOBILE_DESIGN_PT_SCALE));
  });

  test('clamp still bounds extreme values', () => {
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('Android cache restore always uses the shared mobile scale', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '0.945');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(MOBILE_DESIGN_PT_SCALE);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(MOBILE_DESIGN_PT_SCALE);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores older cache keys so a 0.9 or 1.05 result is not restored', () => {
    window.localStorage.setItem('openchamber.designPtScale.v1', '0.9');
    window.localStorage.setItem('openchamber.designPtScale.v3', '0.945');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(MOBILE_DESIGN_PT_SCALE);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('openchamber.designPtScale.v1');
    window.localStorage.removeItem('openchamber.designPtScale.v3');
  });

  test('iOS cache restore always uses the shared mobile scale, not a stale 1.0', () => {
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
