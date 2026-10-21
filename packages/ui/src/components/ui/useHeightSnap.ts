import { useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type RefObject } from 'react';
import { useEvent } from '@reactuses/core';

export type HeightSnapPoint<T> = { id: T; height: number };

export function useHeightSnap<T>({ surfaceRef, initialPoint, getPoints, minimumHeight, onRelease, onCommit }: {
  surfaceRef: RefObject<HTMLElement | null>;
  initialPoint: T;
  getPoints: () => readonly HeightSnapPoint<T>[];
  minimumHeight?: number;
  onRelease?: (height: number) => boolean;
  onCommit?: (point: T) => void;
}) {
  const [snapPoint, setSnapPoint] = useState(initialPoint);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const pointRef = useRef(initialPoint);
  const drag = useRef<{
    pointerId: number; startY: number; height: number; point: T;
    points: readonly HeightSnapPoint<T>[]; handle: HTMLDivElement;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);
  const moved = useRef(false);

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
  const settleAt = useEvent((point: T, fromHeight?: number, animate = true) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const start = fromHeight ?? surface.getBoundingClientRect().height;
    cancelMotion();
    // Preserve the visible frame, then measure without a WAAPI height overriding it.
    surface.style.height = `${start}px`;
    const target = getPoints().find((entry) => entry.id === point);
    if (!target) return;
    releaseCapture();
    setDragging(false);
    setSettling(false);
    pointRef.current = point;
    setSnapPoint(point);
    surface.style.height = `${target.height}px`;
    surface.style.willChange = '';
    onCommit?.(point);
    if (!animate || Math.abs(start - target.height) < 1 || typeof surface.animate !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setSettling(true);
    const current = surface.animate([{ height: `${start}px` }, { height: `${target.height}px` }], {
      duration: 180, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both',
    });
    animation.current = current;
    void current.finished.catch(() => undefined).then(() => {
      if (animation.current !== current) return;
      animation.current = null;
      current.cancel();
      setSettling(false);
    });
  });
  const handlePointerDown = useEvent((event: PointerEvent<HTMLDivElement>) => {
    if (drag.current || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const height = surface.getBoundingClientRect().height;
    cancelMotion();
    surface.style.height = `${height}px`;
    const points = getPoints();
    if (!points.length) return;
    setSettling(false);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, height, point: pointRef.current, points, handle: event.currentTarget };
    moved.current = false;
    surface.style.height = `${height}px`;
    surface.style.willChange = 'height';
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  const handlePointerMove = useEvent((event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = active.startY - event.clientY;
    if (Math.abs(delta) > 3) moved.current = true;
    pending.current = Math.max(minimumHeight ?? Math.min(...active.points.map((p) => p.height)),
      Math.min(Math.max(...active.points.map((p) => p.height)), active.height + delta));
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (surfaceRef.current && pending.current !== null) surfaceRef.current.style.height = `${pending.current}px`;
    });
    event.preventDefault();
  });
  const finish = useEvent((event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const height = pending.current ?? surfaceRef.current?.getBoundingClientRect().height ?? active.height;
    releaseCapture();
    if (!cancelled && onRelease?.(height)) {
      cancelMotion();
      setDragging(false);
      if (surfaceRef.current) surfaceRef.current.style.willChange = '';
    } else {
      const nearest = active.points.reduce((best, candidate) =>
        Math.abs(candidate.height - height) < Math.abs(best.height - height) ? candidate : best);
      settleAt(cancelled || !moved.current ? active.point : nearest.id, height);
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
  useLayoutEffect(() => () => { cancelMotion(); releaseCapture(); }, [cancelMotion, releaseCapture]);
  return {
    snapPoint, dragging, settling, settleAt, reset,
    handlePointerDown, handlePointerMove,
    handlePointerUp: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, false)),
    handlePointerCancel: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, true)),
    handleLostPointerCapture: useEvent((event: PointerEvent<HTMLDivElement>) => finish(event, true)),
    handleClick, handleKeyDown,
  };
}
