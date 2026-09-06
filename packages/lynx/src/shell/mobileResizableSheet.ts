/**
 * Cap MobileResizableSheet spirit for Lynx overlays.
 *
 * Cap: bottom sheet @ ~72dvh collapsed / ~98dvh expanded, snap grabber,
 * vertical dismiss past threshold, scrim close.
 * Lynx: half-height default, expandable, grabber + scrim + vertical-drag spirit
 * (touch on grabber). Not nested under GlassChrome contentView.
 */

export const LYNX_MOBILE_SHEET_HALF_HEIGHT_FRACTION = 0.5;
export const LYNX_MOBILE_SHEET_EXPANDED_HEIGHT_FRACTION = 0.92;
/** Cap `DEFAULT_DISMISS_THRESHOLD_PX` spirit. */
export const LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX = 64;

export const LYNX_MOBILE_RESIZABLE_SHEET = {
  placement: 'bottom-overlay' as const,
  /** Replaces full-screen `surface.background` page overlays. */
  fullScreenOpaque: false as const,
  halfHeightFraction: LYNX_MOBILE_SHEET_HALF_HEIGHT_FRACTION,
  expandedHeightFraction: LYNX_MOBILE_SHEET_EXPANDED_HEIGHT_FRACTION,
  grabber: true as const,
  dismissVertical: true as const,
  dismissOnScrim: true as const,
  dismissThresholdPx: LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX,
  /** Sheets stay outside LynxComposerGlassCard / GlassChrome contentView. */
  insideGlassContentView: false as const,
} as const;

export type LynxMobileSheetSnap = 'half' | 'expanded';

export const resolveLynxMobileSheetHeightPercent = (
  snap: LynxMobileSheetSnap,
): string => {
  const fraction = snap === 'expanded'
    ? LYNX_MOBILE_SHEET_EXPANDED_HEIGHT_FRACTION
    : LYNX_MOBILE_SHEET_HALF_HEIGHT_FRACTION;
  return `${Math.round(fraction * 100)}%`;
};

export const toggleLynxMobileSheetSnap = (
  snap: LynxMobileSheetSnap,
): LynxMobileSheetSnap => (snap === 'half' ? 'expanded' : 'half');

/**
 * Cap vertical dismiss: drag down from grabber past threshold while at half
 * (or any snap) → dismiss. Positive deltaY = finger moved down.
 */
export const shouldDismissLynxMobileSheetDrag = (
  deltaY: number,
  thresholdPx: number = LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX,
): boolean => deltaY >= thresholdPx;

export const LYNX_MOBILE_RESIZABLE_SHEET_NOTES = [
  'Bottom half-height sheet with grabber — not full-screen surface.background.',
  'Scrim tap + vertical drag-down on grabber dismiss (Cap MobileResizableSheet spirit).',
  'Grabber tap toggles half ↔ expanded; close control always available.',
  'Reuse for Agent/model pickers and other cheap overlays (e.g. DirectoryExplorer).',
  'Keep outside GlassChrome contentView; autocomplete stays ABOVE glass.',
  'Linux JS wiring — live UIGlassEffect / 真机 drag feel still residual. NOT DONE.',
] as const;
