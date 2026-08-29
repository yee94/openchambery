import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_SCALE,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('Android is pinned to 1; iOS stays at 10/9', () => {
    expect(ANDROID_DESIGN_PT_SCALE).toBe(1);
    expect(IOS_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
    expect(computeDesignPtScale(null)).toBe(1);
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBe(1);
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(1);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.9, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.9px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.9');
  });

  test('applies the pinned Android 1.0 scale to the root', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(ANDROID_DESIGN_PT_SCALE, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('1px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('1');
  });

  test('clamp still bounds extreme values', () => {
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('Android cache restore always uses 1, not a stale 10/9 trial', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, String(10 / 9));
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(1);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(1);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores older cache keys so 0.9 / 0.945 / 10/9 are not restored', () => {
    window.localStorage.setItem('openchamber.designPtScale.v1', '0.9');
    window.localStorage.setItem('openchamber.designPtScale.v3', '0.945');
    window.localStorage.setItem('openchamber.designPtScale.v4', String(10 / 9));
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(1);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('openchamber.designPtScale.v1');
    window.localStorage.removeItem('openchamber.designPtScale.v3');
    window.localStorage.removeItem('openchamber.designPtScale.v4');
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
