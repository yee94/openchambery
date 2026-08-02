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
