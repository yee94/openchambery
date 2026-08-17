import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const sessionActive = mock();
const eventSubscribe = mock();
const make = mock(() => ({
  session: { active: sessionActive },
  event: { subscribe: eventSubscribe },
}));

mock.module('@opencode-ai/client', () => ({ OpenCode: { make } }));

const {
  startGlobalEventWatcher,
  stopGlobalEventWatcher,
  getSessionActivitySnapshot,
} = await import('./sessionActivityWatcher');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('session activity watcher', () => {
  beforeEach(() => {
    stopGlobalEventWatcher();
    sessionActive.mockReset();
    eventSubscribe.mockReset();
    make.mockReset();
    make.mockImplementation(() => ({
      session: { active: sessionActive },
      event: { subscribe: eventSubscribe },
    }));
    sessionActive.mockImplementation(async () => ({}));
    eventSubscribe.mockImplementation(({ signal } = {}) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    }));
  });

  afterEach(() => {
    stopGlobalEventWatcher();
  });

  it('reconciles session.active and maps v2 execution events', async () => {
    const posts = [];
    sessionActive.mockImplementation(async () => ({ ses_1: { type: 'running' } }));
    eventSubscribe.mockImplementation(({ signal } = {}) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } };
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    }));

    await startGlobalEventWatcher({
      getApiUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    }, {
      postMessage: (message) => posts.push(message),
    });

    await wait(80);

    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { Authorization: 'Bearer test' },
      fetch: expect.any(Function),
    });
    expect(sessionActive).toHaveBeenCalled();
    expect(eventSubscribe).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(posts).toEqual(expect.arrayContaining([
      { type: 'openchamber:session-activity', properties: { sessionId: 'ses_1', phase: 'busy' } },
      { type: 'openchamber:session-activity', properties: { sessionId: 'ses_1', phase: 'cooldown' } },
    ]));
    expect(getSessionActivitySnapshot()).toMatchObject({
      ses_1: { type: 'cooldown' },
    });
  });
});
