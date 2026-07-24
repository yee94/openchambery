export type MobileWindowMotionEdge = 'left' | 'right' | 'top' | 'bottom';
export type MobileWindowMotionPresentation = 'sheet' | 'page';
export type MobileWindowMotionOperation = 'present' | 'dismiss';
export type MobileWindowMotionFinish = 'commit' | 'cancel';

export type MobileWindowMotionFrame = {
  progress: number;
  scrimOpacity: number;
  surfaceOpacity: number;
  surfaceTransform: string;
};

export const getMobileWindowMotionSurfaceLayout = (
  presentation: MobileWindowMotionPresentation,
  edge: MobileWindowMotionEdge,
): string => {
  const base = 'flex min-h-0 flex-col bg-background shadow-none';
  if (presentation === 'page') return `${base} h-full w-full`;
  const sheet = `${base} pwa-overlay-panel`;
  if (edge === 'top') return `${sheet} mx-auto mb-auto max-h-[calc(100dvh-0.75rem)] w-full max-w-lg rounded-b-xl border-x border-b border-border/50`;
  if (edge === 'left') return `${sheet} h-full w-[min(86vw,24rem)] rounded-r-xl border-r border-y border-border/50`;
  if (edge === 'right') return `${sheet} ml-auto h-full w-[min(86vw,24rem)] rounded-l-xl border-l border-y border-border/50`;
  return `${sheet} mx-auto mt-auto max-h-[calc(100dvh-0.75rem)] w-full max-w-lg rounded-t-2xl border-x border-t border-border/50`;
};

export const clampMobileWindowMotionProgress = (progress: number): number => (
  Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
);

export const getNearestMobileWindowMotionSnapPoint = (
  height: number,
  viewportHeight: number,
  snapPoints: readonly number[],
): number => {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const heightRatio = Math.max(0, Number.isFinite(height) ? height : 0) / safeViewportHeight;
  let nearest = clampMobileWindowMotionProgress(snapPoints[0] ?? 1);
  let nearestDistance = Math.abs(heightRatio - nearest);

  for (let index = 1; index < snapPoints.length; index += 1) {
    const candidate = clampMobileWindowMotionProgress(snapPoints[index] ?? nearest);
    const distance = Math.abs(heightRatio - candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest;
};

export const getMobileWindowMotionFrame = (
  edge: MobileWindowMotionEdge,
  progress: number,
): MobileWindowMotionFrame => {
  const value = clampMobileWindowMotionProgress(progress);
  const distance = 1 - value;
  const offset = `${distance * 100}%`;
  const transform = edge === 'left'
    ? `translate3d(-${offset}, 0, 0)`
    : edge === 'right'
      ? `translate3d(${offset}, 0, 0)`
      : edge === 'top'
        ? `translate3d(0, -${offset}, 0)`
        : `translate3d(0, ${offset}, 0)`;

  return {
    progress: value,
    scrimOpacity: value,
    surfaceOpacity: value,
    surfaceTransform: transform,
  };
};

export const getMobileWindowMotionVisibleProgress = (
  operation: MobileWindowMotionOperation,
  progress: number,
): number => {
  const value = clampMobileWindowMotionProgress(progress);
  return operation === 'present' ? value : 1 - value;
};

export const getMobileWindowMotionOperationTarget = (
  operation: MobileWindowMotionOperation,
  finish: MobileWindowMotionFinish,
): number => (
  operation === 'present'
    ? (finish === 'commit' ? 1 : 0)
    : (finish === 'commit' ? 0 : 1)
);

export const getMobileWindowMotionControlledTarget = (open: boolean): number => (open ? 1 : 0);
