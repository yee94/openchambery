/**
 * Cap Dialog spirit for Lynx overlays (centered modal, not bottom sheet).
 *
 * Cap `Dialog` / `DialogContent`: fixed scrim (`bg-black/50`) + flex-centered
 * panel (`max-w-md`, `rounded-xl`, `p-6`) — not MobileResizableSheet half-card
 * and not an elevated-in-scroll card.
 * Lynx: absolute inset scrim + centered panel; dismiss on scrim when allowed.
 * Keep outside GlassChrome contentView.
 */

/** Cap DialogContent `max-w-md` (28rem). */
export const LYNX_CENTERED_DIALOG_MAX_WIDTH_PX = 448;

/** Cap DialogContent `rounded-xl` spirit. */
export const LYNX_CENTERED_DIALOG_RADIUS_PX = 12;

/** Cap DialogContent `p-6` / container `p-4`. */
export const LYNX_CENTERED_DIALOG_PANEL_PADDING_PX = 24;
export const LYNX_CENTERED_DIALOG_CONTAINER_PADDING_PX = 16;

/** Cap overlay `bg-black/50`. */
export const LYNX_CENTERED_DIALOG_SCRIM = 'rgba(0,0,0,0.5)';

export const LYNX_CENTERED_DIALOG = {
  placement: 'centered-modal' as const,
  /** Distinguishes from MobileResizableSheet bottom half-card. */
  bottomSheet: false as const,
  /** Distinguishes from elevated-in-scroll / in-sheet cards. */
  elevatedInSheetCard: false as const,
  maxWidthPx: LYNX_CENTERED_DIALOG_MAX_WIDTH_PX,
  radiusPx: LYNX_CENTERED_DIALOG_RADIUS_PX,
  panelPaddingPx: LYNX_CENTERED_DIALOG_PANEL_PADDING_PX,
  containerPaddingPx: LYNX_CENTERED_DIALOG_CONTAINER_PADDING_PX,
  scrim: LYNX_CENTERED_DIALOG_SCRIM,
  dismissOnScrim: true as const,
  /** Overlays stay outside LynxComposerGlassCard / GlassChrome contentView. */
  insideGlassContentView: false as const,
  zIndex: 50 as const,
} as const;

export type LynxCenteredDialogPlacement = typeof LYNX_CENTERED_DIALOG.placement;

/**
 * Cap Dialog open/close: closed → null render; open → scrim+panel.
 * When `busy`, Cap blocks dismiss (e.g. revert-all `isRevertingAll`).
 */
export const shouldAllowLynxCenteredDialogDismiss = (busy: boolean): boolean => !busy;

export const LYNX_CENTERED_DIALOG_NOTES = [
  'Cap Dialog spirit: dimmed scrim + flex-centered panel (max-w-md / rounded-xl) — not half-sheet card.',
  'Not MobileResizableSheet (bottom ~72/98%) and not elevated-in-scroll confirm card.',
  'Scrim tap dismisses when not busy; Cancel always available when not busy.',
  'Reuse for destructive confirms (Changes revert). Cap does not confirm commit&push.',
  'Keep outside GlassChrome contentView. Linux JS wiring — 真机 residual. NOT DONE.',
] as const;
