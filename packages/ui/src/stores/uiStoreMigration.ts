/**
 * One-shot default upgrades for ui-store persist versions.
 * Only rewrite known legacy default values; never re-run after the target version.
 */

/** Compact conversation defaults introduced with persist version 12. */
export const COMPACT_CHAT_DEFAULTS_PERSIST_VERSION = 12;

export type CompactChatDefaultsSlice = {
  chatRenderMode?: unknown;
  activityRenderMode?: unknown;
  showTurnChangedFiles?: unknown;
};

/**
 * v11 (and earlier) shipped compact-chat defaults of live / summary / false.
 * v12 rewrites those legacy defaults to sorted / collapsed / true once.
 * After version >= 12 the user may set live / summary / false again; leave them alone.
 */
export function migrateCompactChatDefaultsForPersistVersion<T extends CompactChatDefaultsSlice>(
  state: T,
  version: number,
): T {
  if (version >= COMPACT_CHAT_DEFAULTS_PERSIST_VERSION) {
    return state;
  }

  if (state.chatRenderMode === 'live') {
    state.chatRenderMode = 'sorted';
  }
  if (state.activityRenderMode === 'summary') {
    state.activityRenderMode = 'collapsed';
  }
  if (state.showTurnChangedFiles === false) {
    state.showTurnChangedFiles = true;
  }

  return state;
}
