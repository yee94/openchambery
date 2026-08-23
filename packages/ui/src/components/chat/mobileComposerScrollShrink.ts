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
