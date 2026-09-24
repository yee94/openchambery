import { describe, expect, test } from 'vitest';

import { textSelectionBarFrame } from './textSelectionBarFrame';

describe('textSelectionBarFrame', () => {
  test('covers the visible composer instead of a floating pill', () => {
    expect(textSelectionBarFrame({
      composer: { left: 0, top: 640, width: 390, height: 128 },
      viewportWidth: 390,
      viewportHeight: 800,
      keyboardOverlapPx: 0,
      nativeComposerHeightPx: 0,
      lastHeightPx: 0,
    })).toEqual({ left: 0, top: 640, width: 390, height: 128 });
  });

  test('sits the native composer height above the keyboard when the web foot is collapsed', () => {
    expect(textSelectionBarFrame({
      composer: null,
      viewportWidth: 390,
      viewportHeight: 800,
      keyboardOverlapPx: 300,
      nativeComposerHeightPx: 96,
      lastHeightPx: 0,
    })).toEqual({ left: 0, top: 404, width: 390, height: 96 });
  });

  test('keeps the last measured height when neither composer is measurable', () => {
    expect(textSelectionBarFrame({
      composer: { left: 0, top: 0, width: 10, height: 10 },
      viewportWidth: 390,
      viewportHeight: 800,
      keyboardOverlapPx: 0,
      nativeComposerHeightPx: 0,
      lastHeightPx: 120,
    })).toEqual({ left: 0, top: 680, width: 390, height: 120 });
  });
});
