/**
 * Cap native composer autocomplete layout contract for Lynx.
 *
 * Cap burned on putting the `/` `@` command list inside `UIGlassEffect.contentView`:
 * UILabel titles went invisible under vibrancy, and taps were eaten by glass chrome.
 * The list must sit **ABOVE** the glass composer card as a sibling overlay
 * (card width, ~8pt gap), never as a contentView child.
 *
 * Source: packages/mobile/README.md § Native iOS Composer,
 * packages/mobile/ios/.../OpenChamberComposerAutocomplete.swift,
 * packages/mobile/test/native-composer-contract.test.mjs,
 * docs/lynx-ia-ui.md (Autocomplete list row).
 */

export type LynxComposerAutocompletePlacement = {
  /** Sibling above glass card — never glass contentView child. */
  placement: 'above-glass-composer';
  forbidInsideGlassContentView: true;
  /** Gap between list bottom and glass card top (Cap: 8pt). */
  gapAboveCardPt: number;
  /** Cap computeMobileAutocompleteMaxHeight spirit — fraction of visible column. */
  maxHeightFractionOfVisibleColumn: number;
  /** Occupancy must stay collapsed; popup is not occupancy. */
  countsAsOccupancy: false;
};

export const LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT: LynxComposerAutocompletePlacement = {
  placement: 'above-glass-composer',
  forbidInsideGlassContentView: true,
  gapAboveCardPt: 8,
  maxHeightFractionOfVisibleColumn: 0.4,
  countsAsOccupancy: false,
};

/**
 * Clamp autocomplete max height the Cap way: min(space below header, 40% of
 * keyboard-aware visible column). Host glass overlay uses the same numbers.
 */
export function computeLynxAutocompleteMaxHeight(input: {
  spaceBelowHeader: number;
  visibleColumnHeight: number;
  fraction?: number;
}): number {
  const fraction = input.fraction ?? LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.maxHeightFractionOfVisibleColumn;
  const byColumn = Math.max(0, input.visibleColumnHeight) * fraction;
  const byHeader = Math.max(0, input.spaceBelowHeader);
  return Math.max(0, Math.min(byHeader, byColumn));
}

export const LYNX_COMPOSER_AUTOCOMPLETE_WIRING_NOTES = [
  'Place autocomplete/command list ABOVE glass composer — sibling overlay, not contentView.',
  'Cap: UILabel inside UIGlassEffect contentView was invisible; bitmap titles + table above glass.',
  'Popup is not part of published occupancy (imeOccupancy collapsed-only).',
  'Search/ranking/accept stay on JS channel (composerCatalog); host only paints when Mode B glass overlay owns the field.',
] as const;
