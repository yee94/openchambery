import { describe, expect, test } from 'vitest';
import {
  IMAGE_VIEWER_TAP_MOVE_THRESHOLD,
  clampImageViewerTransform,
  dragImageViewer,
  estimateImageViewerVelocity,
  getFittedImageSize,
  isImageViewerDoubleTap,
  panImageViewer,
  pinchImageViewer,
  resolveImageViewerPointerRelease,
  resolveImageViewerDragRelease,
  zoomImageViewerAtPoint,
} from './imageViewerTransform';

const geometry = {
  image: { width: 800, height: 600 },
  viewport: { width: 800, height: 600 },
};

describe('imageViewerTransform', () => {
  test('fits an image inside the full viewing area', () => {
    expect(getFittedImageSize(
      { width: 1600, height: 900 },
      { width: 800, height: 600 },
    )).toEqual({ width: 800, height: 450 });
  });

  test('clamps scale and pan to reachable image bounds', () => {
    expect(clampImageViewerTransform({ scale: 8, x: 9999, y: -9999 }, geometry)).toEqual({
      scale: 5,
      x: 1600,
      y: -1200,
    });
    expect(clampImageViewerTransform({ scale: 0.2, x: 40, y: 40 }, geometry)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });

  test('keeps the image point beneath the zoom origin', () => {
    expect(zoomImageViewerAtPoint(
      { scale: 1, x: 0, y: 0 },
      2,
      { x: 600, y: 300 },
      { x: 400, y: 300 },
      geometry,
    )).toEqual({ scale: 2, x: -200, y: 0 });
  });

  test('clamps drag movement after zoom', () => {
    expect(panImageViewer(
      { scale: 2, x: 0, y: 0 },
      { x: 1000, y: -1000 },
      geometry,
    )).toEqual({ scale: 2, x: 400, y: -300 });
  });

  test('combines pinch midpoint movement with scale', () => {
    expect(pinchImageViewer(
      { scale: 1, x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 450, y: 320 },
      2,
      { x: 400, y: 300 },
      geometry,
    )).toEqual({ scale: 2, x: 50, y: 20 });
  });

  test('closes a mobile viewer on a single tap at fitted and zoomed scales', () => {
    for (const startScale of [1, 3]) {
      expect(resolveImageViewerPointerRelease({
        isMobile: true,
        pointerType: 'touch',
        cancelled: false,
        moved: false,
        suppressTap: false,
        targetWasCanvas: false,
        start: { x: 120, y: 180 },
        end: { x: 120 + IMAGE_VIEWER_TAP_MOVE_THRESHOLD, y: 180 },
        startScale,
        hasMultipleImages: true,
      })).toBe('close');
    }
  });

  test('excludes drag, pinch, gallery swipe, and pointer cancellation from mobile tap close', () => {
    const base = {
      isMobile: true,
      pointerType: 'touch',
      cancelled: false,
      moved: false,
      suppressTap: false,
      targetWasCanvas: false,
      start: { x: 120, y: 180 },
      end: { x: 120, y: 180 },
      startScale: 1,
      hasMultipleImages: true,
    };

    expect(resolveImageViewerPointerRelease({ ...base, moved: true })).toBe('none');
    expect(resolveImageViewerPointerRelease({ ...base, suppressTap: true })).toBe('none');
    expect(resolveImageViewerPointerRelease({ ...base, cancelled: true })).toBe('none');
    expect(resolveImageViewerPointerRelease({ ...base, end: { x: 50, y: 182 } })).toBe('next');
    expect(resolveImageViewerPointerRelease({ ...base, end: { x: 190, y: 182 } })).toBe('previous');
  });

  test('keeps desktop close scoped to a stationary click on empty canvas', () => {
    const base = {
      isMobile: false,
      pointerType: 'mouse',
      cancelled: false,
      moved: false,
      suppressTap: false,
      start: { x: 120, y: 180 },
      end: { x: 120, y: 180 },
      startScale: 3,
      hasMultipleImages: true,
    };

    expect(resolveImageViewerPointerRelease({ ...base, targetWasCanvas: true })).toBe('close');
    expect(resolveImageViewerPointerRelease({ ...base, targetWasCanvas: false })).toBe('none');
    expect(resolveImageViewerPointerRelease({ ...base, targetWasCanvas: true, moved: true })).toBe('none');
  });
});

describe('image viewer drag handoff', () => {
  const fitted = { scale: 1, x: 0, y: 0 };
  const zoomed = { scale: 2, x: 0, y: 0 };
  const still = { x: 0, y: 0 };

  test('tracks horizontal slides and downward shrink at fitted size', () => {
    const horizontal = dragImageViewer(fitted, { x: -120, y: 5 }, geometry, null, true);
    expect(horizontal.galleryX).toBe(-120);
    expect(horizontal.dismissY).toBe(0);
    expect(horizontal.transform.scale).toBe(1);
    expect(horizontal.transform.x).toBeCloseTo(0);
    expect(horizontal.transform.y).toBeCloseTo(0);
    const down = dragImageViewer(fitted, { x: 5, y: 120 }, geometry, null, true);
    expect(down.galleryX).toBe(0);
    expect(down.dismissY).toBe(120);
    expect(down.dismissScale).toBeLessThan(1);
    expect(down.backdropOpacity).toBeLessThan(1);
  });

  test('large movement inside zoomed image bounds is only pan', () => {
    const frame = dragImageViewer({ scale: 5, x: 0, y: 0 }, { x: 900, y: 200 }, geometry, null, true);
    expect(frame.transform).toEqual({ scale: 5, x: 900, y: 200 });
    expect(frame.galleryX).toBe(0);
    expect(resolveImageViewerDragRelease(frame, { x: 2, y: 2 }, geometry.viewport)).toBe('none');
  });

  test('zoomed image consumes pan and an extra threshold before gallery handoff', () => {
    expect(dragImageViewer(zoomed, { x: 420, y: 0 }, geometry, null, true).galleryX).toBe(0);
    const frame = dragImageViewer(zoomed, { x: 550, y: 0 }, geometry, null, true);
    expect(frame.transform.x).toBe(400);
    expect(frame.galleryX).toBe(118);
    expect(resolveImageViewerDragRelease(frame, still, geometry.viewport)).toBe('previous');
  });

  test('zoomed downward handoff uses overflow, not the full drag distance', () => {
    const within = dragImageViewer(zoomed, { x: 0, y: 320 }, geometry, null, true);
    expect(within.transform.y).toBe(300);
    expect(within.dismissY).toBe(0);
    const overflow = dragImageViewer(zoomed, { x: 0, y: 470 }, geometry, null, true);
    expect(overflow.dismissY).toBe(138);
    expect(resolveImageViewerDragRelease(overflow, still, geometry.viewport)).toBe('close');
  });

  test('does not hand off upwards, without a gallery, or before intent is clear', () => {
    expect(dragImageViewer(fitted, { x: 0, y: -200 }, geometry, null, true).dismissY).toBe(0);
    expect(dragImageViewer(fitted, { x: 200, y: 0 }, geometry, null, false).galleryX).toBe(0);
    expect(dragImageViewer(fitted, { x: 4, y: 6 }, geometry, null, true).axis).toBeNull();
    expect(resolveImageViewerDragRelease(dragImageViewer(fitted, { x: 4, y: 6 }, geometry, null, true), still, geometry.viewport)).toBe('none');
  });

  test('downward diagonals pull to dismiss; a single image always pulls vertically', () => {
    const diagonal = dragImageViewer(fitted, { x: 80, y: 80 }, geometry, null, true);
    expect(diagonal.axis).toBe('y');
    expect(diagonal.dismissY).toBe(80);
    expect(diagonal.dismissX).toBe(20);
    expect(dragImageViewer(fitted, { x: 120, y: 40 }, geometry, null, true).axis).toBe('x');
    expect(dragImageViewer(fitted, { x: 120, y: 40 }, geometry, null, false).axis).toBe('y');
  });

  test('zoomed axis is decided by the first edge pushed past its handoff threshold', () => {
    expect(dragImageViewer(zoomed, { x: 300, y: 300 }, geometry, null, true).axis).toBeNull();
    expect(dragImageViewer(zoomed, { x: 300, y: 350 }, geometry, null, true).axis).toBe('y');
  });

  test('release velocity uses the recent sample window', () => {
    expect(estimateImageViewerVelocity([{ x: 0, y: 0, time: 0 }, { x: 50, y: 10, time: 50 }, { x: 100, y: 20, time: 100 }])).toEqual({ x: 1, y: 0.2 });
    expect(estimateImageViewerVelocity([{ x: 0, y: 0, time: 0 }, { x: 100, y: 0, time: 300 }])).toEqual({ x: 0, y: 0 });
  });

  test('double tap requires a quick nearby second tap', () => {
    const first = { x: 100, y: 100, time: 0 };
    expect(isImageViewerDoubleTap(first, { x: 110, y: 104, time: 200 })).toBe(true);
    expect(isImageViewerDoubleTap(first, { x: 110, y: 104, time: 400 })).toBe(false);
    expect(isImageViewerDoubleTap(first, { x: 180, y: 100, time: 200 })).toBe(false);
    expect(isImageViewerDoubleTap(null, first)).toBe(false);
  });

  test('locks direction and restores all transient transforms when reversing', () => {
    expect(dragImageViewer(fitted, { x: 200, y: 300 }, geometry, 'x', true).dismissY).toBe(0);
    const reversed = dragImageViewer(fitted, still, geometry, 'y', true);
    expect(reversed.dismissScale).toBe(1);
    expect(reversed.backdropOpacity).toBe(1);
    expect(resolveImageViewerDragRelease(reversed, { x: 0, y: -2 }, geometry.viewport)).toBe('none');
  });

  test('short drags rebound; quick flicks only commit in their current direction', () => {
    const frame = dragImageViewer(fitted, { x: -40, y: 0 }, geometry, 'x', true);
    expect(resolveImageViewerDragRelease(frame, still, geometry.viewport)).toBe('none');
    expect(resolveImageViewerDragRelease(frame, { x: -0.8, y: 0 }, geometry.viewport)).toBe('next');
    expect(resolveImageViewerDragRelease(frame, { x: 0.8, y: 0 }, geometry.viewport)).toBe('none');
    const down = dragImageViewer(fitted, { x: 0, y: 60 }, geometry, 'y', true);
    expect(resolveImageViewerDragRelease(down, still, geometry.viewport)).toBe('none');
    expect(resolveImageViewerDragRelease(down, { x: 0, y: 1 }, geometry.viewport)).toBe('close');
  });
});
