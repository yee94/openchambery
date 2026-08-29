export type ScrollShadowVisibility = 'both' | 'none' | 'top' | 'bottom';

// Subpixel tolerance: on hi-DPI and with fractional scrollTop,
// scrollTop+clientHeight can fall ~0.5px short of scrollHeight at the very end,
// which would otherwise keep the bottom fade visible after fully scrolling.
const SUBPIXEL_TOLERANCE = 1;

export function applyVerticalScrollShadow(
    el: HTMLElement,
    {
        offset = 0,
        hideTopShadow = false,
        hideBottomShadow = false,
    }: {
        offset?: number;
        hideTopShadow?: boolean;
        hideBottomShadow?: boolean;
    } = {},
): ScrollShadowVisibility {
    const hasBefore = el.scrollTop > offset + SUBPIXEL_TOLERANCE;
    let hasAfter = el.scrollHeight - (el.scrollTop + el.clientHeight) > offset + SUBPIXEL_TOLERANCE;
    const effectiveHasBefore = hideTopShadow ? false : hasBefore;
    if (hideBottomShadow) {
        hasAfter = false;
    }

    if (effectiveHasBefore && hasAfter) {
        el.dataset.topBottomScroll = 'true';
        el.removeAttribute('data-top-scroll');
        el.removeAttribute('data-bottom-scroll');
    } else {
        el.dataset.topScroll = String(effectiveHasBefore);
        el.dataset.bottomScroll = String(hasAfter);
        el.removeAttribute('data-top-bottom-scroll');
    }

    return effectiveHasBefore && hasAfter
        ? 'both'
        : effectiveHasBefore
            ? 'top'
            : hasAfter
                ? 'bottom'
                : 'none';
}

export function prepareScrollShadowElement(el: HTMLElement, size = 48): void {
    el.dataset.scrollShadow = 'true';
    el.dataset.orientation = 'vertical';
    el.style.setProperty('--scroll-shadow-size', `${size}px`);
}
