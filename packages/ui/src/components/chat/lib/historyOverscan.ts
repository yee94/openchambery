/**
 * First-paint overscan budget. End-anchored chat used to stage 2 → 4 → 6 → 8
 * (and mobile up to 16) across after-paint transitions. Each step mounted new
 * rows, remeasured, and applied scroll corrections — Chrome traces showed
 * multi-hundred-ms of Layout + ScrollLayer pairs that read as load-time jitter.
 *
 * Prefer one mount wave up to this cap. Only lists whose product overscan is
 * wider (mobile 16) take a single follow-up jump to the full target.
 */
const INITIAL_HISTORY_OVERSCAN_CAP = 8;

export const getInitialHistoryOverscan = (target: number): number => {
    const resolved = Math.max(0, target);
    return Math.min(resolved, INITIAL_HISTORY_OVERSCAN_CAP);
};

/**
 * Jump straight to the product overscan. Multi-step ramps are intentionally
 * avoided: intermediate sizes cause repeated virtualizer measure/anchor work.
 */
export const getNextHistoryOverscan = (current: number, target: number): number => {
    const resolvedTarget = Math.max(0, target);
    const resolvedCurrent = Math.max(0, current);
    if (resolvedCurrent >= resolvedTarget) {
        return resolvedTarget;
    }
    return resolvedTarget;
};
