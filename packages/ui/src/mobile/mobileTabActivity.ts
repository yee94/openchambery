export type MobileTabMark = 'unread' | 'loading';

/**
 * Dock marks are mutually exclusive. Unread messages win; a loading badge
 * appears only when that tab has nothing unread and work is still running.
 */
export function resolveMobileTabMark(input: {
  unreadCount: number;
  working: boolean;
}): MobileTabMark | null {
  if (input.unreadCount > 0) return 'unread';
  if (input.working) return 'loading';
  return null;
}
