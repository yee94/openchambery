import {
  FAST_PROBE_TIMEOUT_MS,
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_RACE_HEADSTART_MS,
  raceWithTimeout,
  readSessionStatus,
  requestWithTimeout,
} from './http';
import type {
  LynxChosenTransport,
  LynxClock,
  LynxHttpClient,
  LynxRelayConfig,
  LynxRelayTunnel,
  LynxRelayTunnelFactory,
  LynxTransportCandidate,
} from './types';
import { normalizeConnectionUrl, relayCandidateOf } from './urls';

export type ProbeResult =
  | { status: 'ok'; transport: LynxChosenTransport }
  | { status: 'needs-login' }
  | { status: 'unreachable' };

export type ProbeDeps = {
  http: LynxHttpClient;
  clock: LynxClock;
  openRelayTunnel?: LynxRelayTunnelFactory;
  nativeClient?: boolean;
};

type RelayProbeOutcome = 'ok' | 'needs-login' | 'auth-failed' | 'unreachable';

const probeRelaySession = async (
  deps: ProbeDeps,
  relay: LynxTransportCandidate & { kind: 'relay' },
  token: string | undefined,
  grant: string | undefined,
  timeoutMs: number,
): Promise<{ outcome: RelayProbeOutcome; tunnel?: LynxRelayTunnel }> => {
  if (!deps.openRelayTunnel) return { outcome: 'unreachable' };
  const tunnel = deps.openRelayTunnel(relay.relay, grant);
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const session = await raceWithTimeout(
    timeoutMs,
    tunnel.fetch('/auth/session', { headers }).catch(() => null),
  );
  const finish = (outcome: RelayProbeOutcome) => {
    if (outcome !== 'ok') tunnel.close();
    return { outcome, tunnel: outcome === 'ok' ? tunnel : undefined };
  };
  if (!session) return finish('unreachable');
  if (session.status === 401) return finish(token ? 'auth-failed' : 'needs-login');
  if (!session.ok && session.status !== 404) return finish('auth-failed');
  const status = await readSessionStatus(session);
  if (status && status.disabled !== true && status.authenticated === false) {
    return finish(token ? 'auth-failed' : 'needs-login');
  }
  return finish('ok');
};

const probeDirectChain = async (
  deps: ProbeDeps,
  directs: Array<{ kind: 'direct'; url: string }>,
  token: string | undefined,
  expectedServerId: string | null,
  requestOptions?: { totalTimeoutMs?: number },
): Promise<ProbeResult> => {
  for (const candidate of directs) {
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const health = await requestWithTimeout(deps.http, `${url}/health`, { method: 'GET' }, requestOptions);
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
      if (typeof reported === 'string' && reported && reported !== expectedServerId) continue;
    }
    const session = await requestWithTimeout(
      deps.http,
      `${url}/auth/session`,
      { method: 'GET', headers },
      requestOptions,
    );
    if (session?.status === 401) return { status: 'needs-login' };
    if (!session || (!session.ok && session.status !== 404)) continue;
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) return { status: 'needs-login' };
    const authDisabled = status?.disabled === true;
    if (!token && deps.nativeClient && !authDisabled && status?.scope !== 'client') {
      return { status: 'needs-login' };
    }
    return { status: 'ok', transport: { kind: 'direct', url } };
  }
  return { status: 'unreachable' };
};

export const probeConnectionCandidates = async (
  candidates: LynxTransportCandidate[],
  token: string | undefined,
  deps: ProbeDeps,
  options?: { fast?: boolean },
): Promise<ProbeResult> => {
  const requestOptions = options?.fast ? { totalTimeoutMs: FAST_PROBE_TIMEOUT_MS } : undefined;
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  const relayCandidate = candidates.find((candidate): candidate is Extract<LynxTransportCandidate, { kind: 'relay' }> => (
    candidate.kind === 'relay'
  )) ?? null;
  const directList = candidates.filter((candidate): candidate is Extract<LynxTransportCandidate, { kind: 'direct' }> => (
    candidate.kind === 'direct'
  ));

  const probeRelay = async (): Promise<ProbeResult> => {
    if (!relayCandidate) return { status: 'unreachable' };
    const { outcome, tunnel } = await probeRelaySession(
      deps,
      relayCandidate,
      token,
      undefined,
      options?.fast ? FAST_PROBE_TIMEOUT_MS : RELAY_CONNECT_TIMEOUT_MS,
    );
    if (outcome === 'ok') {
      tunnel?.close();
      return { status: 'ok', transport: { kind: 'relay', relay: relayCandidate.relay } };
    }
    if (outcome === 'needs-login' || outcome === 'auth-failed') return { status: 'needs-login' };
    return { status: 'unreachable' };
  };

  if (!relayCandidate) return probeDirectChain(deps, directList, token, expectedServerId, requestOptions);
  if (directList.length === 0) return probeRelay();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let relayCancelled = false;
    let relayStarted = false;
    let directResult: ProbeResult | null = null;
    let relayResult: ProbeResult | null = null;
    let headstartDone = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const startRelayProbe = () => {
      if (relayCancelled || settled || relayStarted) return;
      relayStarted = true;
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

    void probeDirectChain(deps, directList, token, expectedServerId, requestOptions).then((result) => {
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

    void deps.clock.sleep(RELAY_RACE_HEADSTART_MS).then(() => {
      headstartDone = true;
      if (!headstartDone) return;
      startRelayProbe();
    });
  });
};

export type LiveTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: LynxRelayConfig; tunnel: LynxRelayTunnel };

export const establishLiveTransport = async (
  candidates: LynxTransportCandidate[],
  deps: ProbeDeps,
): Promise<LiveTransport | null> => {
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      if (!deps.openRelayTunnel) continue;
      const tunnel = deps.openRelayTunnel(candidate.relay);
      const health = await raceWithTimeout(
        RELAY_CONNECT_TIMEOUT_MS,
        tunnel.fetch('/health').catch(() => null),
      );
      if (health?.ok) return { kind: 'relay', relay: candidate.relay, tunnel };
      tunnel.close();
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await requestWithTimeout(deps.http, `${url}/health`, { method: 'GET' });
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
      if (typeof reported === 'string' && reported && reported !== expectedServerId) continue;
    }
    return { kind: 'direct', url };
  }
  return null;
};

export const validateMobileConnectionSession = async (
  input: { url: string; clientToken?: string | null },
  deps: ProbeDeps,
  options?: { fast?: boolean },
): Promise<boolean> => {
  let url = '';
  try {
    url = normalizeConnectionUrl(input.url);
  } catch {
    return false;
  }
  if (!url) return false;
  const token = input.clientToken?.trim() || undefined;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const requestOptions = options?.fast ? { totalTimeoutMs: FAST_PROBE_TIMEOUT_MS } : undefined;
  const health = await requestWithTimeout(deps.http, `${url}/health`, { method: 'GET' }, requestOptions);
  if (!health?.ok) return false;
  const session = await requestWithTimeout(
    deps.http,
    `${url}/auth/session`,
    { method: 'GET', headers },
    requestOptions,
  );
  if (!session || (!session.ok && session.status !== 404)) return false;
  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};
