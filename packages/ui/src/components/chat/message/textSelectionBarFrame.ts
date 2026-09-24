export type TextSelectionBarFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const MIN_COVER_PX = 48;
const FALLBACK_COVER_PX = 88;

export type TextSelectionComposerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Cover the visible composer foot. When the web composer is collapsed under
 * the native iOS overlay, sit a foot of the last known height above the keyboard.
 */
export const textSelectionBarFrame = (input: {
  composer: TextSelectionComposerRect | null;
  viewportWidth: number;
  viewportHeight: number;
  keyboardOverlapPx: number;
  nativeComposerHeightPx: number;
  lastHeightPx: number;
}): TextSelectionBarFrame => {
  const composer = input.composer;
  if (composer && composer.height >= MIN_COVER_PX && composer.width >= MIN_COVER_PX) {
    return {
      left: composer.left,
      top: composer.top,
      width: composer.width,
      height: composer.height,
    };
  }
  const height = input.nativeComposerHeightPx >= MIN_COVER_PX
    ? input.nativeComposerHeightPx
    : input.lastHeightPx >= MIN_COVER_PX
      ? input.lastHeightPx
      : FALLBACK_COVER_PX;
  const overlap = Math.max(0, input.keyboardOverlapPx);
  return {
    left: 0,
    top: Math.max(0, input.viewportHeight - overlap - height),
    width: Math.max(0, input.viewportWidth),
    height,
  };
};
