import { describe, expect, test } from 'vitest';

import {
  ANDROID_BLUR_SAMPLING,
  ANDROID_DOCK_BLUR_RADIUS,
  androidAttrsContainIosGlass,
  describeGlassMapping,
  isGlassChromeSurface,
  mustNotWrapWithGlass,
  resolveBlurViewAttributes,
} from './blurView';

describe('Lynx 3.8 blur-view glass', () => {
  test('iOS 26 dock uses glass-container mapped to UIGlassContainerEffect', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'dock',
      platform: 'ios',
      iosMajorVersion: 26,
      themeVariant: 'light',
      fullPageAutoGlassSkin: true,
    });
    expect(attrs).toEqual({
      'blur-effect': 'glass-container',
      'glass-style': 'regular',
      'glass-interactive': false,
      'glass-tint-color': 'transparent',
      spacing: 12,
    });
    expect(describeGlassMapping(attrs, 'ios')).toEqual({
      platform: 'ios',
      uiKitClass: 'UIGlassContainerEffect',
    });
  });

  test('iOS 26 interactive chrome uses glass mapped to UIGlassEffect', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'composerPill',
      platform: 'ios',
      iosMajorVersion: 26,
      themeVariant: 'dark',
      fullPageAutoGlassSkin: true,
    });
    expect(attrs?.['blur-effect']).toBe('glass');
    expect(attrs?.['glass-interactive']).toBe(true);
    expect(attrs?.['glass-style']).toBe('regular');
    expect(describeGlassMapping(attrs, 'ios')).toEqual({
      platform: 'ios',
      uiKitClass: 'UIGlassEffect',
    });
  });

  test('Mode B does not let Lynx skin the dock', () => {
    expect(resolveBlurViewAttributes({
      surface: 'dock',
      platform: 'ios',
      iosMajorVersion: 26,
      themeVariant: 'light',
      fullPageAutoGlassSkin: false,
    })).toBeNull();
  });

  test('older iOS uses theme blur, not glass', () => {
    const light = resolveBlurViewAttributes({
      surface: 'dock',
      platform: 'ios',
      iosMajorVersion: 18,
      themeVariant: 'light',
      fullPageAutoGlassSkin: true,
    });
    const dark = resolveBlurViewAttributes({
      surface: 'dock',
      platform: 'ios',
      iosMajorVersion: 18,
      themeVariant: 'dark',
      fullPageAutoGlassSkin: true,
    });
    expect(light).toEqual({ 'blur-effect': 'light' });
    expect(dark).toEqual({ 'blur-effect': 'dark' });
    expect(describeGlassMapping(light, 'ios').uiKitClass).toBe('UIBlurEffect');
  });

  test('Android downgrades to blur-radius and never emits UIGlassEffect attrs', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'dock',
      platform: 'android',
      themeVariant: 'light',
      fullPageAutoGlassSkin: true,
    });
    expect(attrs).toEqual({
      'blur-radius': ANDROID_DOCK_BLUR_RADIUS,
      'blur-sampling': ANDROID_BLUR_SAMPLING,
      'enable-auto-blur': true,
    });
    expect(androidAttrsContainIosGlass(attrs!)).toBe(false);
    expect(describeGlassMapping(attrs, 'android')).toEqual({
      platform: 'android',
      uiKitClass: null,
      downgrade: 'blur-radius',
    });
  });

  test('transcript and settings rows are not glass chrome', () => {
    expect(isGlassChromeSurface('transcript')).toBe(false);
    expect(mustNotWrapWithGlass('transcript')).toBe(true);
    expect(mustNotWrapWithGlass('settingsRow')).toBe(true);
  });
});
