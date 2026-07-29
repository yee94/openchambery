/**
 * Composer keyboard lift targeting.
 *
 * Capacitor Android (and iOS early intent) only raise the bottom chat composer
 * via transform FLIP. Non-composer fields (question cards, settings, overlays)
 * must not arm that path — they either sit in a scroll region or use the
 * overlay inset surface.
 */

export const COMPOSER_KEYBOARD_LIFT_SELECTOR = '.oc-mobile-composer';

export function isComposerKeyboardTarget(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const element = node as { closest?: (selector: string) => Element | null };
  if (typeof element.closest !== 'function') return false;
  return Boolean(element.closest(COMPOSER_KEYBOARD_LIFT_SELECTOR));
}

/** True when a focus move should keep the composer lift armed. */
export function isComposerKeyboardFocusTransfer(
  relatedTarget: EventTarget | null | undefined,
): boolean {
  return isComposerKeyboardTarget(relatedTarget ?? null);
}
