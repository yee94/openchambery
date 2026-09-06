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

const resolvePortalHost = (origin: HTMLElement | null): Element | null => {
  if (!origin) return null;
  return origin.closest('.oc-chat-composer-swap-scope')
    ?? origin.closest('main');
};

/**
 * Desktop: in-flow `absolute bottom-full` panel.
 * Phone: viewport-fixed host, portaled out of the composer (same stacking as
 * the context metadata sheet). iOS WebKit will not frost the transcript from
 * inside `.oc-mobile-composer` — Capacitor keeps `will-change: transform` on
 * that node, which both traps `position: fixed` and clips backdrop-filter.
 */
export const ComposerAutocompleteLayer = React.forwardRef<HTMLDivElement, ComposerAutocompleteLayerProps>(({
  isMobile,
  className,
  style,
  children,
}, forwardedRef) => {
  const probeRef = React.useRef<HTMLSpanElement>(null);
  const [portalHost, setPortalHost] = React.useState<Element | null>(null);
  const box = useMobileAutocompleteFixedBox(probeRef, isMobile);

  React.useLayoutEffect(() => {
    if (!isMobile) {
      setPortalHost(null);
      return;
    }
    setPortalHost(resolvePortalHost(probeRef.current?.parentElement ?? null));
  }, [isMobile]);

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
