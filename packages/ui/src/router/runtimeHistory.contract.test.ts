import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAppRouter } from './createAppRouter';
import { createAppNavigation } from './navigation';
import type { RouterRuntime } from './runtime';

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
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: historyApi,
      addEventListener: (t: string, l: EventListenerOrEventListenerObject) => {
        const set = listeners.get(t) ?? new Set();
        set.add(l);
        listeners.set(t, set);
      },
      removeEventListener: (t: string, l: EventListenerOrEventListenerObject) => {
        listeners.get(t)?.delete(l);
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {}, baseURI: href },
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: historyApi });
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: globalThis.window.addEventListener,
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: globalThis.window.removeEventListener,
  });
};

beforeEach(() => installWindow('http://127.0.0.1:5173/'));
afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('multi-runtime history contract (Ticket 07)', () => {
  const memoryRuntimes: RouterRuntime[] = ['vscode', 'electron', 'embedded', 'mobile'];

  for (const runtime of memoryRuntimes) {
    test(`${runtime}: navigates in router state without writing window.location`, async () => {
      const router = createAppRouter({ runtime });
      const nav = createAppNavigation(router);
      const before = globalThis.window.location.href;

      await nav.goSession('rt-1', { tab: 'git' });

      expect(router.state.location.pathname).toBe('/session/rt-1/git');
      expect(globalThis.window.location.href).toBe(before);
      // No hash history
      expect(router.state.location.href.includes('#/')).toBe(false);
    });
  }

  test('web: browser history writes pathname after flush', async () => {
    const router = createAppRouter({ runtime: 'web' });
    const nav = createAppNavigation(router);

    await nav.goSession('web-1');
    router.history.flush?.();

    expect(router.state.location.pathname).toBe('/session/web-1');
    expect(globalThis.window.location.pathname).toBe('/session/web-1');
  });

  test('embedded and vscode use same path programming model', async () => {
    const embedded = createAppRouter({ runtime: 'embedded' });
    const vscode = createAppRouter({ runtime: 'vscode' });
    await createAppNavigation(embedded).goSession('same');
    await createAppNavigation(vscode).goSession('same');
    expect(embedded.state.location.pathname).toBe(vscode.state.location.pathname);
  });
});
