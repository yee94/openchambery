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

export function shouldReserveChatScrollInset(node: unknown): boolean {
  if (!node || typeof node !== 'object' || isComposerKeyboardTarget(node)) return false;
  const element = node as { tagName?: unknown; isContentEditable?: unknown };
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tagName === 'TEXTAREA' || tagName === 'INPUT' || element.isContentEditable === true;
}

/** True when a focus move should keep the composer lift armed. */
export function isComposerKeyboardFocusTransfer(
  relatedTarget: EventTarget | null | undefined,
): boolean {
  return isComposerKeyboardTarget(relatedTarget ?? null);
}

/**
 * Resolves what a native Android IME state event may do for the composer.
 * An already-armed composer session refreshes its next-open cache only: the
 * active FLIP owns the current keyboard rise from focus through close.
 */
export function getAndroidComposerImeStateAction(
  composerLiftArmed: boolean,
  activeElement: EventTarget | null | undefined,
): 'ignore' | 'cache' | 'open' | 'field' {
  if (composerLiftArmed) return 'cache';
  if (isComposerKeyboardTarget(activeElement ?? null)) return 'open';
  return shouldReserveChatScrollInset(activeElement ?? null) ? 'field' : 'ignore';
}

/**
 * A native measured IME height clearly above the height that armed this
 * session means the estimate under-cleared the keyboard (stale ratio, density
 * pinning, or a different IME silhouette). Correct the in-flight lift instead
 * of leaving the composer covered for the whole keyboard session.
 */
export function shouldCorrectArmedImeLift(armedHeight: number, measuredHeight: number): boolean {
  if (!(measuredHeight > 0)) return false;
  if (!(armedHeight >= 0)) return false;
  return measuredHeight > armedHeight + 24;
}

/** Convert a native WindowInsets IME height (window px) into WebView CSS px. */
export function cssPxFromNativeImeHeight(heightPx: number, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (!(heightPx > 0)) return 0;
  return Math.max(0, Math.round(heightPx / dpr));
}
