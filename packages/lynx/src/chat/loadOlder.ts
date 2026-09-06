/**
 * Mobile load-older affordance — button only, never bounce infinite scroll.
 * Mirrors packages/ui chatContainerHost resolveMobileLoadOlder*.
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

export function shouldIgnoreScrollLoadOlder(trigger: 'button' | 'bounce' | 'scroll-top'): boolean {
  return trigger !== 'button';
}
