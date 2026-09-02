import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAppRouter } from './createAppRouter';
import { createAppNavigation } from './navigation';
import type { NavigationIntent } from './navigationIntent';

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

beforeEach(() => {
  installWindow('http://127.0.0.1:5173/');
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

const locationOf = (router: ReturnType<typeof createAppRouter>) => {
  const { pathname, searchStr } = router.state.location;
  return `${pathname}${searchStr ?? ''}`;
};

describe('createAppNavigation (memory router)', () => {
  test('goSession writes path not query', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);

    await nav.goSession('sess-1');
    expect(locationOf(router)).toBe('/session/sess-1');

    await nav.goSession('sess-1', { tab: 'git' });
    expect(locationOf(router)).toBe('/session/sess-1/git');

    await nav.goSession('sess-1', { tab: 'diff', file: 'a/b.ts' });
    expect(locationOf(router)).toBe('/session/sess-1/diff?file=a%2Fb.ts');

    await nav.goSession('sess-1', { tab: 'plan' });
    expect(locationOf(router)).toBe('/session/sess-1');

    await nav.goSchedule({ scheduleView: 'history' });
    expect(locationOf(router)).toBe('/schedule/history');

    await nav.goAssistant({ assistantId: 'asst_1' });
    expect(locationOf(router)).toBe('/assistant/asst_1');
  });

  test('goNewSession and settings open/close with returnTo', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);

    await nav.goSession('s1', { tab: 'files' });
    expect(locationOf(router)).toBe('/session/s1/files');

    await nav.openSettings('providers');
    expect(locationOf(router)).toBe('/settings/providers');

    await nav.closeSettings();
    expect(locationOf(router)).toBe('/session/s1/files');

    await nav.goNewSession();
    expect(locationOf(router)).toBe('/session/new');
  });

  test('openSettings normalizes illegal slug to home', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);

    await nav.openSettings('not-real');
    expect(locationOf(router)).toBe('/settings/home');
  });

  test('applyIntent covers NavigationIntent union', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);

    const intents: NavigationIntent[] = [
      { type: 'session', sessionId: 'x', tab: 'terminal' },
      { type: 'new-session' },
      { type: 'settings', slug: 'mcp' },
      { type: 'connect' },
    ];

    await nav.applyIntent(intents[0]!);
    expect(locationOf(router)).toBe('/session/x/terminal');

    await nav.applyIntent(intents[1]!);
    expect(locationOf(router)).toBe('/session/new');

    await nav.goSession('x');
    await nav.applyIntent(intents[2]!);
    expect(locationOf(router)).toBe('/settings/mcp');

    await nav.applyIntent(intents[3]!);
    expect(locationOf(router)).toBe('/connect');
  });

  test('memory navigation does not write window.location', async () => {
    const router = createAppRouter({ runtime: 'electron' });
    const nav = createAppNavigation(router);
    const before = globalThis.window.location.href;

    await nav.goSession('only-memory');
    expect(globalThis.window.location.href).toBe(before);
    expect(router.state.location.pathname).toBe('/session/only-memory');
  });
});
