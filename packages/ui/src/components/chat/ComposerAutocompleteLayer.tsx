import React from 'react';
import { createPortal } from 'react-dom';
import { composerAutocompleteSurfaceClassName } from './composerAutocompleteChrome';
import { useMobileAutocompleteFixedBox } from './useMobileAutocompleteMaxHeight';

type ComposerAutocompleteLayerProps = {
  isMobile: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

/**
 * Desktop: in-flow `absolute bottom-full` panel.
 * Phone: viewport-fixed host portaled to `document.body` so CSS `bottom` is
 * measured against the layout viewport. Portaling into the chat column kept
 * the panel under transformed ancestors (session swipe / shell), and using
 * the visual-viewport bottom for `bottom` parked catalogs under the Android
 * IME on small screens. iOS WebKit also cannot frost the transcript from an
 * `absolute` child of `.oc-mobile-composer` (`will-change: transform`).
 */
export const ComposerAutocompleteLayer = React.forwardRef<HTMLDivElement, ComposerAutocompleteLayerProps>(({
  isMobile,
  className,
  style,
  children,
}, forwardedRef) => {
  const probeRef = React.useRef<HTMLSpanElement>(null);
  const box = useMobileAutocompleteFixedBox(probeRef, isMobile);
  const portalHost = typeof document !== 'undefined' ? document.body : null;

  if (!isMobile) {
    return (
      <div
        ref={forwardedRef}
        className={composerAutocompleteSurfaceClassName(false, className)}
        style={style}
      >
        {children}
      </div>
    );
  }

  const panel = (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      <div
        ref={forwardedRef}
        className={composerAutocompleteSurfaceClassName(true, className)}
        style={{
          ...style,
          ...(box
            ? {
                left: box.left,
                width: box.width,
                bottom: box.bottom,
                maxHeight: box.maxHeight,
                overflow: 'hidden',
              }
            : { visibility: 'hidden' as const }),
        }}
      >
        {children}
      </div>
    </div>
  );

  return (
    <>
      <span ref={probeRef} className="hidden" aria-hidden />
      {portalHost ? createPortal(panel, portalHost) : panel}
    </>
  );
});

ComposerAutocompleteLayer.displayName = 'ComposerAutocompleteLayer';
