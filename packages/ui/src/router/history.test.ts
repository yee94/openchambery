import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAppHistory } from './history';
import type { RouterRuntime } from './runtime';

const MEMORY_RUNTIMES: readonly RouterRuntime[] = [
  'vscode',
  'electron',
  'embedded',
  'mobile',
] as const;

const originalWindow = globalThis.window;

type WindowStub = {
  location: {
    href: string;
    origin: string;
    pathname: string;
    search: string;
    hash: string;
  };
  history: {
    state: unknown;
    pushState(state: unknown, title: string, url?: string | null): void;
    replaceState(state: unknown, title: string, url?: string | null): void;
  };
  addEventListener: typeof window.addEventListener;
  removeEventListener: typeof window.removeEventListener;
};

const installWindow = (href: string): WindowStub => {
  const url = new URL(href);
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  const applyUrl = (next: string) => {
    const resolved = new URL(next, url.origin);
    url.href = resolved.href;
    url.pathname = resolved.pathname;
    url.search = resolved.search;
    url.hash = resolved.hash;
  };

  const stub: WindowStub = {
    location: {
      get href() {
        return url.href;
      },
      set href(value: string) {
        applyUrl(value);
      },
      get origin() {
        return url.origin;
      },
      get pathname() {
        return url.pathname;
      },
      set pathname(value: string) {
        url.pathname = value;
      },
      get search() {
        return url.search;
      },
      set search(value: string) {
        url.search = value;
      },
      get hash() {
        return url.hash;
      },
      set hash(value: string) {
        url.hash = value;
      },
    },
    history: {
      state: null,
      pushState(state, _title, nextUrl) {
        this.state = state;
        if (typeof nextUrl === 'string') {
          applyUrl(nextUrl);
        }
      },
      replaceState(state, _title, nextUrl) {
        this.state = state;
        if (typeof nextUrl === 'string') {
          applyUrl(nextUrl);
        }
      },
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: stub,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {}, baseURI: href },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: stub.location,
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: stub.history,
  });
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: stub.addEventListener.bind(stub),
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: stub.removeEventListener.bind(stub),
  });

  return stub;
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

describe('createAppHistory', () => {
  test('web runtime uses browser history that writes window location pathname', () => {
    const win = globalThis.window as unknown as Window;
    const history = createAppHistory('web', { window: win });
    const before = win.location.pathname;

    history.push('/session/abc');
    // TanStack browser history flushes pushState on a microtask; flush forces URL write.
    history.flush?.();

    expect(win.location.pathname).toBe('/session/abc');
    expect(win.location.pathname).not.toBe(before);
    expect(history.location.pathname).toBe('/session/abc');
  });

  for (const runtime of MEMORY_RUNTIMES) {
    test(`${runtime} runtime uses memory history and does not write window location`, () => {
      const history = createAppHistory(runtime);
      const beforePath = globalThis.window.location.pathname;
      const beforeHref = globalThis.window.location.href;

      history.push('/session/abc');
      history.flush?.();

      expect(history.location.pathname).toBe('/session/abc');
      expect(globalThis.window.location.pathname).toBe(beforePath);
      expect(globalThis.window.location.href).toBe(beforeHref);
    });
  }

  test('never uses hash history style locations for memory runtimes', () => {
    const history = createAppHistory('electron');
    history.push('/session/xyz');

    expect(history.location.pathname).toBe('/session/xyz');
    expect(history.location.href.includes('#/')).toBe(false);
    expect(globalThis.window.location.hash).toBe('');
  });
});
