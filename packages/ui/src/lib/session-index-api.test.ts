import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Clear sticky mocks from other suites before installing this file's doubles.
mock.restore();

type OpenChamberEvent = {
  type: string;
  revision?: number;
  occurredAt?: number;
  sync?: { active: boolean; enriching: boolean };
};

const tipListeners = new Set<(event: OpenChamberEvent) => void>();
/** Deliver a tip (or ready) event to every active OpenChamber tip subscriber. */
const emitTip = (event: OpenChamberEvent) => {
  for (const listener of [...tipListeners]) listener(event);
};

const realOpenchamberEvents = await import('@/lib/openchamberEvents');
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: OpenChamberEvent) => void) => {
    tipListeners.add(listener);
    return () => { tipListeners.delete(listener); };
  },
  // Keep the real parser so sibling suites can still assert envelope contracts.
  parseOpenchamberEventEnvelope: realOpenchamberEvents.parseOpenchamberEventEnvelope,
}));

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const {
  loadSessionIndexSnapshot,
  startSessionIndexBackgroundSync,
  waitForSessionIndexInvalidation,
} = await import('./session-index-api');

const payload = {
  revision: 1,
  sync: {
    active: true,
    completed: 0,
    total: 2,
    pendingDirectories: ['/repo/a', '/repo/b'],
    completedDirectories: [],
    failedDirectories: [],
  },
  directories: [],
};

describe('session index background transport', () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>;
  let requests: Array<{ url: string; init?: RequestInit }>;

  afterAll(() => {
    mock.restore();
  });
  beforeEach(() => {
    tipListeners.clear();
    previousResolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:57123' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/' } },
    });
    requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response(JSON.stringify(payload), {
        status: input.toString().includes('/sync') ? 202 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    tipListeners.clear();
    setRuntimeUrlResolver(previousResolver);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.fetch = originalFetch;
  });

  test('starts one server job and waits for a session-index tip invalidation', async () => {
    await startSessionIndexBackgroundSync(['/repo/a', '/repo/b']);
    const controller = new AbortController();
    const pending = waitForSessionIndexInvalidation(1, controller.signal);
    emitTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
    expect(await pending).toBe('tip');

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/openchamber/session-index/sync');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ directories: ['/repo/a', '/repo/b'] });
  });

  test('resolves ready and aborted wait reasons without falling back to long-poll', async () => {
    const ready = waitForSessionIndexInvalidation(1, new AbortController().signal);
    emitTip({ type: 'event-stream-ready' });
    expect(await ready).toBe('ready');

    const controller = new AbortController();
    const aborted = waitForSessionIndexInvalidation(1, controller.signal);
    controller.abort();
    expect(await aborted).toBe('aborted');
  });

  test('debounces dense session-index tips into one wait resolution', async () => {
    const pending = waitForSessionIndexInvalidation(1, new AbortController().signal);
    emitTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
    emitTip({ type: 'session-index-changed', revision: 3, occurredAt: 2 });
    emitTip({ type: 'session-index-changed', revision: 4, occurredAt: 3 });
    expect(await pending).toBe('tip');
  });

  test('coalesces concurrent snapshot GETs then allows a later independent GET', async () => {
    let loads = 0;
    globalThis.fetch = async (input) => {
      loads += 1;
      const body = { available: true, ...payload, revision: loads };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const first = loadSessionIndexSnapshot();
    const second = loadSessionIndexSnapshot();
    const [a, b] = await Promise.all([first, second]);
    expect(loads).toBe(1);
    expect(a?.revision).toBe(1);
    expect(b?.revision).toBe(1);
    const third = await loadSessionIndexSnapshot();
    expect(loads).toBe(2);
    expect(third?.revision).toBe(2);
  });
});
