import type { MainTab } from '@/stores/useUIStore';

/**
 * Product-level exclusive primary surfaces for the main column.
 *
 * Exactly one primary is active at a time (settings is an exclusive overlay).
 * Session tools (git/diff/files/…) are *not* primaries — they only layer under
 * the session primary.
 */
export type PrimarySurface =
  | 'session'
  | 'schedule'
  | 'assistant'
  | 'settings';

/** Session-scoped tool layers (only valid when primary === session). */
export type SessionTool =
  | 'git'
  | 'diff'
  | 'terminal'
  | 'files'
  | 'context'
  | 'diagram';

export type PrimarySurfaceState = {
  primary: PrimarySurface;
  /** Tool layer under session; null when chat-only or non-session primary. */
  sessionTool: SessionTool | null;
};

const SESSION_TOOLS = new Set<string>([
  'git',
  'diff',
  'terminal',
  'files',
  'context',
  'diagram',
]);

/**
 * Map UI store tab + settings open → exclusive primary.
 * Settings always wins (overlay exclusivity).
 */
export function resolvePrimarySurface(
  activeMainTab: MainTab | string,
  isSettingsOpen: boolean,
): PrimarySurfaceState {
  if (isSettingsOpen) {
    return { primary: 'settings', sessionTool: null };
  }

  // Accept both legacy tab id and product path id during rename.
  if (activeMainTab === 'schedule' || activeMainTab === 'scheduled') {
    return { primary: 'schedule', sessionTool: null };
  }
  if (activeMainTab === 'assistant') {
    return { primary: 'assistant', sessionTool: null };
  }
  if (SESSION_TOOLS.has(activeMainTab)) {
    return { primary: 'session', sessionTool: activeMainTab as SessionTool };
  }

  return { primary: 'session', sessionTool: null };
}

/** True when main column must mount only that surface (no chat keep-alive under it). */
export function isExclusiveFullMainPrimary(primary: PrimarySurface): boolean {
  return primary === 'schedule' || primary === 'assistant';
}

/** Path / store tab id for schedule (product name: schedule, not scheduled). */
export const SCHEDULE_TAB_ID = 'schedule' as const;

/** Legacy MainTab / path segment still accepted on parse only. */
export const LEGACY_SCHEDULE_TAB_ID = 'scheduled' as const;
