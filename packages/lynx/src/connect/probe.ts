import type { LynxHostAdapters } from '../host/adapters.ts';
import { bearerHeaders, isAuthRejection, joinUrl, readHealthServerId, readSessionStatus } from './http.ts';
import { safeLogInfo } from './sanitizeLog.ts';
import {
  LYNX_CONNECT_TIMEOUT_MS,
  LYNX_FAST_PROBE_TIMEOUT_MS,
  LYNX_RELAY_CONNECT_TIMEOUT_MS,
  LYNX_RELAY_RACE_HEADSTART_MS,
  type LynxHttpTransport,
  type LynxProbeResult,
  type LynxRelayConfig,
  type LynxTransportCandidate,
} from './types.ts';
import { normalizeConnectionUrl, relayCandidateOf } from './urls.ts';

export type LiveTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: LynxRelayConfig; tunnel: LynxHttpTransport };

const timeoutFor = (fast?: boolean, relay?: boolean): number => {
  if (fast) return LYNX_FAST_PROBE_TIMEOUT_MS;
  return relay ? LYNX_RELAY_CONNECT_TIMEOUT_MS : LYNX_CONNECT_TIMEOUT_MS;
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const probeDirect = async (
  url: string,
  token: string | undefined,
  expectedServerId: string | null,
  host: LynxHostAdapters,
  timeoutMs: number,
): Promise<LynxProbeResult> => {
  const health = await host.request(joinUrl(url, '/health'), { method: 'GET', timeoutMs }).catch(() => null);
  if (!health?.ok) return { status: 'unreachable' };
  if (expectedServerId) {
    const reported = await readHealthServerId(health);
    if (reported && reported !== expectedServerId) {
      safeLogInfo(host.logger, 'probe:server-id-mismatch', { url });
      return { status: 'unreachable' };
    }
  }
  const session = await host.request(joinUrl(url, '/auth/session'), {
    method: 'GET',
    headers: bearerHeaders(token),
    timeoutMs,
  }).catch(() => null);
  if (session?.status === 401) return { status: 'needs-login' };
  if (!session || (!session.ok && session.status !== 404)) return { status: 'unreachable' };
  const status = await readSessionStatus(session);
  if (isAuthRejection(status)) return { status: 'needs-login' };
  const authDisabled = status?.disabled === true;
  if (!token && !authDisabled && status?.scope !== 'client') return { status: 'needs-login' };
  return { status: 'ok', transport: { kind: 'direct', url } };
};

const probeRelaySession = async (
  relay: LynxRelayConfig,
  token: string | undefined,
  grant: string | undefined,
  host: LynxHostAdapters,
  timeoutMs: number,
): Promise<LynxProbeResult> => {
  if (!host.openRelay) return { status: 'unreachable' };
  let tunnel: LynxHttpTransport | null = null;
  try {
    tunnel = await host.openRelay(relay, grant);
    const session = await tunnel.fetch('/auth/session', {
      method: 'GET',
      headers: bearerHeaders(token),
      timeoutMs,
    }).catch(() => null);
    safeLogInfo(host.logger, 'relay:session', {
      ok: session?.ok === true,
      status: session?.status ?? null,
      hasToken: Boolean(token),
    });
    if (!session) return { status: 'unreachable' };
    if (session.status === 401) return { status: token ? 'needs-login' : 'needs-login' };
    if (!session.ok && session.status !== 404) return { status: 'needs-login' };
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) {
      return { status: token ? 'needs-login' : 'needs-login' };
    }
    return { status: 'ok', transport: { kind: 'relay', relay } };
  } catch {
    return { status: 'unreachable' };
  } finally {
    tunnel?.close?.();
  }
};

export const probeConnectionCandidates = async (
  candidates: LynxTransportCandidate[],
  token: string | undefined,
  host: LynxHostAdapters,
  options?: { fast?: boolean; grant?: string },
): Promise<LynxProbeResult> => {
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  const relay = candidates.find((candidate): candidate is Extract<LynxTransportCandidate, { kind: 'relay' }> => candidate.kind === 'relay') ?? null;
  const directs = candidates.filter((candidate): candidate is Extract<LynxTransportCandidate, { kind: 'direct' }> => candidate.kind === 'direct');
  const timeoutMs = timeoutFor(options?.fast, false);
  const relayTimeoutMs = timeoutFor(options?.fast, true);
  const sleep = host.clock?.sleep ?? defaultSleep;

  const probeDirectChain = async (): Promise<LynxProbeResult> => {
    for (const candidate of directs) {
      const url = normalizeConnectionUrl(candidate.url) || candidate.url;
      const result = await probeDirect(url, token, expectedServerId, host, timeoutMs);
      if (result.status !== 'unreachable') return result;
    }
    return { status: 'unreachable' };
  };

  const probeRelay = async (): Promise<LynxProbeResult> => {
    if (!relay) return { status: 'unreachable' };
    return probeRelaySession(relay.relay, token, options?.grant, host, relayTimeoutMs);
  };

  if (!relay) return probeDirectChain();
  if (directs.length === 0) return probeRelay();

  return new Promise<LynxProbeResult>((resolve) => {
    let settled = false;
    let relayCancelled = false;
    let directResult: LynxProbeResult | null = null;
    let relayResult: LynxProbeResult | null = null;
    const abort = new AbortController();

    const finish = (result: LynxProbeResult) => {
      if (settled) return;
      settled = true;
      abort.abort();
      resolve(result);
    };

    const startRelayProbe = () => {
      if (relayCancelled || settled) return;
      void probeRelay().then((result) => {
        relayResult = result;
        if (settled || relayCancelled) return;
        if (result.status === 'ok' || result.status === 'needs-login') {
          finish(result);
          return;
        }
        if (directResult) finish(directResult);
      });
    };

    void probeDirectChain().then((result) => {
      directResult = result;
      if (settled) return;
      if (result.status === 'ok' || result.status === 'needs-login') {
        relayCancelled = true;
        finish(result);
        return;
      }
      if (relayResult) {
        finish(relayResult);
        return;
      }
      startRelayProbe();
    });

    void sleep(LYNX_RELAY_RACE_HEADSTART_MS, abort.signal).then(() => {
      if (!settled && !relayCancelled) startRelayProbe();
    });
  });
};

export const establishLiveTransport = async (
  candidates: LynxTransportCandidate[],
  host: LynxHostAdapters,
  options?: { grant?: string },
): Promise<LiveTransport | null> => {
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      if (!host.openRelay) continue;
      let tunnel: LynxHttpTransport | null = null;
      try {
        tunnel = await host.openRelay(candidate.relay, options?.grant);
        const health = await tunnel.fetch('/health', {
          method: 'GET',
          timeoutMs: LYNX_RELAY_CONNECT_TIMEOUT_MS,
        }).catch(() => null);
        safeLogInfo(host.logger, 'establish:relay:health', {
          ok: health?.ok === true,
          status: health?.status ?? null,
        });
        if (health?.ok) return { kind: 'relay', relay: candidate.relay, tunnel };
        tunnel.close?.();
      } catch {
        tunnel?.close?.();
      }
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await host.request(joinUrl(url, '/health'), {
      method: 'GET',
      timeoutMs: LYNX_CONNECT_TIMEOUT_MS,
    }).catch(() => null);
    safeLogInfo(host.logger, 'establish:direct:health', {
      ok: health?.ok === true,
      status: health?.status ?? null,
    });
    if (!health?.ok) continue;
    if (expectedServerId) {
      const reported = await readHealthServerId(health);
      if (reported && reported !== expectedServerId) {
        safeLogInfo(host.logger, 'establish:server-id-mismatch', { url });
        continue;
      }
    }
    return { kind: 'direct', url };
  }
  return null;
};

export const validateDirectSession = async (
  url: string,
  token: string | undefined,
  host: LynxHostAdapters,
  options?: { fast?: boolean },
): Promise<boolean> => {
  const timeoutMs = timeoutFor(options?.fast, false);
  const health = await host.request(joinUrl(url, '/health'), { method: 'GET', timeoutMs }).catch(() => null);
  if (!health?.ok) return false;
  const session = await host.request(joinUrl(url, '/auth/session'), {
    method: 'GET',
    headers: bearerHeaders(token),
    timeoutMs,
  }).catch(() => null);
  if (!session || (!session.ok && session.status !== 404)) return false;
  const status = await readSessionStatus(session);
  return !isAuthRejection(status, session.status);
};

export const pairingCandidatesToMobile = (
  candidates: Array<
    | { type: 'lan' | 'tunnel'; url: string; priority?: number }
    | { type: 'relay'; relayUrl: string; serverId: string; hostEncPubJwk: JsonWebKey; priority?: number }
  >,
): LynxTransportCandidate[] =>
  [...candidates]
    .sort((left, right) => {
      const delta = (left.priority ?? 100) - (right.priority ?? 100);
      if (delta !== 0) return delta;
      const rank = (candidate: typeof left): number => {
        if (candidate.type === 'relay') return 2;
        return candidate.url.startsWith('https://') ? 0 : 1;
      };
      return rank(left) - rank(right);
    })
    .flatMap((candidate): LynxTransportCandidate[] => {
      if (candidate.type === 'relay') {
        return [{
          kind: 'relay',
          relay: {
            relayUrl: candidate.relayUrl,
            serverId: candidate.serverId,
            hostEncPubJwk: candidate.hostEncPubJwk,
          },
        }];
      }
      try {
        const url = normalizeConnectionUrl(candidate.url);
        return url ? [{ kind: 'direct', url }] : [];
      } catch {
        return [];
      }
    });
