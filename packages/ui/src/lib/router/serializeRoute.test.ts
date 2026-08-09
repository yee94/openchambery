import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { updateBrowserURL, serializeAppPath } from './serializeRoute';
import type { AppRouteState } from './serializeRoute';
import { parseRoute, routeStateFromPath } from './parseRoute';
import { isEmbeddedSessionChat, resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';

const originalWindow = globalThis.window;

type HistoryStub = {
  state: unknown;
  lastURL: string | null;
  replaceState(state: unknown, _title: string, url?: string): void;
  pushState(state: unknown, _title: string, url?: string): void;
};

const installWindow = (href: string): HistoryStub => {
  const url = new URL(href);
  const history: HistoryStub = {
    state: null,
    lastURL: null,
    replaceState(state, _title, nextUrl) {
      this.state = state;
      this.lastURL = nextUrl ?? null;
      if (typeof nextUrl === 'string') {
        const resolved = new URL(nextUrl, url.origin);
        url.pathname = resolved.pathname;
        url.search = resolved.search;
        url.hash = resolved.hash;
        url.href = resolved.href;
      }
    },
    pushState(state, _title, nextUrl) {
      this.state = state;
      this.lastURL = nextUrl ?? null;
      if (typeof nextUrl === 'string') {
        const resolved = new URL(nextUrl, url.origin);
        url.pathname = resolved.pathname;
        url.search = resolved.search;
        url.hash = resolved.hash;
        url.href = resolved.href;
      }
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        get pathname() {
          return url.pathname;
        },
        get search() {
          return url.search;
        },
        get hash() {
          return url.hash;
        },
      },
      history,
    },
  });
  return history;
};

const historyOf = (): HistoryStub =>
  (globalThis.window as unknown as { history: HistoryStub }).history;

beforeEach(() => {
  installWindow('http://127.0.0.1:5173/');
  resetEmbeddedSessionChatCache();
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

const sessionState = (sessionId: string): AppRouteState => ({
  sessionId,
  tab: 'chat',
  isSettingsOpen: false,
  settingsPath: '',
  diffFile: null,
});

describe('serializeAppPath path mode', () => {
  test('session chat is a path without query session=', () => {
    expect(serializeAppPath(sessionState('ses_main'))).toBe('/session/ses_main');
    expect(serializeAppPath(sessionState('ses_main'))).not.toContain('session=');
  });

  test('workspace tabs and diff file use path + search', () => {
    expect(
      serializeAppPath({
        ...sessionState('ses_main'),
        tab: 'git',
      }),
    ).toBe('/session/ses_main/git');

    expect(
      serializeAppPath({
        ...sessionState('ses_main'),
        tab: 'diff',
        diffFile: 'src/a.ts',
      }),
    ).toBe('/session/ses_main/diff?file=src%2Fa.ts');
  });

  test('settings is a path overlay', () => {
    expect(
      serializeAppPath({
        ...sessionState('ses_main'),
        isSettingsOpen: true,
        settingsPath: 'providers',
      }),
    ).toBe('/settings/providers');
  });
});

describe('updateBrowserURL embedded-session-chat guard', () => {
  test('is a no-op in the embedded session-chat iframe', () => {
    const history = installWindow(
      'http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=ses_child&directory=%2Frepo&readOnly=1',
    );

    updateBrowserURL(sessionState('ses_grandchild'), { replace: true, force: true });

    expect(history.lastURL).toBeNull();
  });

  test('rewrites to path mode outside the embedded iframe', () => {
    installWindow('http://127.0.0.1:5173/');

    updateBrowserURL(sessionState('ses_main'), { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toBe('/session/ses_main');
    expect(writtenURL).not.toContain('session=');
  });
});

describe('scheduled / assistant path tabs', () => {
  test('serialize under session path', () => {
    const scheduled: AppRouteState = {
      ...sessionState('ses_main'),
      tab: 'schedule',
    };
    expect(serializeAppPath(scheduled)).toBe('/schedule');

    const assistant: AppRouteState = {
      ...sessionState('ses_main'),
      tab: 'assistant',
    };
    expect(serializeAppPath(assistant)).toBe('/assistant');

    expect(
      serializeAppPath({
        ...assistant,
        sessionId: null,
        assistantId: 'asst_demo',
      }),
    ).toBe('/assistant/asst_demo');
  });

  test('parse path tabs', () => {
    installWindow('http://127.0.0.1:5173/schedule');
    expect(parseRoute().tab).toBe('schedule');
    // schedule is top-level — no session id in path
    expect(parseRoute().sessionId).toBeNull();

    installWindow('http://127.0.0.1:5173/assistant');
    expect(parseRoute().tab).toBe('assistant');
    expect(parseRoute().sessionId).toBeNull();
  });
});

describe('routeStateFromPath', () => {
  test('parses session and settings paths', () => {
    expect(routeStateFromPath('/session/abc')).toEqual({
      sessionId: 'abc',
      isNewSession: false,
      tab: null,
      settingsPath: null,
      settingsEntityId: null,
      diffFile: null,
      diffScope: null,
      scheduleView: null,
      scheduleProjectId: null,
      scheduleTaskId: null,
      assistantId: null,
      focusSessionId: null,
    });
    expect(routeStateFromPath('/session/new').isNewSession).toBe(true);
    expect(routeStateFromPath('/session/new').sessionId).toBeNull();
    expect(routeStateFromPath('/settings/providers').settingsPath).toBe('providers');
    expect(routeStateFromPath('/schedule/history').scheduleView).toBe('history');
  });

  test('legacy query-only location is not a route', () => {
    expect(routeStateFromPath('/?session=abc').sessionId).toBeNull();
  });
});


describe('new session draft path', () => {
  test('serializes to /session/new without a session id', () => {
    expect(serializeAppPath({
      sessionId: null,
      isNewSession: true,
      tab: 'chat',
      isSettingsOpen: false,
      settingsPath: 'home',
      diffFile: null,
    })).toBe('/session/new');
  });

  test('draft wins over a lingering session id', () => {
    expect(serializeAppPath({
      sessionId: 'ses_old',
      isNewSession: true,
      tab: 'chat',
      isSettingsOpen: false,
      settingsPath: 'home',
      diffFile: null,
    })).toBe('/session/new');
  });
});

describe('isEmbeddedSessionChat caching', () => {
  test('caches the first result so URL rewrites cannot flip it', () => {
    installWindow(
      'http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=ses_child&directory=%2Frepo&readOnly=1',
    );

    expect(isEmbeddedSessionChat()).toBe(true);

    installWindow('http://127.0.0.1:5173/session/ses_grandchild');
    expect(isEmbeddedSessionChat()).toBe(true);
  });
});
