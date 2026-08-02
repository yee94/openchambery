import { describe, expect, test } from 'bun:test';
import {
  IMAGE_VIEWER_TAP_MOVE_THRESHOLD,
  clampImageViewerTransform,
  getFittedImageSize,
  panImageViewer,
  pinchImageViewer,
  resolveImageViewerPointerRelease,
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
