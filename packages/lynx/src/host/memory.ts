import type { LynxHostAdapters, LynxJsonStore, LynxSecureStore } from './adapters.ts';
import type { LynxHttpInit, LynxHttpResponse, LynxHttpTransport, LynxRelayConfig } from '../connect/types.ts';

export const createMemoryJsonStore = (initial: Record<string, string> = {}): LynxJsonStore => {
  const map = new Map(Object.entries(initial));
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
};

export const createMemorySecureStore = (): LynxSecureStore & { snapshot: () => Record<string, string> } => {
  const map = new Map<string, string>();
  return {
    getToken: async (key) => map.get(key),
    setToken: async (key, token) => {
      map.set(key, token);
      return true;
    },
    deleteToken: async (key) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
};

export const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

export type RecordedRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

export const createMemoryClock = () => {
  const sleeps: number[] = [];
  const waiters: Array<{ ms: number; resolve: () => void }> = [];
  return {
    now: () => Date.now(),
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        waiters.push({ ms, resolve: finish });
        signal?.addEventListener('abort', finish, { once: true });
      });
    },
    flush: (ms?: number) => {
      const pending = ms === undefined ? waiters.splice(0) : waiters.filter((waiter) => waiter.ms === ms);
      if (ms !== undefined) {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index]?.ms === ms) waiters.splice(index, 1);
        }
      }
      for (const waiter of pending) waiter.resolve();
    },
  };
};

export const createScriptedHttp = (
  handler: (request: RecordedRequest) => LynxHttpResponse | Promise<LynxHttpResponse | null> | null,
) => {
  const requests: RecordedRequest[] = [];
  const request = async (url: string, init?: LynxHttpInit): Promise<LynxHttpResponse> => {
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    };
    requests.push(recorded);
    const response = await handler(recorded);
    if (!response) {
      return { ok: false, status: 0, json: async () => null };
    }
    return response;
  };
  return { request, requests };
};

export const createScriptedRelay = (
  handler: (request: RecordedRequest, relay: LynxRelayConfig) => LynxHttpResponse | Promise<LynxHttpResponse | null> | null,
) => {
  const requests: RecordedRequest[] = [];
  const openRelay = async (relay: LynxRelayConfig): Promise<LynxHttpTransport> => ({
    fetch: async (path, init) => {
      const recorded: RecordedRequest = {
        url: path,
        method: init?.method ?? 'GET',
        headers: init?.headers,
        body: init?.body,
      };
      requests.push(recorded);
      return (await handler(recorded, relay)) ?? { ok: false, status: 0, json: async () => null };
    },
    close: () => undefined,
  });
  return { openRelay, requests };
};

export const createMemoryHost = (overrides: Partial<LynxHostAdapters> = {}): LynxHostAdapters => ({
  request: async () => ({ ok: false, status: 0, json: async () => null }),
  secureStore: createMemorySecureStore(),
  metadataStore: createMemoryJsonStore(),
  clock: {
    now: () => Date.now(),
    sleep: async () => undefined,
  },
  createId: () => 'conn_test',
  ...overrides,
});
