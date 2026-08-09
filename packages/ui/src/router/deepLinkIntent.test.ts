import { describe, expect, test } from 'bun:test';
import { parseDeepLink } from '@/apps/deepLinks';
import {
  deepLinkToNavigationIntent,
  resolveDeepLinkNavigationIntent,
} from './deepLinkIntent';
import { createAppRouter } from './createAppRouter';
import { createAppNavigation } from './navigation';

const originalWindow = globalThis.window;

const installWindow = () => {
  const url = new URL('http://127.0.0.1:5173/');
  const applyUrl = (next: string) => {
    const resolved = new URL(next, url.origin);
    url.href = resolved.href;
    url.pathname = resolved.pathname;
    url.search = resolved.search;
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
      return '';
    },
  };
  const historyApi = {
    state: null as unknown,
    pushState(_s: unknown, _t: string, next?: string | null) {
      if (typeof next === 'string') applyUrl(next);
    },
    replaceState(_s: unknown, _t: string, next?: string | null) {
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
    value: { documentElement: {}, baseURI: url.href },
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

describe('deepLinkToNavigationIntent (Ticket 06)', () => {
  test('session deep link maps to session intent (directory not in path)', () => {
    const dl = parseDeepLink('openchamber://session/abc?directory=/repo');
    expect(dl).toEqual({ type: 'session', sessionId: 'abc', directory: '/repo' });
    expect(deepLinkToNavigationIntent(dl!)).toEqual({
      type: 'session',
      sessionId: 'abc',
    });
  });

  test('new-session and settings map to path intents', () => {
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://new-session')!)).toEqual({
      type: 'new-session',
    });
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://settings/providers')!)).toEqual({
      type: 'settings',
      slug: 'providers',
    });
  });

  test('changes maps to git tab with optional file; needs current session', () => {
    const dl = parseDeepLink('openchamber://changes/src/a.ts?staged=true')!;
    expect(deepLinkToNavigationIntent(dl)).toEqual({
      type: 'session',
      sessionId: '',
      tab: 'git',
      file: 'src/a.ts',
    });
    expect(resolveDeepLinkNavigationIntent(dl, null)).toBeNull();
    expect(resolveDeepLinkNavigationIntent(dl, 'cur')).toEqual({
      type: 'session',
      sessionId: 'cur',
      tab: 'git',
      file: 'src/a.ts',
    });
  });

  test('view files/mcp map; open-project/sessions stay shell-only', () => {
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://view/files')!)).toEqual({
      type: 'session',
      sessionId: '',
      tab: 'files',
    });
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://view/mcp')!)).toEqual({
      type: 'settings',
      slug: 'mcp',
    });
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://open-project?directory=/x')!)).toBeNull();
    expect(deepLinkToNavigationIntent(parseDeepLink('openchamber://sessions')!)).toBeNull();
  });

  test('apply mapped intent produces path location', async () => {
    installWindow();
    try {
      const router = createAppRouter({ runtime: 'electron' });
      const nav = createAppNavigation(router);
      const intent = deepLinkToNavigationIntent(parseDeepLink('openchamber://session/from-dl')!);
      await nav.applyIntent(intent!);
      expect(router.state.location.pathname).toBe('/session/from-dl');
      expect(globalThis.window.location.pathname).toBe('/'); // memory
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
