/**
 * Host HTTP client inject — Cap/OpenCode fetch spirit for Lynx.
 * iOS: URLSession dataTask. Android: OkHttp Call.
 * Direct `createFetchHttpClient` works in JS; host binder is for TLS pinning,
 * cookie jars, and relay tunnel streaming bodies the Lynx runtime cannot own.
 */
import type { LynxHttpClient, LynxHttpResponse, LynxRequestInit } from '../connection/types';
import { createFetchHttpClient } from '../connection/http';

export type LynxHostHttpRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds; host should cancel the native call. */
  timeoutMs?: number;
};

export type LynxHostHttpResponse = {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  bodyText?: string;
  /** When host can stream SSE — optional progressive body. */
  bodyStream?: ReadableStream<Uint8Array> | null;
};

export type LynxHttpClientBinder = {
  request: (input: LynxHostHttpRequest) => Promise<LynxHostHttpResponse | null>;
};

export type LynxHttpClientAdapter = LynxHttpClient & {
  inject: (binder: LynxHttpClientBinder | null) => void;
  isHostBound: () => boolean;
  /** Prefer host when injected; else fetch. */
  asClient: () => LynxHttpClient;
};

export const createLynxHttpClientAdapter = (): LynxHttpClientAdapter => {
  let binder: LynxHttpClientBinder | null = null;
  const fallback = createFetchHttpClient();

  const hostClient: LynxHttpClient = {
    request: async (url, init?: LynxRequestInit): Promise<LynxHttpResponse | null> => {
      if (!binder) return fallback.request(url, init);
      try {
        const raw = await binder.request({
          url,
          method: init?.method || 'GET',
          headers: init?.headers,
          body: init?.body,
        });
        if (!raw) return null;
        return {
          ok: raw.ok,
          status: raw.status,
          json: async () => {
            const text = raw.bodyText ?? '';
            if (!text) return null;
            return JSON.parse(text) as unknown;
          },
          text: async () => raw.bodyText ?? '',
          body: raw.bodyStream ?? null,
        };
      } catch {
        return null;
      }
    },
  };

  return {
    inject: (next) => {
      binder = next;
    },
    isHostBound: () => binder !== null,
    request: (url, init) => hostClient.request(url, init),
    asClient: () => (binder ? hostClient : fallback),
  };
};
