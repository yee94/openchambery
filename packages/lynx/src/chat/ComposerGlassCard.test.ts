import { describe, expect, test } from 'vitest';

import {
  ANDROID_BLUR_SAMPLING,
  ANDROID_DOCK_BLUR_RADIUS,
  androidAttrsContainIosGlass,
  resolveBlurViewAttributes,
} from '../glass/blurView';
import { createHostGlobalProps } from '../host/embedding';
import { LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT } from './composerAutocompleteLayout';
import { composerGlassSurfaceForVariant } from './ComposerGlassCard';

describe('LynxComposerGlassCard / blur-view wiring', () => {
  test('variant maps to Cap glass surfaces', () => {
    expect(composerGlassSurfaceForVariant('pill')).toBe('composerPill');
    expect(composerGlassSurfaceForVariant('card')).toBe('composerCard');
  });

  test('iOS 26 composer card is glass + interactive (not elevated solid)', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'composerCard',
      platform: 'ios',
      iosMajorVersion: 26,
      themeVariant: 'light',
      fullPageAutoGlassSkin: true,
    });
    expect(attrs?.['blur-effect']).toBe('glass');
    expect(attrs?.['glass-interactive']).toBe(true);
  });

  test('iOS 26 composer pill is glass-interactive; Mode B still skins composer', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'composerPill',
      platform: 'ios',
      iosMajorVersion: 26,
      themeVariant: 'dark',
      fullPageAutoGlassSkin: false,
    });
    expect(attrs?.['blur-effect']).toBe('glass');
    expect(attrs?.['glass-interactive']).toBe(true);
  });

  test('Android composer uses blur-radius only', () => {
    const attrs = resolveBlurViewAttributes({
      surface: 'composerCard',
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
  });

  test('autocomplete remains forbidInsideGlassContentView sibling above glass', () => {
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.forbidInsideGlassContentView).toBe(true);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.placement).toBe('above-glass-composer');
    // Host props exist for optional row chips — chips live in the sibling list tree.
    const host = createHostGlobalProps({ platform: 'ios', iosMajorVersion: 26 });
    expect(host.platform).toBe('ios');
  });
});
