import { memo, useLayoutEffect, useRef, type RefObject } from 'react';
import { HeightSnapHandle } from '../ui/HeightSnapHandle';
import { useMobileComposerSnap } from './useMobileComposerSnap';

/** Mounted only for a nonempty web composer; text edits never enter this leaf. */
export const MobileComposerHeightHandle = memo(function MobileComposerHeightHandle({ inputRef, draftID, ariaLabel, onManualHeightChange }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draftID: string | null;
  ariaLabel: string;
  onManualHeightChange: (manual: boolean) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const snap = useMobileComposerSnap({ enabled: true, hasContent: true, draftID, inputRef });
  const { snapPoint, manualHeight, dragging, settling } = snap;

  useLayoutEffect(() => {
    const surface = handleRef.current?.closest<HTMLElement>('[data-mobile-composer-surface]');
    if (surface) {
      surface.dataset.composerHeightSnap = snapPoint;
      surface.toggleAttribute('data-composer-height-manual', manualHeight);
      if (dragging || settling) surface.dataset.mobileComposerResizing = 'true';
      else delete surface.dataset.mobileComposerResizing;
    }
    onManualHeightChange(manualHeight);
  }, [snapPoint, manualHeight, dragging, settling, onManualHeightChange]);

  useLayoutEffect(() => {
    const surface = handleRef.current?.closest<HTMLElement>('[data-mobile-composer-surface]');
    return () => {
      surface?.removeAttribute('data-composer-height-snap');
      surface?.removeAttribute('data-composer-height-manual');
      surface?.removeAttribute('data-mobile-composer-resizing');
      onManualHeightChange(false);
    };
  }, [onManualHeightChange]);

  return <HeightSnapHandle
    ref={handleRef}
    data-mobile-composer-snap-handle
    aria-label={ariaLabel}
    aria-valuemin={0}
    aria-valuemax={2}
    aria-valuenow={snapPoint === 'min' ? 0 : snapPoint === 'auto' ? 1 : 2}
    className="absolute top-0 left-1/2 z-40 h-6 w-20 -translate-x-1/2 items-center"
    onPointerDown={snap.handlePointerDown}
    onPointerMove={snap.handlePointerMove}
    onPointerUp={snap.handlePointerUp}
    onPointerCancel={snap.handlePointerCancel}
    onLostPointerCapture={snap.handleLostPointerCapture}
    onClick={snap.handleClick}
    onKeyDown={snap.handleKeyDown}
  />;
});
