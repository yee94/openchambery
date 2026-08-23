interface MobileComposerScrollShrinkInput {
    distanceFromBottom: number;
    keyboardOpen: boolean;
    pinnedFull: boolean;
}

export const resolveMobileComposerShrink = ({
    distanceFromBottom,
    keyboardOpen,
    pinnedFull,
}: MobileComposerScrollShrinkInput): number => {
    if (keyboardOpen || pinnedFull) return 0;
    return Math.min(1, Math.max(0, distanceFromBottom / 100));
};

/** Compact end-state height (2.75rem) used by the stage-height interpolation. */
export const COMPACT_MOBILE_COMPOSER_HEIGHT_PX = 44;

/**
 * The shrinking composer grows the scroll viewport's clientHeight by the same
 * pixels it retracts, so the raw measured distance feeds back into the shrink
 * input (progress settles at d/(100+D) and the 100px spec stretches to
 * 100+D). Add the retracted pixels back so the progress tracks the finger's
 * real travel. `currentShrink` is read from the live CSS variable (the input
 * pin path writes it outside this hook), `stageHeightPx` from the mirrored
 * root stage variable.
 */
export const compensateMobileComposerDistance = (
    rawDistanceFromBottom: number,
    currentShrink: number,
    stageHeightPx: number,
): number => {
    const shrink = Math.min(1, Math.max(0, currentShrink));
    const retractedPx = shrink * Math.max(0, stageHeightPx - COMPACT_MOBILE_COMPOSER_HEIGHT_PX);
    return rawDistanceFromBottom + retractedPx;
};
