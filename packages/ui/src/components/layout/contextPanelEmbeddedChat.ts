import type { Theme } from '@/types/theme';

export const EMBEDDED_SESSION_CHAT_CLOSE_TAB_EVENT = 'yuri:close-embedded-session-chat';

/** Parent → child: current active-tab visibility for an embedded session-chat iframe. */
export const EMBEDDED_SESSION_CHAT_VISIBILITY_EVENT = 'yuri:embedded-visibility';

/**
 * Child → parent: iframe finished wiring its visibility listener and needs the
 * authoritative active-tab state. Parent should re-post visibility for all
 * chat frames (same pattern as `yuri:chat-settings-request`).
 */
export const EMBEDDED_SESSION_CHAT_VISIBILITY_REQUEST_EVENT = 'yuri:embedded-visibility-request';

export const isEmbeddedSessionChatSearch = (search: string): boolean => (
  new URLSearchParams(search).get('yuriPanel') === 'session-chat'
);

export type EmbeddedSessionChatThemeBootstrap = {
  mode: 'light' | 'dark' | 'system';
  lightThemeId: string;
  darkThemeId: string;
  currentTheme: Theme;
};

export type EmbeddedSessionChatURLCacheEntry = {
  signature: string;
  src: string;
};

const buildEmbeddedSessionChatURLSignature = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
): string => JSON.stringify({ sessionID, directory: directory || '', readOnly: readOnly === true });

export const buildEmbeddedSessionChatURL = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('yuriPanel', 'session-chat');
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('sessionId', sessionID);
  if (readOnly) {
    url.searchParams.set('readOnly', '1');
  } else {
    url.searchParams.delete('readOnly');
  }
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory);
  } else {
    url.searchParams.delete('directory');
  }
  url.searchParams.set('themeMode', theme.mode);
  url.searchParams.set('lightThemeId', theme.lightThemeId);
  url.searchParams.set('darkThemeId', theme.darkThemeId);
  url.searchParams.set('themeVariant', theme.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light');
  url.searchParams.set('currentTheme', JSON.stringify(theme.currentTheme));

  url.hash = '';
  return url.toString();
};

export const getOrCreateEmbeddedSessionChatURL = (
  cache: Map<string, EmbeddedSessionChatURLCacheEntry>,
  tabID: string,
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
): string => {
  const signature = buildEmbeddedSessionChatURLSignature(sessionID, directory, readOnly);
  const existing = cache.get(tabID);
  if (existing?.signature === signature) {
    return existing.src;
  }

  const src = buildEmbeddedSessionChatURL(sessionID, directory, readOnly, theme);
  cache.set(tabID, { signature, src });
  return src;
};

/**
 * True when the current document is the embedded session-chat iframe
 * (`?yuriPanel=session-chat`). Used to distinguish the embedded iframe from
 * the main app so callers can route behavior accordingly (e.g. in-place
 * subtask navigation instead of opening a new side-panel tab, or skipping
 * URL rewrites that would strip the iframe's identity params).
 *
 * Cached on first call (per JS realm): an iframe's embedded-ness is fixed
 * at mount by the parent and cannot change during its lifetime — a parent
 * src swap is a full browser reload, starting a fresh realm.
 */
let embeddedSessionChatCached: boolean | null = null;

export const isEmbeddedSessionChat = (): boolean => {
  if (embeddedSessionChatCached !== null) {
    return embeddedSessionChatCached;
  }
  if (typeof window === 'undefined') {
    embeddedSessionChatCached = false;
    return false;
  }
  try {
    embeddedSessionChatCached =
      new URLSearchParams(window.location.search).get('yuriPanel') === 'session-chat';
    return embeddedSessionChatCached;
  } catch {
    embeddedSessionChatCached = false;
    return false;
  }
};

/**
 * Reset the module-level cache. Intended for tests that simulate different
 * JS realms by swapping `window.location` in the same process.
 */
export const resetEmbeddedSessionChatCache = (): void => {
  embeddedSessionChatCached = null;
};

/**
 * The session ID recorded in the embedded iframe's URL
 * (`?yuriPanel=session-chat&sessionId=…`), i.e. the session the panel was
 * opened to show. Returns `null` outside the embedded iframe or when the
 * URL is malformed.
 */
export const getEmbeddedSessionChatOriginSessionId = (): string | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }
  try {
    const sid = new URLSearchParams(window.location.search).get('sessionId');
    return sid && sid.trim().length > 0 ? sid.trim() : null;
  } catch {
    return null;
  }
};
