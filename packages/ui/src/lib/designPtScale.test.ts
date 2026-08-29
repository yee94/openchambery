import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_READABILITY_BUMP,
  ANDROID_DESIGN_PT_SCALE_DEFAULT,
  ANDROID_DESIGN_PT_SCALE_MAX,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android default when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
  });

  test('Android bump is a slight lift of the old 0.9, not the iOS 10/9 parameter', () => {
    expect(ANDROID_DESIGN_PT_READABILITY_BUMP).toBe(1.05);
    expect(ANDROID_DESIGN_PT_SCALE_DEFAULT).toBeCloseTo(0.945, 8);
    expect(ANDROID_DESIGN_PT_SCALE_DEFAULT).toBeLessThan(IOS_DESIGN_PT_SCALE);
    expect(IOS_DESIGN_PT_SCALE).toBeCloseTo(10 / 9, 8);
  });

  test('typical ~0.9 physical scale grows by the Android-only bump, not to iOS 10/9', () => {
    // (294 / 2) / 163 ≈ 0.902 — cap-only would stay ~0.9; 10/9 would hit 1.
    const typical = computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 });
    expect(typical).toBeCloseTo(0.902 * ANDROID_DESIGN_PT_READABILITY_BUMP, 2);
    expect(typical).toBeLessThan(1);
    expect(typical).toBeLessThan(IOS_DESIGN_PT_SCALE);
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBe(1);
  });

  test('still allows values below the Android cap after the Android-only bump', () => {
    // clamp(0.798) = 0.85, then × 1.05 = 0.8925
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 })).toBeCloseTo(
      0.85 * ANDROID_DESIGN_PT_READABILITY_BUMP,
      5,
    );
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

  test('iOS applies its own 10/9 scale, not the Android default', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(IOS_DESIGN_PT_SCALE, root);
    expect(root.style.getPropertyValue('--dpt-n')).toBe(String(IOS_DESIGN_PT_SCALE));
  });

  test('device-info resize restore never exceeds the Android cap from stale cache', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '1.04');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores older cache keys so a shared 10/9 or 0.9 is not restored', () => {
    window.localStorage.setItem('openchamber.designPtScale.v1', '0.9');
    window.localStorage.setItem('openchamber.designPtScale.v2', String(10 / 9));
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBe(ANDROID_DESIGN_PT_SCALE_DEFAULT);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('openchamber.designPtScale.v1');
    window.localStorage.removeItem('openchamber.designPtScale.v2');
  });

  test('iOS cache restore always uses the iOS bump, not a stale 1.0', () => {
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
