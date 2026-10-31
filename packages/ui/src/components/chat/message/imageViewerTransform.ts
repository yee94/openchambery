export type ImageViewerPoint = {
  x: number;
  y: number;
};

export type ImageViewerSize = {
  width: number;
  height: number;
};

export type ImageViewerTransform = ImageViewerPoint & {
  scale: number;
};

export type ImageViewerGeometry = {
  image: ImageViewerSize;
  viewport: ImageViewerSize;
  minScale?: number;
  maxScale?: number;
};

type ImageViewerPointerReleaseAction = 'none' | 'close' | 'previous' | 'next';

type ImageViewerPointerRelease = {
  isMobile: boolean;
  pointerType: string;
  cancelled: boolean;
  moved: boolean;
  suppressTap: boolean;
  targetWasCanvas: boolean;
  start: ImageViewerPoint;
  end: ImageViewerPoint;
  startScale: number;
  hasMultipleImages: boolean;
};

const IMAGE_VIEWER_MIN_SCALE = 1;
export const IMAGE_VIEWER_MAX_SCALE = 5;
export const IMAGE_VIEWER_TAP_MOVE_THRESHOLD = 10;
const IMAGE_VIEWER_GALLERY_SWIPE_THRESHOLD = 56;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

export const resolveImageViewerPointerRelease = ({
  isMobile,
  pointerType,
  cancelled,
  moved,
  suppressTap,
  targetWasCanvas,
  start,
  end,
  startScale,
  hasMultipleImages,
}: ImageViewerPointerRelease): ImageViewerPointerReleaseAction => {
  if (cancelled || suppressTap) return 'none';

  const delta = { x: end.x - start.x, y: end.y - start.y };
  const distance = Math.hypot(delta.x, delta.y);
  const isTouchPointer = pointerType !== 'mouse';
  const isGallerySwipe = isMobile
    && isTouchPointer
    && startScale <= 1.01
    && Math.abs(delta.x) >= IMAGE_VIEWER_GALLERY_SWIPE_THRESHOLD
    && Math.abs(delta.x) > Math.abs(delta.y) * 1.2;

  if (isGallerySwipe) {
    if (!hasMultipleImages) return 'none';
    return delta.x < 0 ? 'next' : 'previous';
  }

  const isTap = !moved && distance <= IMAGE_VIEWER_TAP_MOVE_THRESHOLD;
  if (isMobile && isTouchPointer && isTap) return 'close';
  if (!isMobile && pointerType === 'mouse' && isTap && targetWasCanvas) return 'close';
  return 'none';
};

export const getFittedImageSize = (
  natural: ImageViewerSize,
  viewport: ImageViewerSize,
): ImageViewerSize => {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { width: 1, height: 1 };
  }

  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  return {
    width: Math.max(1, natural.width * scale),
    height: Math.max(1, natural.height * scale),
  };
};

export const clampImageViewerTransform = (
  transform: ImageViewerTransform,
  geometry: ImageViewerGeometry,
): ImageViewerTransform => {
  const minScale = geometry.minScale ?? IMAGE_VIEWER_MIN_SCALE;
  const maxScale = geometry.maxScale ?? IMAGE_VIEWER_MAX_SCALE;
  const scale = clamp(transform.scale, minScale, maxScale);
  const maxX = Math.max(0, (geometry.image.width * scale - geometry.viewport.width) / 2);
  const maxY = Math.max(0, (geometry.image.height * scale - geometry.viewport.height) / 2);

  return {
    scale,
    x: clamp(transform.x, -maxX, maxX),
    y: clamp(transform.y, -maxY, maxY),
  };
};

export const zoomImageViewerAtPoint = (
  transform: ImageViewerTransform,
  nextScale: number,
  point: ImageViewerPoint,
  viewportCenter: ImageViewerPoint,
  geometry: ImageViewerGeometry,
): ImageViewerTransform => {
  const scale = clamp(
    nextScale,
    geometry.minScale ?? IMAGE_VIEWER_MIN_SCALE,
    geometry.maxScale ?? IMAGE_VIEWER_MAX_SCALE,
  );
  const ratio = scale / transform.scale;

  return clampImageViewerTransform({
    scale,
    x: point.x - viewportCenter.x - (point.x - viewportCenter.x - transform.x) * ratio,
    y: point.y - viewportCenter.y - (point.y - viewportCenter.y - transform.y) * ratio,
  }, geometry);
};

export const panImageViewer = (
  start: ImageViewerTransform,
  delta: ImageViewerPoint,
  geometry: ImageViewerGeometry,
): ImageViewerTransform => clampImageViewerTransform({
  ...start,
  x: start.x + delta.x,
  y: start.y + delta.y,
}, geometry);

export type ImageViewerDragAxis = 'x' | 'y' | null;

export type ImageViewerDragFrame = {
  transform: ImageViewerTransform;
  axis: ImageViewerDragAxis;
  galleryX: number;
  dismissY: number;
  dismissX: number;
  dismissScale: number;
  backdropOpacity: number;
};

/** Pull-to-dismiss follows a quarter of horizontal finger travel. */
export const IMAGE_VIEWER_DISMISS_X_FOLLOW = 0.25;
const IMAGE_VIEWER_ZOOMED_TRANSFER_THRESHOLD = 32;

export const getImageViewerDismissStyle = (dismissY: number, viewportHeight: number) => ({
  scale: 1 - Math.min(0.45, dismissY / viewportHeight * 0.65),
  opacity: clamp(1 - dismissY / (viewportHeight * 0.55), 0.15, 1),
});

const resolveImageViewerDragAxis = (
  delta: ImageViewerPoint,
  overflow: ImageViewerPoint,
  zoomed: boolean,
  hasMultipleImages: boolean,
): ImageViewerDragAxis => {
  // Zoomed images pan freely; the first edge pushed past its threshold owns the gesture.
  if (zoomed) {
    if (overflow.y > IMAGE_VIEWER_ZOOMED_TRANSFER_THRESHOLD) return 'y';
    if (hasMultipleImages && Math.abs(overflow.x) > IMAGE_VIEWER_ZOOMED_TRANSFER_THRESHOLD) return 'x';
    return null;
  }
  if (Math.hypot(delta.x, delta.y) <= IMAGE_VIEWER_TAP_MOVE_THRESHOLD) return null;
  if (!hasMultipleImages) return 'y';
  // Downward intent wins diagonals so pull-to-dismiss never stalls on an undecided axis.
  if (delta.y > 0 && delta.y >= Math.abs(delta.x) * 0.6) return 'y';
  return Math.abs(delta.x) >= Math.abs(delta.y) ? 'x' : 'y';
};

/** Keep overflow separate from the bounded image pan: only overflow can change slides or dismiss. */
export const dragImageViewer = (
  start: ImageViewerTransform,
  delta: ImageViewerPoint,
  geometry: ImageViewerGeometry,
  axis: ImageViewerDragAxis,
  hasMultipleImages: boolean,
): ImageViewerDragFrame => {
  const transform = panImageViewer(start, delta, geometry);
  const overflow = {
    x: start.x + delta.x - transform.x,
    y: start.y + delta.y - transform.y,
  };
  const zoomed = start.scale > 1.01;
  axis ??= resolveImageViewerDragAxis(delta, overflow, zoomed, hasMultipleImages);
  const transferThreshold = zoomed ? IMAGE_VIEWER_ZOOMED_TRANSFER_THRESHOLD : 0;
  const galleryX = axis === 'x' && hasMultipleImages
    ? Math.sign(overflow.x) * Math.max(0, Math.abs(overflow.x) - transferThreshold) : 0;
  const dismissY = axis === 'y' ? Math.max(0, overflow.y - transferThreshold) : 0;
  const dismiss = getImageViewerDismissStyle(dismissY, geometry.viewport.height);
  return {
    transform,
    axis,
    galleryX: clamp(galleryX, -geometry.viewport.width, geometry.viewport.width),
    dismissY,
    dismissX: dismissY > 0 ? delta.x * IMAGE_VIEWER_DISMISS_X_FOLLOW : 0,
    dismissScale: dismiss.scale,
    backdropOpacity: dismiss.opacity,
  };
};

export type ImageViewerPointerSample = ImageViewerPoint & { time: number };

export const IMAGE_VIEWER_VELOCITY_WINDOW_MS = 100;

/** Release velocity in px/ms from the recent sample window, not just the last pointer event. */
export const estimateImageViewerVelocity = (samples: readonly ImageViewerPointerSample[]): ImageViewerPoint => {
  const last = samples[samples.length - 1];
  if (!last) return { x: 0, y: 0 };
  const first = samples.find((sample) => last.time - sample.time <= IMAGE_VIEWER_VELOCITY_WINDOW_MS) ?? last;
  const elapsed = last.time - first.time;
  return elapsed > 0 ? { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed } : { x: 0, y: 0 };
};

export const IMAGE_VIEWER_DOUBLE_TAP_MS = 280;
export const IMAGE_VIEWER_DOUBLE_TAP_DISTANCE = 32;
export const IMAGE_VIEWER_DOUBLE_TAP_SCALE = 2;

export const isImageViewerDoubleTap = (
  previous: ImageViewerPointerSample | null,
  current: ImageViewerPointerSample,
): boolean => previous !== null
  && current.time - previous.time <= IMAGE_VIEWER_DOUBLE_TAP_MS
  && Math.hypot(current.x - previous.x, current.y - previous.y) <= IMAGE_VIEWER_DOUBLE_TAP_DISTANCE;

export const resolveImageViewerDragRelease = (
  frame: ImageViewerDragFrame,
  velocity: ImageViewerPoint,
  viewport: ImageViewerSize,
): 'none' | 'previous' | 'next' | 'close' => {
  const distance = Math.abs(frame.galleryX);
  if (distance >= Math.min(96, viewport.width * 0.22)
    || (distance > 18 && Math.abs(velocity.x) > 0.55 && velocity.x * frame.galleryX > 0)) {
    return frame.galleryX < 0 ? 'next' : 'previous';
  }
  if (frame.dismissY >= Math.min(140, viewport.height * 0.18)
    || (frame.dismissY > 48 && velocity.y > 0.65)) return 'close';
  return 'none';
};

export const pinchImageViewer = (
  start: ImageViewerTransform,
  initialMidpoint: ImageViewerPoint,
  currentMidpoint: ImageViewerPoint,
  nextScale: number,
  viewportCenter: ImageViewerPoint,
  geometry: ImageViewerGeometry,
): ImageViewerTransform => {
  const scale = clamp(
    nextScale,
    geometry.minScale ?? IMAGE_VIEWER_MIN_SCALE,
    geometry.maxScale ?? IMAGE_VIEWER_MAX_SCALE,
  );
  const ratio = scale / start.scale;

  return clampImageViewerTransform({
    scale,
    x: currentMidpoint.x - viewportCenter.x
      - (initialMidpoint.x - viewportCenter.x - start.x) * ratio,
    y: currentMidpoint.y - viewportCenter.y
      - (initialMidpoint.y - viewportCenter.y - start.y) * ratio,
  }, geometry);
};
