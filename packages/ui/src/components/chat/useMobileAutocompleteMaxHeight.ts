import React from 'react';

/**
 * Cap mobile autocomplete popups at 40% of the visual viewport so long
 * command/skill/file lists stay scrollable without covering the whole chat
 * area (and blocking the sticky session header / top items).
 */
export const MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO = 0.4;
export const MOBILE_AUTOCOMPLETE_MIN_HEIGHT = 120;
const MOBILE_AUTOCOMPLETE_GAP_PX = 8;

/**
 * Pure height clamp for mobile autocomplete popups anchored above the
 * composer. Prefer the smaller of (space up to the chat boundary) and
 * (40% of the visual viewport height).
 */
export const computeMobileAutocompleteMaxHeight = (args: {
  popupBottom: number;
  boundaryTop: number;
  viewportHeight: number;
  gap?: number;
}): number => {
  const gap = args.gap ?? MOBILE_AUTOCOMPLETE_GAP_PX;
  const available = args.popupBottom - args.boundaryTop - gap;
  const viewportCap = args.viewportHeight * MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO;
  return Math.max(
    MOBILE_AUTOCOMPLETE_MIN_HEIGHT,
    Math.floor(Math.min(available, viewportCap)),
  );
};

/**
 * Mobile: clamp an autocomplete popup (anchored above the composer via
 * `bottom-full`) so it never rises past the top of the chat area, and never
 * exceeds 40% of the visual viewport height. The chat `<main>` starts below
 * the app header in both the Capacitor shell and the mobile browser, so its
 * top edge is the correct upper boundary for both.
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
            const main = el.closest('main');
            if (!main) return;
            // Mobile browsers pan the page up to reveal the focused field, so
            // <main>'s top can sit ABOVE the visible screen (negative client
            // coordinates). The binding boundary is whichever is lower: the
            // chat area's top or the visual viewport's top (its offsetTop is
            // expressed in the same layout-viewport client coordinates).
            const visualViewport = window.visualViewport;
            const visualTop = visualViewport?.offsetTop ?? 0;
            const boundaryTop = Math.max(main.getBoundingClientRect().top, visualTop);
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
