/**
 * Composer occupancy contract (docs/expo-ia-ui.md):
 * Accessories (Changes · queue · chips) dock to the **collapsed pill** only.
 * Expand / scroll-to-bottom / slash autocomplete must NOT raise occupancy.
 */

export type ComposerOccupancyInput = {
  /** Collapsed pill / single-line height from native callback or RN measure. */
  collapsedPillHeight: number;
  /** Growing multiline content height — ignored for occupancy. */
  contentHeight?: number;
  /** Whether the field is focused / expanded card. */
  expanded?: boolean;
  /** Last published rest occupancy while collapsed (frozen during expand). */
  lastRestHeight?: number | null;
  autocompleteOpen?: boolean;
  scrollToBottomVisible?: boolean;
};

export type ComposerOccupancyChrome = {
  /** Native collapsed line height (UITextView single-line token). */
  collapsedLineHeight: number;
  /** Vertical padding of GlassComposerShell / solid pill around the field. */
  pillVerticalPadding: number;
  /** Optional attach/send chrome that sits in the same row (usually 0 — row height = max). */
  rowExtra?: number;
};

/** Build collapsed pill height from native line height + RN chrome padding. */
export function composeCollapsedPillHeight(chrome: ComposerOccupancyChrome): number {
  const line = Math.max(0, chrome.collapsedLineHeight);
  const pad = Math.max(0, chrome.pillVerticalPadding);
  const extra = Math.max(0, chrome.rowExtra ?? 0);
  return line + pad + extra;
}

/**
 * Publish occupancy for accessories.
 * Always returns collapsed pill height — expand/autocomplete/scroll are ignored.
 * While expanded, prefer lastRestHeight so queue/changes stay put (Cap parity).
 */
export function resolveComposerOccupancyHeight(input: ComposerOccupancyInput): number {
  const collapsed = Math.max(0, input.collapsedPillHeight);
  if (input.expanded && typeof input.lastRestHeight === 'number' && input.lastRestHeight >= 0) {
    return input.lastRestHeight;
  }
  // contentHeight / autocompleteOpen / scrollToBottomVisible intentionally unused.
  void input.contentHeight;
  void input.autocompleteOpen;
  void input.scrollToBottomVisible;
  return collapsed;
}

/** Next lastRestHeight bookkeeping when a collapsed callback arrives. */
export function nextRestOccupancyHeight(
  collapsedPillHeight: number,
  expanded: boolean,
  lastRestHeight: number | null,
): number {
  const collapsed = Math.max(0, collapsedPillHeight);
  if (expanded && lastRestHeight != null && lastRestHeight >= 0) {
    return lastRestHeight;
  }
  return collapsed;
}
