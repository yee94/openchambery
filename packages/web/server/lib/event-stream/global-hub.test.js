import { describe, expect, it, vi } from 'vitest';

import { confirmMessageQueueEvent, createGlobalMessageStreamHub } from './global-hub.js';

function createSseResponse({ blocks = [] } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

describe('createGlobalMessageStreamHub', () => {
  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues status fanout when a status subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeStatus(() => {
      throw new Error('status subscriber failed');
    });
    hub.subscribeStatus((status) => {
      received.push(status.type);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toContain('connect');
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('late-binds a runtime identity to an already connected stream', async () => {
    const runtimeKey = 'a'.repeat(64);
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: before-queue\ndata: {"type":"message.updated","properties":{}}\n\n',
          'id: after-queue\ndata: {"type":"message.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent((event) => {
      received.push(event);
      if (event.eventId === 'before-queue') {
        hub.setRuntimeIdentityProvider(() => ({ runtimeKey }));
      }
    });

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(2));
      expect(received[0].runtimeIdentity).toBeUndefined();
      expect(received[1].runtimeIdentity).toEqual({
        runtimeKey,
        generation: 1,
        token: `${runtimeKey}:1`,
      });
    } finally {
      hub.stop();
    }
  });

  it('keeps the connection runtime fence on late A events after switching to B', async () => {
    let runtime = { runtimeKey: 'a'.repeat(64) };
    let fetchCalls = 0;
    const received = [];
    let hub;
    const encoder = new TextEncoder();
    const firstResponse = {
      ok: true,
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index === 0) {
                index += 1;
                return { value: encoder.encode('id: a-1\ndata: {"type":"message.updated","properties":{}}\n\n'), done: false };
              }
              if (index === 1) {
                index += 1;
                runtime = { runtimeKey: 'b'.repeat(64) };
                return { value: encoder.encode('id: a-late\ndata: {"type":"message.updated","properties":{}}\n\n'), done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      },
    };

    hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'sensitive-header' }),
      getRuntimeIdentity: () => ({ ...runtime, headers: { Authorization: 'sensitive-header' } }),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? firstResponse
          : createSseResponse({ blocks: ['id: b-1\ndata: {"type":"message.updated","properties":{}}\n\n'] });
      },
    });
    hub.subscribeEvent((event) => {
      received.push(event);
      if (received.length === 3) hub.stop();
    });

    hub.start();
    await waitForAssertion(() => {
      expect(received).toHaveLength(3);
    });

    expect(received.map((event) => event.eventId)).toEqual(['a-1', 'a-late', 'b-1']);
    expect(received.map((event) => event.runtimeIdentity)).toEqual([
      { runtimeKey: 'a'.repeat(64), generation: 1, token: `${'a'.repeat(64)}:1` },
      { runtimeKey: 'a'.repeat(64), generation: 1, token: `${'a'.repeat(64)}:1` },
      { runtimeKey: 'b'.repeat(64), generation: 2, token: `${'b'.repeat(64)}:2` },
    ]);
    expect(received[0].runtimeIdentity.headers).toBeUndefined();
  });

  it('confirms late A and new B events through their own active runtime authorities', () => {
    const runtimeA = 'a'.repeat(64);
    const runtimeB = 'b'.repeat(64);
    const messageQueueService = {
      getAuthority: vi.fn(({ runtimeKey }) => ({ authority: 'active', generation: runtimeKey === runtimeA ? 3 : 7 })),
      confirmByMessage: vi.fn(),
    };
    const event = (runtimeKey, generation, messageID) => ({
      directory: '/repo',
      payload: { type: 'message.updated', properties: { info: { role: 'user', sessionID: 'ses_1', id: messageID } } },
      runtimeIdentity: { runtimeKey, generation, token: `${runtimeKey}:${generation}` },
    });

    expect(confirmMessageQueueEvent(messageQueueService, event(runtimeA, 1, 'msg_a_late'))).toBe(true);
    expect(confirmMessageQueueEvent(messageQueueService, event(runtimeB, 2, 'msg_b'))).toBe(true);
    expect(messageQueueService.confirmByMessage).toHaveBeenCalledTimes(2);
    expect(messageQueueService.getAuthority).toHaveBeenNthCalledWith(1, { runtimeKey: runtimeA });
    expect(messageQueueService.getAuthority).toHaveBeenNthCalledWith(2, { runtimeKey: runtimeB });
    expect(messageQueueService.confirmByMessage).toHaveBeenNthCalledWith(1, {
      runtimeKey: runtimeA,
      directory: '/repo',
      sessionID: 'ses_1',
      messageID: 'msg_a_late',
      source: 'event',
    });
    expect(messageQueueService.confirmByMessage).toHaveBeenNthCalledWith(2, {
      runtimeKey: runtimeB,
      directory: '/repo',
      sessionID: 'ses_1',
      messageID: 'msg_b',
      source: 'event',
    });
  });

  it('accepts later events from one connection after queue authority generation changes', () => {
    const runtimeKey = 'a'.repeat(64);
    let authority = { authority: 'shadow', generation: 1 };
    const messageQueueService = {
      getAuthority: vi.fn(() => authority),
      confirmByMessage: vi.fn(),
    };
    const event = {
      directory: '/repo',
      payload: { type: 'message.updated', properties: { info: { role: 'user', sessionID: 'ses_1', id: 'msg_1' } } },
      runtimeIdentity: { runtimeKey, generation: 1, token: `${runtimeKey}:1` },
    };

    expect(confirmMessageQueueEvent(messageQueueService, event)).toBe(false);
    authority = { authority: 'active', generation: 2 };
    expect(confirmMessageQueueEvent(messageQueueService, event)).toBe(true);
    expect(messageQueueService.getAuthority).toHaveBeenNthCalledWith(1, { runtimeKey });
    expect(messageQueueService.getAuthority).toHaveBeenNthCalledWith(2, { runtimeKey });
  });

  it('confirms events while the runtime authority is paused and keeps shadow authority fenced', () => {
    const runtimeKey = 'a'.repeat(64);
    let authority = { authority: 'paused', generation: 2 };
    const messageQueueService = {
      getAuthority: vi.fn(() => authority),
      confirmByMessage: vi.fn(),
    };
    const event = {
      directory: '/repo',
      payload: { type: 'message.updated', properties: { info: { role: 'user', sessionID: 'ses_1', id: 'msg_1' } } },
      runtimeIdentity: { runtimeKey, generation: 1, token: `${runtimeKey}:1` },
    };

    expect(confirmMessageQueueEvent(messageQueueService, event)).toBe(true);
    authority = { authority: 'shadow', generation: 3 };
    expect(confirmMessageQueueEvent(messageQueueService, event)).toBe(false);
    expect(messageQueueService.confirmByMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an event has no runtime identity', () => {
    const messageQueueService = { getAuthority: vi.fn(), confirmByMessage: vi.fn() };

    expect(confirmMessageQueueEvent(messageQueueService, {
      directory: '/repo',
      payload: { type: 'message.updated', properties: { info: { role: 'user', sessionID: 'ses_1', id: 'msg_1' } } },
    })).toBe(false);
    expect(messageQueueService.getAuthority).not.toHaveBeenCalled();
    expect(messageQueueService.confirmByMessage).not.toHaveBeenCalled();
  });
});
