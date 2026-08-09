import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAppRouter } from './createAppRouter';
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

  const history = {
    state: null as unknown,
    pushState(state: unknown, _title: string, nextUrl?: string | null) {
      this.state = state;
      if (typeof nextUrl === 'string') applyUrl(nextUrl);
    },
    replaceState(state: unknown, _title: string, nextUrl?: string | null) {
      this.state = state;
      if (typeof nextUrl === 'string') applyUrl(nextUrl);
    },
  };

  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    listeners.get(type)?.delete(listener);
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location, history, addEventListener, removeEventListener },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {}, baseURI: href },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: location,
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: history,
  });
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: addEventListener,
  });
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

describe('createAppRouter', () => {
  test('creates a router for web with browser history initial location', () => {
    const router = createAppRouter({ runtime: 'web' });

    expect(router).toBeDefined();
    expect(router.state.location.pathname).toBe('/');
    expect(router.options.context?.runtime).toBe('web');
  });

  test('creates a router for electron with memory history', async () => {
    const router = createAppRouter({ runtime: 'electron' });

    expect(router.options.context?.runtime).toBe('electron');

    await router.navigate({ to: '/session/demo' });

    expect(router.state.location.pathname).toBe('/session/demo');
    // Memory history must not mutate the real window location.
    expect(globalThis.window.location.pathname).toBe('/');
  });

  const runtimes: RouterRuntime[] = ['web', 'vscode', 'electron', 'embedded', 'mobile'];

  for (const runtime of runtimes) {
    test(`accepts runtime injection for ${runtime}`, () => {
      const router = createAppRouter({ runtime });
      expect(router.options.context?.runtime).toBe(runtime);
    });
  }
});
