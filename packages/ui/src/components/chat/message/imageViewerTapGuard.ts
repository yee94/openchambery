import type { ImageViewerPoint } from './imageViewerTransform';

const IMAGE_VIEWER_TRAILING_CLICK_GUARD_MS = 500;
const IMAGE_VIEWER_TRAILING_CLICK_MAX_DISTANCE = 24;

type ImageViewerTrailingClickGuardOptions = {
  target?: EventTarget;
  durationMs?: number;
  maxDistance?: number;
};

export const installImageViewerTrailingClickGuard = (
  point: ImageViewerPoint,
  options: ImageViewerTrailingClickGuardOptions = {},
): (() => void) => {
  const target = options.target ?? (typeof document === 'undefined' ? null : document);
  if (!target) return () => {};

  const durationMs = options.durationMs ?? IMAGE_VIEWER_TRAILING_CLICK_GUARD_MS;
  const maxDistance = options.maxDistance ?? IMAGE_VIEWER_TRAILING_CLICK_MAX_DISTANCE;
  let active = true;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined = undefined;

  const cleanup = () => {
    if (!active) return;
    active = false;
    target.removeEventListener('click', handleClick, true);
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  };

  const handleClick: EventListener = (event) => {
    const click = event as Event & { clientX?: unknown; clientY?: unknown };
    if (typeof click.clientX !== 'number' || typeof click.clientY !== 'number') return;
    if (Math.hypot(click.clientX - point.x, click.clientY - point.y) > maxDistance) return;

    cleanup();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  target.addEventListener('click', handleClick, true);
  timeoutId = globalThis.setTimeout(cleanup, durationMs);
  return cleanup;
};

export const closeImageViewerAfterMobileTap = (
  point: ImageViewerPoint,
  close: () => void,
  options: ImageViewerTrailingClickGuardOptions = {},
): void => {
  installImageViewerTrailingClickGuard(point, options);
  close();
};
