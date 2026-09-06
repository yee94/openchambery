/**
 * IME / composer occupancy contract for Lynx chat.
 *
 * Cap source: packages/mobile/README.md (Native iOS Composer), pitfalls §3,
 * `packages/mobile/contracts/native-composer-keyboard.mjs`, acceptance
 * "IME occupancy" harness row.
 *
 * ## Who binds IME
 * The **native host** owns keyboard insets and (on iOS) the glass composer
 * overlay. Lynx JS must **not** port WebView keyboard FLIP / `ImeSyncBridge` /
 * cached-height CSS translate hacks (`docs/lynx-pitfalls.md` §3).
 *
 * ## Occupancy = collapsed height only
 * Published occupancy is the **collapsed** composer foot height (Cap:
 * `--oc-native-composer-height`). Expanding the card, showing the keyboard,
 * autocomplete, or the scroll-to-bottom chip must **not** change occupancy, so
 * queue / Changes / TODO stay docked above the collapsed pill.
 *
 * Cap accessory rows use a separate variable (`--oc-native-composer-accessory`)
 * and never write `--oc-chat-foot-inset`. Lynx mirrors that split:
 * - `LYNX_COMPOSER_OCCUPANCY_HEIGHT` — collapsed foot reserved in the list footer
 * - `LYNX_COMPOSER_ACCESSORY_HEIGHT` — queue/status strip above the pill (optional)
 *
 * ## Chinese IME
 * Marked/composition text is first-class: do not rewrite the field during
 * composition (Cap `native-ios-composer.ts` lesson). Host TextField / Lynx
 * input must ignore mid-composition `forceText` clears.
 *
 * ## List semantics
 * Composer inset growth is a **list footer** layout change so
 * `maintainScrollAtEnd.footerLayout` can follow while pinned — never a second
 * scroll view or live overlay.
 *
 * ## Host bridge (expected, not implemented here)
 * Host reports: keyboard overlap, safe-area bottom, collapsed composer height.
 * Lynx applies those as layout constants / CSS vars — no FLIP guess.
 */

/** Collapsed composer foot occupancy in Lynx layout units (logical px). */
export const LYNX_COMPOSER_OCCUPANCY_HEIGHT = 56;

/** Optional queue/status accessory above the collapsed pill — not occupancy. */
export const LYNX_COMPOSER_ACCESSORY_HEIGHT = 0;

/** Cap keyboard gap when resting on home-indicator / keyboard overlap. */
export const LYNX_COMPOSER_KEYBOARD_GAP = 12;

/**
 * Resolve the list footer inset that reserve space for the collapsed composer.
 * Keyboard-open and expanded-card heights must not flow into this value.
 */
export function resolveLynxComposerOccupancyInset(input?: {
  collapsedHeight?: number;
  accessoryHeight?: number;
  /** Explicitly ignored — documenting the forbid. */
  keyboardHeight?: number;
  expanded?: boolean;
}): number {
  const collapsed = input?.collapsedHeight ?? LYNX_COMPOSER_OCCUPANCY_HEIGHT;
  const accessory = input?.accessoryHeight ?? LYNX_COMPOSER_ACCESSORY_HEIGHT;
  // keyboardHeight / expanded intentionally unused — occupancy stays collapsed.
  void input?.keyboardHeight;
  void input?.expanded;
  return Math.max(0, collapsed) + Math.max(0, accessory);
}

export type LynxImeOccupancyContract = {
  hostBindsIme: true;
  forbidWebViewFlip: true;
  occupancyIsCollapsedOnly: true;
  chineseCompositionPassthrough: true;
  listFooterCarriesInset: true;
};

export const LYNX_IME_OCCUPANCY_CONTRACT: LynxImeOccupancyContract = {
  hostBindsIme: true,
  forbidWebViewFlip: true,
  occupancyIsCollapsedOnly: true,
  chineseCompositionPassthrough: true,
  listFooterCarriesInset: true,
};

/**
 * Autocomplete / `/` `@` command list placement (Cap lesson).
 * Must sit ABOVE the glass composer as a sibling — never inside
 * UIGlassEffect.contentView. See composerAutocompleteLayout.ts.
 */
export const LYNX_COMPOSER_AUTOCOMPLETE_ABOVE_GLASS = true as const;
