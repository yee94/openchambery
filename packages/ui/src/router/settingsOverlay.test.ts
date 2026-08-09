import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAppRouter } from './createAppRouter';
import { createAppNavigation } from './navigation';
import { serializeAppPath } from '@/lib/router/serializeRoute';

const originalWindow = globalThis.window;

const installWindow = (href: string) => {
  const url = new URL(href);
  const applyUrl = (next: string) => {
    const resolved = new URL(next, url.origin);
    url.href = resolved.href;
    url.pathname = resolved.pathname;
    url.search = resolved.search;
    url.hash = resolved.hash;
  };
  const location = {
    get href() {
      return url.href;
    },
    get origin() {
      return url.origin;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
  };
  const historyApi = {
    state: null as unknown,
    pushState(state: unknown, _t: string, next?: string | null) {
      this.state = state;
      if (typeof next === 'string') applyUrl(next);
    },
    replaceState(state: unknown, _t: string, next?: string | null) {
      this.state = state;
      if (typeof next === 'string') applyUrl(next);
    },
  };
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.get(type)?.delete(listener);
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location, history: historyApi, addEventListener, removeEventListener },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {}, baseURI: href },
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: historyApi });
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: addEventListener });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: removeEventListener,
  });
};

beforeEach(() => installWindow('http://127.0.0.1:5173/'));
afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

const loc = (router: ReturnType<typeof createAppRouter>) =>
  `${router.state.location.pathname}${router.state.location.searchStr ?? ''}`;

describe('settings overlay path (Ticket 05)', () => {
  test('openSettings uses path and closeSettings restores workspace path', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);

    await nav.goSession('s1', { tab: 'diff', file: 'a.ts' });
    expect(loc(router)).toBe('/session/s1/diff?file=a.ts');

    await nav.openSettings('appearance');
    expect(loc(router)).toBe('/settings/appearance');
    expect(nav.getSettingsReturnTo()).toBe('/session/s1/diff?file=a.ts');

    await nav.closeSettings();
    expect(loc(router)).toBe('/session/s1/diff?file=a.ts');
  });

  test('serializeAppPath prefers settings overlay over session', () => {
    expect(
      serializeAppPath({
        sessionId: 's1',
        tab: 'git',
        isSettingsOpen: true,
        settingsPath: 'providers',
        diffFile: null,
      }),
    ).toBe('/settings/providers');
  });

  test('illegal slug falls back to home', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);
    await nav.openSettings('totally-fake');
    expect(loc(router)).toBe('/settings/home');
  });
});
