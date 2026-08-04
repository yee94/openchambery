/**
 * Base UI Menu treats keyboard/imperative opens as non-click-like, so a
 * floating `mouseleave` emits `trigger-hover` and closes the menu. Searchable
 * model/agent pickers never open on hover; cancel that dismiss path so filter
 * typing (list shrink under the cursor) or IME candidate UI does not wipe the
 * popup.
 */
export function shouldCancelSearchableSelectorHoverDismiss(
  nextOpen: boolean,
  reason: string | undefined,
): boolean {
  return !nextOpen && reason === 'trigger-hover';
}
