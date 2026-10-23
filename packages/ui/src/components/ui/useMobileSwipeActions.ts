import * as React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';

const INTENT_LOCK_PX = 10;
// Keep the homepage event so session and contact rows share one revealed rail.
const REVEALED_ROW_EVENT = 'oc:mobile-session-row-revealed';
const broadcastRowRevealed = (id: string) => {
  window.dispatchEvent(new CustomEvent(REVEALED_ROW_EVENT, { detail: id }));
};
type ActiveGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  actionWidth: number;
  intent: 'pending' | 'horizontal' | 'vertical';
};

/** Homepage left-swipe behavior, shared by sessions and Assistant contacts. */
export function useMobileSwipeActions(id: string, onSelect: () => void, disabled = false) {
  const [offset, setOffset] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const gestureRef = React.useRef<ActiveGesture | null>(null);
  const suppressClickRef = React.useRef(false);
  const actionRailRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!disabled) return;
    gestureRef.current = null;
    suppressClickRef.current = true;
    setOffset(0);
    setDragging(false);
  }, [disabled]);
  React.useEffect(() => {
    setOffset(0);
  }, [id]);
  useEventListener(REVEALED_ROW_EVENT, (event: Event) => {
    if ((event as CustomEvent<string>).detail !== id) setOffset(0);
  });
  const closeActions = useEvent(() => setOffset(0));
  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    // Swipe reveal is touch/pen only — mouse drag on desktop left residual
    // offsets that painted Pin/Archive over the title.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const actionWidth = actionRailRef.current?.offsetWidth ?? 0;
    if (actionWidth <= 0) return;
    gestureRef.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startOffset: offset, actionWidth, intent: 'pending',
    };
    suppressClickRef.current = false;
  });
  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (gesture.intent === 'pending') {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absY > INTENT_LOCK_PX && absY > absX) {
        gesture.intent = 'vertical';
        gestureRef.current = null;
        return;
      }
      if (absX > INTENT_LOCK_PX && absX > absY) {
        gesture.intent = 'horizontal';
        setDragging(true);
        suppressClickRef.current = true;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Some embedded webviews can report a pointer after capture was
          // already released. The row can still finish from the same target.
        }
        broadcastRowRevealed(id);
      }
    }
    if (gesture.intent !== 'horizontal') return;
    event.preventDefault();
    setOffset(Math.max(-gesture.actionWidth, Math.min(0, gesture.startOffset + deltaX)));
  });
  const finishGesture = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.intent !== 'horizontal') return;
    setDragging(false);
    setOffset((current) => current < -(gesture.actionWidth * 0.35) ? -gesture.actionWidth : 0);
  });
  const handlePointerCancel = useEvent(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragging(false);
    setOffset(gesture?.startOffset ?? 0);
  });
  const handleSelect = useEvent(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (offset !== 0) { closeActions(); return; }
    broadcastRowRevealed(id);
    onSelect();
  });
  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return {
    offset, dragging, actionRailRef, closeActions, handleSelect,
    handlePointerDown, handlePointerMove, finishGesture, handlePointerCancel, handleContextMenu,
  };
}
