import { useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type RefObject } from 'react';
import { useEvent } from '@reactuses/core';
import { spring } from 'motion';
import { animate as animateMini } from 'motion/mini';
import { HEIGHT_SNAP_OVERSHOOT, releaseHeightVelocity, resistHeight, resolveHeightSnap, sampleHeight, type HeightSample } from './heightSnapPhysics';

export type HeightSnapPoint<T> = { id: T; height: number };

export function useHeightSnap<T>({ surfaceRef, initialPoint, getPoints, minimumHeight, onRelease, onCommit, renderMode = 'height' }: {
  surfaceRef: RefObject<HTMLElement | null>;
  initialPoint: T;
  getPoints: () => readonly HeightSnapPoint<T>[];
  minimumHeight?: number;
  onRelease?: (height: number, velocity: number, startHeight: number) => boolean;
  onCommit?: (point: T) => void;
  renderMode?: 'height' | 'translate';
}) {
  const [snapPoint, setSnapPoint] = useState(initialPoint);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const pointRef = useRef(initialPoint);
  const drag = useRef<{
    pointerId: number; startY: number; height: number; point: T;
    points: readonly HeightSnapPoint<T>[]; handle: HTMLDivElement;
    minimum: number; maximum: number; samples: HeightSample[];
  } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const animation = useRef<ReturnType<typeof animateMini> | null>(null);
  const moved = useRef(false);
  const visual = useRef<{
    layoutHeight: number;
    styles: Pick<CSSStyleDeclaration, 'maxHeight' | 'position' | 'bottom' | 'left' | 'right'>;
  } | null>(null);

  const readHeight = useEvent(() => {
    const surface = surfaceRef.current;
    if (!surface) return 0;
    if (!visual.current) return surface.getBoundingClientRect().height;
    const offset = parseFloat(getComputedStyle(surface).translate.split(' ')[1]) || 0;
    return visual.current.layoutHeight - offset;
  });
  const writeHeight = useEvent((height: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (visual.current) surface.style.translate = `0 ${visual.current.layoutHeight - height}px`;
    else surface.style.height = `${height}px`;
  });
  const prepareVisual = useEvent((height: number, points: readonly HeightSnapPoint<T>[]) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (renderMode === 'translate' && !visual.current) {
      const layoutHeight = Math.max(...points.map((point) => point.height)) + HEIGHT_SNAP_OVERSHOOT * 3;
      const { maxHeight, position, bottom, left, right } = surface.style;
      visual.current = { layoutHeight, styles: { maxHeight, position, bottom, left, right } };
      // A flex item taller than its viewport shrinks and loses its bottom anchor.
      // Keep the frozen canvas bottom-anchored while translate owns visible height.
      Object.assign(surface.style, { position: 'absolute', bottom: '0px', left: '0px', right: '0px' });
      surface.style.maxHeight = 'none';
      surface.style.height = `${layoutHeight}px`;
    }
    surface.setAttribute('data-height-snap-active', '');
    surface.style.willChange = visual.current ? 'translate' : 'height';
    writeHeight(height);
  });
  const finishVisual = useEvent(() => {
    const surface = surfaceRef.current;
    if (surface) {
      if (visual.current) {
        surface.style.translate = '';
        Object.assign(surface.style, visual.current.styles);
        surface.style.height = '';
      }
      surface.style.willChange = '';
      surface.removeAttribute('data-height-snap-active');
    }
    visual.current = null;
  });

  const cancelMotion = useEvent(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
    animation.current?.cancel();
    animation.current = null;
  });
  const releaseCapture = useEvent(() => {
    const active = drag.current;
    drag.current = null;
    if (active?.handle.hasPointerCapture?.(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
  });
  const settleAt = useEvent((point: T, fromHeight?: number, animate = true, velocity = 0) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const start = fromHeight ?? readHeight();
    cancelMotion();
    // Preserve the visible frame, then measure without a WAAPI height overriding it.
    writeHeight(start);
    const points = getPoints();
    const target = points.find((entry) => entry.id === point);
    if (!target) return;
    prepareVisual(start, points);
    releaseCapture();
    setDragging(false);
    setSettling(false);
    pointRef.current = point;
    setSnapPoint(point);
    writeHeight(target.height);
    onCommit?.(point);
    if (!animate || Math.abs(start - target.height) < 1 || typeof surface.animate !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishVisual();
      return;
    }
    setSettling(true);
    const layoutHeight = visual.current?.layoutHeight;
    const distance = target.height - start;
    const current = animateMini([surface], layoutHeight === undefined
      ? { height: [`${start}px`, `${target.height}px`] }
      : { translate: [`0 ${layoutHeight - start}px`, `0 ${layoutHeight - target.height}px`] }, {
      type: spring, stiffness: 576, damping: 48, mass: 1,
      // Unit-bearing keyframes need velocity in Motion's 0–100 progress space.
      // Translate reverses both displacement and velocity, leaving this ratio unchanged.
      velocity: velocity * 1000 * 100 / distance,
      restDelta: 0.2 * 100 / Math.abs(distance), restSpeed: 5 * 100 / Math.abs(distance),
    });
    animation.current = current;
    void current.finished.catch(() => undefined).then(() => {
      if (animation.current !== current) return;
      animation.current = null;
      finishVisual();
      setSettling(false);
    });
  });
  const handlePointerDown = useEvent((event: PointerEvent<HTMLDivElement>) => {
    if (drag.current || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const height = readHeight();
    cancelMotion();
    writeHeight(height);
    const points = getPoints();
    if (!points.length) return;
    setSettling(false);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, height, point: pointRef.current, points, handle: event.currentTarget,
      minimum: minimumHeight ?? Math.min(...points.map((point) => point.height)),
      maximum: Math.max(...points.map((point) => point.height)), samples: [{ height, time: event.timeStamp }] };
    moved.current = false;
    prepareVisual(height, points);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  const handlePointerMove = useEvent((event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = active.startY - event.clientY;
    if (Math.abs(delta) > 3) moved.current = true;
    sampleHeight(active.samples, active.height + delta, event.timeStamp);
    const resisted = resistHeight(active.height + delta, active.minimum, active.maximum);
    pending.current = renderMode === 'height' ? Math.max(active.minimum, resisted) : resisted;
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current !== null) writeHeight(pending.current);
    });
    event.preventDefault();
  });
  const finish = useEvent((event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const height = pending.current ?? readHeight();
    const rawHeight = active.height + active.startY - event.clientY;
    if (!cancelled) sampleHeight(active.samples, rawHeight, event.timeStamp);
    const velocity = cancelled ? 0 : releaseHeightVelocity(active.samples, event.timeStamp);
    releaseCapture();
    if (!cancelled && moved.current && onRelease?.(height, velocity, active.height)) {
      cancelMotion();
      setDragging(false);
      if (surfaceRef.current) surfaceRef.current.style.willChange = '';
    } else {
      const target = cancelled || !moved.current ? active.point
        : resolveHeightSnap(active.points, active.point, height, velocity, rawHeight - active.height);
      settleAt(target, height, true, velocity);
    }
    event.preventDefault();
  });
  const step = useEvent((direction: number) => {
    const points = [...getPoints()].sort((a, b) => a.height - b.height);
    const current = points.find((entry) => entry.id === pointRef.current);
    if (!current) return;
    const next = direction > 0
      ? points.find((entry) => entry.height > current.height + 1)
      : points.sort((a, b) => b.height - a.height).find((entry) => entry.height < current.height - 1);
    if (next) settleAt(next.id);
  });
  const handleClick = useEvent(() => {
    if (moved.current) { moved.current = false; return; }
    const points = [...getPoints()].sort((a, b) => a.height - b.height);
    if (pointRef.current === points.at(-1)?.id) settleAt(points[0].id);
    else step(1);
  });
  const handleKeyDown = useEvent((event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const points = [...getPoints()].sort((a, b) => a.height - b.height);
    if (!points.length) return;
    if (event.key === 'ArrowUp') step(1);
    else if (event.key === 'ArrowDown') step(-1);
    else if (event.key === 'Home') settleAt(points.at(-1)!.id);
    else if (event.key === 'End') settleAt(points[0].id);
    else handleClick();
  });
  const reset = useEvent(() => {
    cancelMotion();
    releaseCapture();
    finishVisual();
    pointRef.current = initialPoint;
    setSnapPoint(initialPoint);
    setDragging(false);
    setSettling(false);
    moved.current = false;
    if (surfaceRef.current) {
      surfaceRef.current.style.height = '';
      surfaceRef.current.style.willChange = '';
    }
  });
  useLayoutEffect(() => () => { cancelMotion(); releaseCapture(); finishVisual(); }, [cancelMotion, releaseCapture, finishVisual]);
  return {
    snapPoint, dragging, settling, settleAt, reset,
    handlePointerDown, handlePointerMove,
    handlePointerUp: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, false)),
    handlePointerCancel: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, true)),
    handleLostPointerCapture: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, true)),
    handleClick, handleKeyDown,
  };
}
