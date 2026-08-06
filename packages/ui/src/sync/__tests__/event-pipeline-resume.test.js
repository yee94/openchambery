import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
  globalThis.navigator = savedNavigator;
});

// Multi-listener event-target stub. waitForRetry and the top-level
// onSystemResume handler both register for `openchamber:system-resume`,
// so a single-slot stub would silently drop one of them.
function createEventTarget(extras = {}) {
  const listeners = new Map();
  return {
    ...extras,
    addEventListener(event, handler) {
      const list = listeners.get(event);
      if (list) list.add(handler);
      else listeners.set(event, new Set([handler]));
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    dispatch(event) {
      const list = listeners.get(event);
      if (!list) return;
      for (const handler of Array.from(list)) {
        handler();
      }
    },
  };
}

describe('createEventPipeline — system resume reconnect', () => {
  it('reconnects immediately on openchamber:system-resume event', async () => {
    const winListeners = {};
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.window = {
      location: {
        href: 'http://127.0.0.1:3000/',
        origin: 'http://127.0.0.1:3000',
      },
      addEventListener(event, handler) { winListeners[event] = handler; },
      removeEventListener(event) { delete winListeners[event]; },
    };

    const disconnectReasons = [];
    let reconnectCount = 0;
    const eventCalls = [];

    let sdkCallIndex = 0;
    let releaseFirstStream;
    const firstHold = new Promise((resolve) => { releaseFirstStream = resolve; });

    const sdk = {
      global: {
        // Accept options with signal so the mock generator can abort.
        event: async (options) => {
          const callIndex = sdkCallIndex++;
          eventCalls.push(callIndex);
          const signal = options?.signal;
          if (callIndex === 0) {
            return {
              stream: (async function* () {
                yield {
                  payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
                };
                // Wait for either the hold promise or abort signal.
                await Promise.race([
                  firstHold,
                  new Promise((_, reject) => {
                    if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
                    signal?.addEventListener('abort', () => {
                      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
                    });
                  }),
                ]);
              })(),
            };
          }
          return {
            stream: (async function* () {
              yield {
                payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
              };
              await new Promise(() => {});
            })(),
          };
        },
      },
    };

    const recovered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: (reason) => {
          disconnectReasons.push(reason);
        },
        onReconnect: () => {
          reconnectCount += 1;
          // onReconnect fires on the initial connect too (count=1),
          // so wait for the second reconnect (count=2) triggered by resume.
          if (reconnectCount === 2) {
            cleanup();
            resolve();
          }
        },
      });

      // Wait for first SSE attempt to start and deliver the event, then
      // simulate OS resume by invoking the registered handler directly.
      setTimeout(() => {
        const handler = winListeners['openchamber:system-resume'];
        if (handler) handler();
      }, 80);
    });

    await recovered;
    releaseFirstStream();

    // Should have made two SDK calls: initial connect + reconnect after resume.
    expect(eventCalls.length).toBe(2);
    // Disconnect reason should include system_resume.
    expect(disconnectReasons.some((r) => r.includes('system_resume'))).toBe(true);
  });

  it('aborts the active attempt when system-resume fires (multi-listener dispatch)', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });

    const disconnectReasons = [];
    let sdkCallIndex = 0;
    const sdk = {
      global: {
        event: async (options) => {
          const idx = sdkCallIndex++;
          const signal = options?.signal;
          if (idx === 0) {
            return {
              stream: (async function* () {
                yield {
                  payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
                };
                await new Promise((_, reject) => {
                  if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                  signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });
              })(),
            };
          }
          return {
            stream: (async function* () {
              yield {
                payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
              };
              await new Promise(() => {});
            })(),
          };
        },
      },
    };

    await new Promise((resolve) => {
      let reconnects = 0;
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: (reason) => { disconnectReasons.push(reason); },
        onReconnect: () => {
          reconnects += 1;
          if (reconnects === 2) {
            cleanup();
            resolve();
          }
        },
      });

      setTimeout(() => {
        globalThis.window.dispatch('openchamber:system-resume');
      }, 80);
    });

    expect(sdkCallIndex).toBe(2);
    expect(disconnectReasons.some((r) => r.includes('system_resume'))).toBe(true);
  });

  it('wakes waitForRetry when system-resume fires during the inter-attempt sleep', async () => {
    // Hidden tab, browser online: first attempt fails immediately, so the
    // loop enters waitForRetry on the hidden-cap backoff. No `online` event
    // and no visibilitychange to visible — only `openchamber:system-resume`
    // may cut the sleep short.
    globalThis.document = createEventTarget({ visibilityState: 'hidden' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: false };

    const disconnectReasons = [];
    let sdkCallIndex = 0;
    const sdk = {
      global: {
        event: async () => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            throw new Error('simulated network error');
          }
          return {
            stream: (async function* () {
              yield {
                payload: {
                  type: 'session.status',
                  properties: { sessionID: 's1', status: { type: 'idle' } },
                },
              };
              await new Promise(() => {});
            })(),
          };
        },
      },
    };

    const startedAt = Date.now();
    const elapsed = await new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: () => {
          // Now inside waitForRetry on the 60s offline/hidden cap. Dispatch
          // system-resume only — it must wake the sleep on its own.
          setTimeout(() => {
            globalThis.window.dispatch('openchamber:system-resume');
          }, 50);
        },
        onReconnect: () => {
          cleanup();
          resolve(Date.now() - startedAt);
        },
      });
    });

    // Without the fix the loop would sleep the full 60s cap; the recovery
    // attempt must start (and connect) almost immediately after resume.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
    // Resume during retry wait must not tag the next healthy connection with
    // a stale system_resume disconnect reason.
    expect(disconnectReasons.some((r) => r.includes('system_resume'))).toBe(false);
  });
});
