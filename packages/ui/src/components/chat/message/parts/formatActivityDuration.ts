/**
 * Settled activity-header duration label (ProgressiveGroup completed turns).
 * Live elapsed while working is owned only by WorkingPlaceholder.
 */
export const formatActivityDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};
