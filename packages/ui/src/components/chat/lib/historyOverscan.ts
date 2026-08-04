const INITIAL_HISTORY_OVERSCAN = 2;
const HISTORY_OVERSCAN_STEP = 2;

export const getInitialHistoryOverscan = (target: number): number => (
    Math.min(Math.max(0, target), INITIAL_HISTORY_OVERSCAN)
);

export const getNextHistoryOverscan = (current: number, target: number): number => (
    Math.min(Math.max(0, target), Math.max(0, current) + HISTORY_OVERSCAN_STEP)
);
