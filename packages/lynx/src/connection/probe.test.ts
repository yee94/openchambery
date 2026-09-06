import { describe, expect, test } from 'vitest';

import { RELAY_RACE_HEADSTART_MS } from './http';
import { probeConnectionCandidates, type ProbeDeps } from './probe';
import type { LynxClock, LynxHttpResponse, LynxRelayConfig, LynxRequestInit } from './types';

const relay: LynxRelayConfig = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_home',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const createClock = () => {
  const sleeps: number[] = [];
  const clock: LynxClock = {
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { clock, sleeps };
};

describe('probeConnectionCandidates (connect race harness)', () => {
  test('relay-only does not sleep the 1.5s LAN headstart', async () => {
    const { clock, sleeps } = createClock();
    const tunnelFetches: string[] = [];
    const deps: ProbeDeps = {
      http: { request: async () => jsonResponse(500, {}) },
      clock,
      nativeClient: true,
      openRelayTunnel: () => ({
        fetch: async (path) => {
          tunnelFetches.push(path);
          return jsonResponse(200, { authenticated: true, scope: 'client' });
        },
        close: () => undefined,
      }),
    };

    const result = await probeConnectionCandidates(
      [{ kind: 'relay', relay }],
      'tok',
      deps,
    );

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.transport.kind : null).toBe('relay');
    expect(sleeps).not.toContain(RELAY_RACE_HEADSTART_MS);
    expect(tunnelFetches).toEqual(['/auth/session']);
  });

  test('LAN success wins after a live /health + /auth/session (relay headstart is scheduled, not a Bonjour browse)', async () => {
    const { clock, sleeps } = createClock();
    const deps: ProbeDeps = {
      http: {
        request: async (url) => {
          if (url.endsWith('/health')) return jsonResponse(200, { serverId: 'srv_home' });
          if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
          return jsonResponse(404, {});
        },
      },
      clock,
      nativeClient: true,
      openRelayTunnel: () => ({
        fetch: async () => new Promise<LynxHttpResponse>(() => undefined),
        close: () => undefined,
      }),
    };

    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.20:4096' }, { kind: 'relay', relay }],
      'tok',
      deps,
    );

    expect(result).toEqual({ status: 'ok', transport: { kind: 'direct', url: 'http://192.168.1.20:4096' } });
    expect(sleeps).toContain(RELAY_RACE_HEADSTART_MS);
  });

  test('dead LAN starts relay immediately (does not wait out a leftover headstart)', async () => {
    const { clock } = createClock();
    let resolveSleep: (() => void) | undefined;
    const hangingClock: LynxClock = {
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => {
        resolveSleep = resolve;
      }),
    };
    const deps: ProbeDeps = {
      http: { request: async () => jsonResponse(503, {}) },
      clock: hangingClock,
      nativeClient: true,
      openRelayTunnel: () => ({
        fetch: async () => jsonResponse(200, { authenticated: true, scope: 'client' }),
        close: () => undefined,
      }),
    };

    const resultPromise = probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.20:4096' }, { kind: 'relay', relay }],
      'tok',
      deps,
    );
    const result = await resultPromise;
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.transport.kind : null).toBe('relay');
    resolveSleep?.();
    void clock;
  });

  test('401 on LAN is needs-login for every transport (same token)', async () => {
    const { clock } = createClock();
    const deps: ProbeDeps = {
      http: {
        request: async (url) => {
          if (url.endsWith('/health')) return jsonResponse(200, {});
          return jsonResponse(401, { authenticated: false });
        },
      },
      clock,
      nativeClient: true,
    };
    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.20:4096' }],
      'expired',
      deps,
    );
    expect(result).toEqual({ status: 'needs-login' });
  });

  test('skips a direct candidate whose /health serverId mismatches the paired relay', async () => {
    const { clock } = createClock();
    const seenAuth: string[] = [];
    const deps: ProbeDeps = {
      http: {
        request: async (url, _init?: LynxRequestInit) => {
          if (url.includes('192.168.1.20') && url.endsWith('/health')) {
            return jsonResponse(200, { serverId: 'srv_other' });
          }
          if (url.endsWith('/auth/session')) {
            seenAuth.push(url);
            return jsonResponse(200, { authenticated: true, scope: 'client' });
          }
          return jsonResponse(503, {});
        },
      },
      clock,
      nativeClient: true,
      openRelayTunnel: () => ({
        fetch: async () => jsonResponse(200, { authenticated: true, scope: 'client' }),
        close: () => undefined,
      }),
    };
    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.20:4096' }, { kind: 'relay', relay }],
      'tok',
      deps,
    );
    expect(seenAuth).toEqual([]);
    expect(result.status === 'ok' ? result.transport.kind : null).toBe('relay');
  });

  test('native without a client-scoped token is needs-login even when a cookie session is present', async () => {
    const { clock } = createClock();
    const deps: ProbeDeps = {
      http: {
        request: async (url) => {
          if (url.endsWith('/health')) return jsonResponse(200, {});
          return jsonResponse(200, { authenticated: true, scope: 'session' });
        },
      },
      clock,
      nativeClient: true,
    };
    const result = await probeConnectionCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.20:4096' }],
      undefined,
      deps,
    );
    expect(result).toEqual({ status: 'needs-login' });
  });
});
