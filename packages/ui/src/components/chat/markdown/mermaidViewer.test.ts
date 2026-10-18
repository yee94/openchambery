import { describe, expect, test } from 'bun:test';

import {
  fitMermaidViewBox,
  formatMermaidViewBox,
  getMermaidPointerInViewport,
  getMermaidSvgContentBox,
  getMermaidViewerSignature,
  hasMermaidPointerDragMoved,
  MERMAID_BLOCK_SELECTOR,
  normalizeMermaidWheelDelta,
  panMermaidViewBox,
  pinchMermaidViewBox,
  shouldRefreshMermaidViewers,
  zoomMermaidViewBoxAtPoint,
} from './mermaidViewer';

describe('mermaidViewer', () => {
  test('extracts content bounds from the root SVG viewBox', () => {
    expect(getMermaidSvgContentBox({ viewBox: '10 20 400 200', width: '999', height: '999' })).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 200,
    });
  });

  test('falls back to numeric SVG width and height when viewBox is missing', () => {
    expect(getMermaidSvgContentBox({ width: '640', height: '320' })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 320,
    });
  });

  test('accepts bare and px SVG width and height values without parsing unresolved units', () => {
    expect(getMermaidSvgContentBox({ width: '1e3', height: '2.5e2px' })).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 250,
    });

    expect(getMermaidSvgContentBox({ width: '100%', height: '200' })).toBeNull();
    expect(getMermaidSvgContentBox({ width: '100em', height: '200' })).toBeNull();
  });

  test('fits content into a viewport while preserving aspect ratio', () => {
    expect(fitMermaidViewBox({ x: 0, y: 0, width: 400, height: 200 }, { width: 300, height: 300 })).toEqual({
      x: 0,
      y: -100,
      width: 400,
      height: 400,
    });
  });

  test('zooms around a pointer so the SVG point under the pointer stays stable', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 75, y: 150 },
      zoomFactor: 2,
      minScale: 0.5,
      maxScale: 4,
    });

    const before = {
      x: current.x + (75 / 300) * current.width,
      y: current.y + (150 / 300) * current.height,
    };
    const after = {
      x: next.x + (75 / 300) * next.width,
      y: next.y + (150 / 300) * next.height,
    };

    expect(Math.abs(after.x - before.x) < 1e-6).toBe(true);
    expect(Math.abs(after.y - before.y) < 1e-6).toBe(true);
    expect(next).toEqual({ x: 50, y: 100, width: 200, height: 200 });
  });

  test('clamps zoom to the configured viewBox scale bounds', () => {
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: { x: 0, y: 0, width: 400, height: 400 },
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 100,
      minScale: 0.5,
      maxScale: 4,
    });

    expect(next.width).toBe(100);
    expect(next.height).toBe(100);
    expect(next.x).toBe(150);
    expect(next.y).toBe(150);
  });

  test('clamps zoom scale relative to the fitted viewport box', () => {
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: { x: -100, y: 0, width: 400, height: 400 },
      contentBox: { x: 0, y: 0, width: 200, height: 400 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 100,
      minScale: 0.5,
      maxScale: 4,
    });

    expect(next).toEqual({ x: 50, y: 150, width: 100, height: 100 });
  });

  test('returns the current viewBox for invalid zoom scale bounds', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };

    expect(zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 2,
      minScale: 0,
      maxScale: 4,
    })).toBe(current);

    expect(zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 2,
      minScale: 0.5,
      maxScale: Number.POSITIVE_INFINITY,
    })).toBe(current);
  });

  test('formats viewBox numbers without noisy floating point tails', () => {
    expect(formatMermaidViewBox({
      x: 1 / 3,
      y: -2.5,
      width: 100.0000001,
      height: 40,
    })).toBe('0.333333 -2.5 100 40');
  });

  test('pans viewBox by viewport pixel deltas in SVG coordinates', () => {
    expect(panMermaidViewBox({
      currentBox: { x: 10, y: 20, width: 400, height: 200 },
      viewport: { width: 200, height: 100 },
      delta: { x: 25, y: -10 },
    })).toEqual({
      x: -40,
      y: 40,
      width: 400,
      height: 200,
    });
  });

  test('converts client pointer coordinates relative to the viewport origin', () => {
    expect(getMermaidPointerInViewport(
      { clientX: 145, clientY: 96 },
      { left: 120, top: 80 },
    )).toEqual({ x: 25, y: 16 });
  });

  test('normalizes pixel, line, and page wheel deltas to equivalent pixels', () => {
    expect(normalizeMermaidWheelDelta(16, 0, 400)).toBe(16);
    expect(normalizeMermaidWheelDelta(1, 1, 400)).toBe(16);
    expect(normalizeMermaidWheelDelta(1, 2, 16)).toBe(16);
  });

  test('bounds wheel deltas to a finite zoom exponent', () => {
    expect(normalizeMermaidWheelDelta(1e9, 0, 400)).toBe(1000);
    expect(normalizeMermaidWheelDelta(-1e9, 1, 400)).toBe(-1000);
    expect(normalizeMermaidWheelDelta(Number.POSITIVE_INFINITY, 0, 400)).toBe(0);
    expect(normalizeMermaidWheelDelta(1, 2, 0)).toBe(0);
    expect(Math.pow(1.0015, -normalizeMermaidWheelDelta(1e9, 0, 400))).toBeGreaterThan(0);
  });

  test('pinch zoom keeps the SVG point under the moving gesture center stable', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };
    const previousGesture = { center: { x: 100, y: 100 }, distance: 100 };
    const gesture = { center: { x: 125, y: 100 }, distance: 150 };
    const next = pinchMermaidViewBox({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 200, height: 200 },
      previousGesture,
      gesture,
      minScale: 0.5,
      maxScale: 4,
    });

    const svgPointBefore = {
      x: current.x + (previousGesture.center.x / 200) * current.width,
      y: current.y + (previousGesture.center.y / 200) * current.height,
    };
    const svgPointAfter = {
      x: next.x + (gesture.center.x / 200) * next.width,
      y: next.y + (gesture.center.y / 200) * next.height,
    };

    expect(Math.abs(svgPointAfter.x - svgPointBefore.x) < 1e-6).toBe(true);
    expect(Math.abs(svgPointAfter.y - svgPointBefore.y) < 1e-6).toBe(true);
    expect(Math.abs(next.width - (400 / 1.5)) < 1e-6).toBe(true);
    expect(Math.abs(next.height - (400 / 1.5)) < 1e-6).toBe(true);
  });

  test('ignores pinch zoom when either pointer distance is zero', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };

    expect(pinchMermaidViewBox({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 200, height: 200 },
      previousGesture: { center: { x: 100, y: 100 }, distance: 0 },
      gesture: { center: { x: 100, y: 100 }, distance: 100 },
      minScale: 0.5,
      maxScale: 4,
    })).toBe(current);
  });

  test('distinguishes real pointer drag from click jitter', () => {
    expect(hasMermaidPointerDragMoved({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(hasMermaidPointerDragMoved({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
  });

  test('viewer signature changes when SVG identity changes within an existing block', () => {
    const first = getMermaidViewerSignature({
      renderMode: 'svg',
      svgMarkup: '<svg viewBox="0 0 100 50"></svg>',
      viewBox: '0 0 100 50',
      width: null,
      height: null,
    });
    const second = getMermaidViewerSignature({
      renderMode: 'svg',
      svgMarkup: '<svg viewBox="0 0 240 120"></svg>',
      viewBox: '0 0 240 120',
      width: null,
      height: null,
    });

    expect(second).not.toBe(first);
  });

  test('viewer signature distinguishes render mode flips and missing SVGs', () => {
    expect(getMermaidViewerSignature({ renderMode: 'source' })).toBe('source:no-svg');
    expect(getMermaidViewerSignature({ renderMode: 'svg' })).toBe('svg:no-svg');
  });

  test('only requests renderer refresh work for existing mermaid DOM blocks', () => {
    const withoutMermaidBlock = { querySelector: () => null };
    const withMermaidBlock = { querySelector: () => ({}) as Element };

    expect(shouldRefreshMermaidViewers(withoutMermaidBlock)).toBe(false);
    expect(shouldRefreshMermaidViewers(withMermaidBlock)).toBe(true);
  });

  test('exports the shared Mermaid block selector', () => {
    expect(MERMAID_BLOCK_SELECTOR).toBe('[data-markdown="mermaid-block"]');
  });
});
