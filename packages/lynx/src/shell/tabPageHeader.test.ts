import { describe, expect, test } from 'vitest';

import {
  LYNX_TITLE_COLLAPSE_DISTANCE,
  LYNX_TITLE_COMPACT_SIZE,
  LYNX_TITLE_EXPANDED_SIZE,
  computeLynxTitleCollapseProgress,
  lynxTitleFontSizeForProgress,
  shouldSkipCollapseWrite,
} from './tabPageHeader';

describe('Lynx TabPageHeader collapse math', () => {
  test('maps 0..distance to 0..1 without exceeding', () => {
    expect(computeLynxTitleCollapseProgress({ scrollTop: 0 })).toBe(0);
    expect(computeLynxTitleCollapseProgress({ scrollTop: LYNX_TITLE_COLLAPSE_DISTANCE / 2 })).toBe(0.5);
    expect(computeLynxTitleCollapseProgress({ scrollTop: LYNX_TITLE_COLLAPSE_DISTANCE })).toBe(1);
    expect(computeLynxTitleCollapseProgress({ scrollTop: 999 })).toBe(1);
    expect(computeLynxTitleCollapseProgress({ scrollTop: -10 })).toBe(0);
  });

  test('reduced motion snaps at 0.5', () => {
    expect(computeLynxTitleCollapseProgress({ scrollTop: 20, reducedMotion: true })).toBe(0);
    expect(computeLynxTitleCollapseProgress({ scrollTop: 24, reducedMotion: true })).toBe(1);
  });

  test('font size interpolates expanded → compact', () => {
    expect(lynxTitleFontSizeForProgress(0)).toBe(LYNX_TITLE_EXPANDED_SIZE);
    expect(lynxTitleFontSizeForProgress(1)).toBe(LYNX_TITLE_COMPACT_SIZE);
    expect(lynxTitleFontSizeForProgress(0.5)).toBe(
      (LYNX_TITLE_EXPANDED_SIZE + LYNX_TITLE_COMPACT_SIZE) / 2,
    );
  });

  test('skips no-op collapse writes', () => {
    expect(shouldSkipCollapseWrite(null, 0)).toBe(false);
    expect(shouldSkipCollapseWrite(0.5, 0.5004)).toBe(true);
    expect(shouldSkipCollapseWrite(0.5, 0.52)).toBe(false);
  });
});
