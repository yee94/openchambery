import React from 'react';

/**
 * Cap mobile autocomplete popups at 40% of the visual viewport so long
 * command/skill/file lists stay scrollable without covering the whole chat
 * area (and blocking the sticky session header / top items).
 */
export const MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO = 0.4;
/** Soft floor used only when the chat-header budget already has room for it. */
export const MOBILE_AUTOCOMPLETE_MIN_HEIGHT = 120;
const MOBILE_AUTOCOMPLETE_GAP_PX = 8;

/**
 * Pure height clamp for mobile autocomplete popups anchored above the
 * composer. Prefer the smaller of (space up to the chat boundary) and
 * (40% of the visual viewport height). Never exceed the boundary budget —
 * the min-height floor is soft and only applies when space allows.
 */
export const computeMobileAutocompleteMaxHeight = (args: {
  popupBottom: number;
  boundaryTop: number;
  viewportHeight: number;
  gap?: number;
}): number => {
  const gap = args.gap ?? MOBILE_AUTOCOMPLETE_GAP_PX;
  const available = Math.max(0, args.popupBottom - args.boundaryTop - gap);
  const viewportCap = args.viewportHeight * MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO;
  const capped = Math.floor(Math.min(available, viewportCap));
  if (available >= MOBILE_AUTOCOMPLETE_MIN_HEIGHT) {
    return Math.min(available, Math.max(MOBILE_AUTOCOMPLETE_MIN_HEIGHT, capped));
  }
  return capped;
};

/**
 * Resolve the upper boundary for a mobile autocomplete popup.
 *
 * Phone chat uses an overlay `.oc-mobile-detail-navigation` that floats above
 * the chat `<main>`, so `main.top` alone is under the header and lets the
 * popup cover un-tappable chrome. Prefer that header's bottom edge when
 * present; otherwise fall back to the chat main top.
 */
export const resolveMobileAutocompleteBoundaryTop = (
  container: HTMLElement,
  visualTop = 0,
): number | null => {
  const chatMain = container.closest('main');
  if (!chatMain) return null;

  const screenRoot =
    container.closest('.mobile-chat-screen__content')?.parentElement
    ?? chatMain.parentElement?.closest('main')
    ?? chatMain;
  const overlayHeader = screenRoot.querySelector<HTMLElement>(
    ':scope > .oc-mobile-detail-navigation',
  );
  const headerBottom = overlayHeader?.getBoundingClientRect().bottom;
  const mainTop = chatMain.getBoundingClientRect().top;
  const layoutTop = headerBottom !== undefined
    ? Math.max(headerBottom, mainTop)
    : mainTop;
  return Math.max(layoutTop, visualTop);
};

/**
 * Mobile: clamp an autocomplete popup (anchored above the composer via
 * `bottom-full`) so it never rises past the top of the chat area, and never
 * exceeds 40% of the visual viewport height. On phone shells the floating
 * session header overlays the chat main — its bottom edge is the real upper
 * bound so list items stay tappable.
 *
 * Re-measures on window resizes and when the native keyboard choreography
 * settles (the composer — and therefore the popup's anchor — moves with it).
 *
 * Returns an inline max-height in px, or undefined when disabled. NOTE: the
 * inline value REPLACES any `max-h-*` class (it does not combine).
 */
export const useMobileAutocompleteMaxHeight = (
    containerRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
): number | undefined => {
    const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const measure = () => {
            const el = containerRef.current;
            if (!el) return;
            // Mobile browsers pan the page up to reveal the focused field, so
            // layout tops can sit ABOVE the visible screen (negative client
            // coordinates). visualViewport.offsetTop is in the same client
            // coordinate space and clamps the bound into the visible area.
            const visualViewport = window.visualViewport;
            const visualTop = visualViewport?.offsetTop ?? 0;
            const boundaryTop = resolveMobileAutocompleteBoundaryTop(el, visualTop);
            if (boundaryTop === null) return;
            const viewportHeight = visualViewport?.height ?? window.innerHeight;
            // The popup's bottom edge is its anchor (composer top) and does not
            // depend on its current height.
            const next = computeMobileAutocompleteMaxHeight({
                popupBottom: el.getBoundingClientRect().bottom,
                boundaryTop,
                viewportHeight,
            });
            setMaxHeight((prev) => (prev === next ? prev : next));
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('oc:keyboard-settled', measure);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('oc:keyboard-settled', measure);
            window.visualViewport?.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('scroll', measure);
        };
    });

    return enabled ? maxHeight : undefined;
};
