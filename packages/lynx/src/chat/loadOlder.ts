/**
 * Mobile load-older affordance — button only, never bounce infinite scroll.
 * Mirrors packages/ui chatContainerHost resolveMobileLoadOlder*.
 *
 * Polish vs Cap:
 * - Busy disables re-entry (button opacity / ignore).
 * - Scroll-top and bounce triggers are hard-ignored.
 * - Prepend settle is owned by timelineModel (`prependSettling`); the button
 *   must not fire while settle is active if the caller passes that flag.
 */

export const resolveLynxLoadOlderVisibility = (input: {
  canLoadEarlier: boolean;
  isLoadingOlder: boolean;
}): boolean => input.canLoadEarlier || input.isLoadingOlder;

export const resolveLynxLoadOlderBusy = (input: {
  isLoadingOlder: boolean;
}): boolean => input.isLoadingOlder;

/** Hard forbid: scroll/bounce must not trigger older fetches on mobile Lynx. */
export const LYNX_FORBID_BOUNCE_INFINITE_LOAD = true as const;

export type LynxLoadOlderTrigger = 'button' | 'bounce' | 'scroll-top';

export function shouldIgnoreScrollLoadOlder(trigger: LynxLoadOlderTrigger): boolean {
  return trigger !== 'button';
}

/**
 * Cap mobile gate: whether the load-older button may accept a tap.
 * Rejects while busy, while prepend is settling (MVCP restore), or when
 * there is no earlier page.
 */
export const canAcceptLynxLoadOlderTap = (input: {
  canLoadEarlier: boolean;
  isLoadingOlder: boolean;
  prependSettling?: boolean;
}): boolean => {
  if (!input.canLoadEarlier) return false;
  if (input.isLoadingOlder) return false;
  if (input.prependSettling) return false;
  return true;
};

/** Label key helper for busy vs idle (i18n keys live in catalog). */
export const resolveLynxLoadOlderLabelKind = (input: {
  isLoadingOlder: boolean;
}): 'busy' | 'idle' => (input.isLoadingOlder ? 'busy' : 'idle');
