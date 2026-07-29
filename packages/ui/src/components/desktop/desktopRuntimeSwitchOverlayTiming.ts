export const DESKTOP_RUNTIME_SWITCH_MIN_DURATION_MS = 350;

export const getDesktopRuntimeSwitchRemainingMs = (
  startedAt: number,
  now: number,
  ready: boolean,
  minimumDurationMs = DESKTOP_RUNTIME_SWITCH_MIN_DURATION_MS,
): number | null => {
  if (!ready) return null;
  return Math.max(0, minimumDurationMs - Math.max(0, now - startedAt));
};
