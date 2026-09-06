import type { LynxClock, LynxHttpClient, LynxHttpResponse, LynxRequestInit, LynxSessionStatus } from './types';

export const CONNECT_TIMEOUT_MS = 8000;
export const FAST_PROBE_TIMEOUT_MS = 2500;
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const RELAY_RACE_HEADSTART_MS = 1_500;

export const createFetchHttpClient = (): LynxHttpClient => ({
  request: async (url, init) => {
    try {
      const response = await fetch(url, {
        method: init?.method || 'GET',
        headers: init?.headers,
        body: init?.body,
        signal: init?.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json() as Promise<unknown>,
        text: () => response.text(),
        body: response.body,
      };
    } catch {
      return null;
    }
  },
});

export const createSystemClock = (): LynxClock => ({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
});

export const raceWithTimeout = async <T,>(
  timeoutMs: number,
  operation: Promise<T | null>,
): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

export const requestWithTimeout = async (
  http: LynxHttpClient,
  url: string,
  init?: LynxRequestInit,
  options?: { totalTimeoutMs?: number },
): Promise<LynxHttpResponse | null> => {
  const total = options?.totalTimeoutMs ?? CONNECT_TIMEOUT_MS;
  return raceWithTimeout(total, http.request(url, init));
};

export const readSessionStatus = async (
  response: { json: () => Promise<unknown> } | null,
): Promise<LynxSessionStatus | null> => {
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return {
    authenticated: typeof record.authenticated === 'boolean' ? record.authenticated : undefined,
    disabled: typeof record.disabled === 'boolean' ? record.disabled : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
};
