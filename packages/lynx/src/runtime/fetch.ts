import type { LynxHttpClient, LynxHttpResponse, LynxRelayTunnel, LynxRequestInit } from '../connection/types';
import type { LynxRuntimeIdentityStore } from './identity';

const RUNTIME_PATHS = [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/health$/];

export const isRuntimeServicePath = (path: string): boolean =>
  RUNTIME_PATHS.some((pattern) => pattern.test(path));

export type LynxRuntimeFetch = (
  path: string,
  init?: LynxRequestInit,
) => Promise<LynxHttpResponse>;

export type RuntimeFetchDeps = {
  http: LynxHttpClient;
  identity: LynxRuntimeIdentityStore;
  getRelayTunnel?: () => LynxRelayTunnel | null;
};

/**
 * OpenChamber-owned HTTP. Paths like `/health`, `/auth/session`, and
 * `/api/openchamber/…` ride the active runtime (direct URL or injected relay
 * tunnel). Capture identity at call time — do not cache the base URL.
 */
export const createRuntimeFetch = (deps: RuntimeFetchDeps): LynxRuntimeFetch => {
  return async (path, init) => {
    const identity = deps.identity.get();
    if (!identity) {
      return { ok: false, status: 0, json: async () => ({ error: 'no-runtime' }) };
    }
    const headers = { ...init?.headers };
    if (identity.clientToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${identity.clientToken}`;
    }
    const nextInit = { ...init, headers };

    if (identity.transport.kind === 'relay') {
      const tunnel = deps.getRelayTunnel?.();
      if (!tunnel) {
        return { ok: false, status: 0, json: async () => ({ error: 'relay-tunnel-unavailable' }) };
      }
      const response = await tunnel.fetch(path, nextInit);
      return response ?? { ok: false, status: 0, json: async () => ({ error: 'relay-unreachable' }) };
    }

    const base = identity.transport.url.replace(/\/+$/, '');
    const response = await deps.http.request(`${base}${path}`, nextInit);
    if (!response) {
      return { ok: false, status: 0, json: async () => ({ error: 'unreachable' }) };
    }
    return response;
  };
};
