/**
 * Cap MobileTabPageHeader collapse contract for Lynx root tabs.
 * Layout height stays constant; only compositor-friendly progress changes.
 * See packages/ui/src/components/ui/DOCUMENTATION.md + MobileTabPageHeader.tsx.
 */

/** Scroll distance (px) that maps to full visual collapse. Layout height never changes. */
export const LYNX_TITLE_COLLAPSE_DISTANCE = 48;

/** Expanded title size (rem-equivalent px spirit: 2rem). */
export const LYNX_TITLE_EXPANDED_SIZE = 32;

/** Compact title size next to glass actions (1.25rem). */
export const LYNX_TITLE_COMPACT_SIZE = 20;

/** Compact chrome action row height (2.5rem). */
export const LYNX_COLLAPSING_ACTION_SIZE = 40;

/** Expanded visual offset spacer that scrolls away natively. */
export const LYNX_COLLAPSING_EXPAND_SHIFT = 10;

export type LynxTitleCollapseInput = {
  scrollTop: number;
  /** Cap prefers-reduced-motion: snap to 0 or 1 at 0.5. */
  reducedMotion?: boolean;
};

/**
 * Map scrollTop → [0,1] collapse progress. Never mutates layout box from this value.
 */
export function computeLynxTitleCollapseProgress(input: LynxTitleCollapseInput): number {
  const raw = Math.min(1, Math.max(0, input.scrollTop / LYNX_TITLE_COLLAPSE_DISTANCE));
  if (input.reducedMotion) return raw >= 0.5 ? 1 : 0;
  return raw;
}

export function lynxTitleFontSizeForProgress(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return LYNX_TITLE_EXPANDED_SIZE + (LYNX_TITLE_COMPACT_SIZE - LYNX_TITLE_EXPANDED_SIZE) * t;
}

export function lynxTitleOpacityForProgress(progress: number): number {
  // Cap keeps title readable; slight fade only at full collapse of eyebrow.
  return 1;
}

export function shouldSkipCollapseWrite(previous: number | null, next: number): boolean {
  if (previous === null) return false;
  return Math.abs(previous - next) < 0.001;
}
