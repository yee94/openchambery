import {
  directCandidatesOf,
  normalizeConnectionUrl,
  probeConnectionCandidates,
  probeNeedsLogin,
  probeOk,
  probeUnreachable,
  relayCandidateOf,
  type CandidateProbeOutcome,
  type MobileRelayConfig,
  type MobileTransportCandidate,
} from '@/lib/connectionCandidates';
import { mobileClientDedupeKey, mobileDevicePlatform } from '@/lib/deviceId';
import { createRelayTunnelClient, type RelayTunnelClient } from '@/lib/relay/tunnel-client';

export const MOBILE_CONNECT_TIMEOUT_MS = 8_000;
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;

export type SessionStatus = {
  authenticated?: boolean;
  disabled?: boolean;
  scope?: string;
};

export type PairingRedeemResponse = {
  ok?: boolean;
  clientToken?: unknown;
  token?: unknown;
  client?: { label?: unknown; token?: unknown } | null;
  server?: { label?: unknown; url?: unknown } | null;
};

export type RedeemPairingResult =
  | { ok: true; clientToken: string; serverLabel?: string }
  | { ok: false; reason: 'http' | 'no-token' | 'unreachable' };

/** Cap-parity: pull clientToken from redeem JSON even if nested oddly. */
export const parsePairingRedeemToken = (body: unknown): string => {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const nested =
    record.client && typeof record.client === 'object'
      ? (record.client as Record<string, unknown>).token
      : undefined;
  for (const candidate of [record.clientToken, record.token, nested]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
};

export const parsePairingRedeemServerLabel = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const server = (body as PairingRedeemResponse).server;
  return typeof server?.label === 'string' && server.label.trim() ? server.label.trim() : undefined;
};

export const isAuthDisabledSession = (status: SessionStatus | null | undefined): boolean =>
  status?.disabled === true;

export type LiveTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig; tunnel: RelayTunnelClient };

export type ChosenTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig; tunnel?: RelayTunnelClient };

type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type ConnectionHttp = {
  request: (url: string, init?: RequestInit) => Promise<FetchLikeResponse | null>;
};

const defaultHttp: ConnectionHttp = {
  request: async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MOBILE_CONNECT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => {
          try {
            return await response.json();
          } catch {
            return null;
          }
        },
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

let httpBackend: ConnectionHttp = defaultHttp;

export const setConnectionHttp = (next: ConnectionHttp | null): void => {
  httpBackend = next ?? defaultHttp;
};

const raceWithTimeout = async <T,>(timeoutMs: number, operation: Promise<T | null>): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T | null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

export const readSessionStatus = async (
  response: { json: () => Promise<unknown> } | null,
): Promise<SessionStatus | null> => {
  if (!response) return null;
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  return {
    authenticated: typeof record.authenticated === 'boolean' ? record.authenticated : undefined,
    disabled: typeof record.disabled === 'boolean' ? record.disabled : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
};

export type OpenRelaySession = (relay: MobileRelayConfig) => RelayTunnelClient;

const defaultOpenRelay: OpenRelaySession = (relay) =>
  createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(relay.grant ? { grant: relay.grant } : {}),
  });

let openRelaySession: OpenRelaySession = defaultOpenRelay;

export const setOpenRelaySession = (next: OpenRelaySession | null): void => {
  openRelaySession = next ?? defaultOpenRelay;
};

const probeDirectChain = async (
  candidates: MobileTransportCandidate[],
  token: string | undefined,
): Promise<CandidateProbeOutcome<ChosenTransport>> => {
  const expectedServerId = relayCandidateOf(candidates)?.serverId ?? null;
  for (const candidate of directCandidatesOf(candidates)) {
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await httpBackend.request(`${url}/health`, { method: 'GET' });
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
      if (typeof reported === 'string' && reported && reported !== expectedServerId) {
        console.info('[mobile-connect]', 'probe:server-id-mismatch', JSON.stringify({ url }));
        continue;
      }
    }
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const session = await httpBackend.request(`${url}/auth/session`, {
      method: 'GET',
      headers,
    });
    if (session?.status === 401) return probeNeedsLogin();
    if (!session || (!session.ok && session.status !== 404)) continue;
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) return probeNeedsLogin();
    // Native runtime needs a bearer token unless auth is disabled or scope is already client.
    const authDisabled = isAuthDisabledSession(status);
    if (!token && !authDisabled && status?.scope !== 'client') return probeNeedsLogin();
    return probeOk({ kind: 'direct', url });
  }
  return probeUnreachable();
};

const probeRelaySession = async (
  relay: MobileRelayConfig,
  token: string | undefined,
): Promise<CandidateProbeOutcome<ChosenTransport>> => {
  const tunnel = openRelaySession(relay);
  const finish = (outcome: CandidateProbeOutcome<ChosenTransport>) => {
    if (outcome.status === 'ok') return outcome;
    tunnel.close();
    return outcome;
  };
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const session = await raceWithTimeout(
      RELAY_CONNECT_TIMEOUT_MS,
      tunnel.fetch('/auth/session', { headers }).then((r) => r as FetchLikeResponse).catch(() => null),
    );
    console.info('[mobile-connect]', 'relay:session', JSON.stringify({
      ok: session?.ok === true,
      status: session?.status ?? null,
      hasToken: Boolean(token),
    }));
    if (!session) return finish(probeUnreachable());
    if (session.status === 401) return finish(probeNeedsLogin());
    if (!session.ok && session.status !== 404) return finish(probeUnreachable());
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) {
      return finish(probeNeedsLogin());
    }
    return finish(probeOk({ kind: 'relay', relay, tunnel }, () => tunnel.close()));
  } catch (error) {
    tunnel.close();
    console.warn('[mobile-connect] relay probe threw', error);
    return probeUnreachable();
  }
};

/** Full Cap-compatible probe over live candidates. */
export const probeSavedCandidates = async (
  candidates: MobileTransportCandidate[],
  token: string | undefined,
  options?: {
    headstartMs?: number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<CandidateProbeOutcome<ChosenTransport>> => {
  const relay = relayCandidateOf(candidates);
  const directs = directCandidatesOf(candidates);
  return probeConnectionCandidates({
    hasDirect: directs.length > 0,
    hasRelay: Boolean(relay),
    probeDirects: () => probeDirectChain(candidates, token),
    probeRelay: () => (relay ? probeRelaySession(relay, token) : Promise.resolve(probeUnreachable())),
    headstartMs: options?.headstartMs,
    wait: options?.wait,
  });
};

export const establishLiveTransport = async (
  candidates: MobileTransportCandidate[],
): Promise<LiveTransport | null> => {
  const expectedServerId = relayCandidateOf(candidates)?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      const tunnel = openRelaySession(candidate.relay);
      const health = await raceWithTimeout(
        RELAY_CONNECT_TIMEOUT_MS,
        tunnel.fetch('/health').then((r) => r as FetchLikeResponse).catch(() => null),
      );
      if (health?.ok) return { kind: 'relay', relay: candidate.relay, tunnel };
      tunnel.close();
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await httpBackend.request(`${url}/health`, { method: 'GET' });
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

export const postAuthSession = async (
  transport: LiveTransport,
  password: string,
): Promise<{ ok: boolean; clientToken?: string }> => {
  const dedupeKey = await mobileClientDedupeKey();
  const body = JSON.stringify({
    password,
    trustDevice: true,
    issueClientToken: true,
    clientLabel: 'OpenChamber Expo',
    clientKind: 'mobile',
    devicePlatform: mobileDevicePlatform(),
    dedupeKey,
  });
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  };
  const response =
    transport.kind === 'relay'
      ? await raceWithTimeout(
          RELAY_CONNECT_TIMEOUT_MS,
          transport.tunnel.fetch('/auth/session', init).then((r) => r as FetchLikeResponse).catch(() => null),
        )
      : await httpBackend.request(`${transport.url}/auth/session`, init);
  if (!response?.ok) return { ok: false };
  const json = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
  const issued = typeof json?.clientToken === 'string' ? json.clientToken.trim() : '';
  return { ok: true, clientToken: issued || undefined };
};

export const redeemPairing = async (
  transport: LiveTransport,
  input: { pairingId: string; secret: string },
): Promise<RedeemPairingResult> => {
  const dedupeKey = await mobileClientDedupeKey();
  const body = JSON.stringify({
    pairingId: input.pairingId,
    secret: input.secret,
    clientLabel: 'OpenChamber Expo',
    clientKind: 'mobile',
    deviceName: 'OpenChamber Expo',
    // Cap parity — server stores this on the device row.
    devicePlatform: mobileDevicePlatform(),
    dedupeKey,
  });
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  };
  const response =
    transport.kind === 'relay'
      ? await raceWithTimeout(
          RELAY_CONNECT_TIMEOUT_MS,
          transport.tunnel
            .fetch('/api/client-auth/pairing/redeem', init)
            .then((r) => r as FetchLikeResponse)
            .catch(() => null),
        )
      : await httpBackend.request(`${transport.url}/api/client-auth/pairing/redeem`, init);
  if (!response) return { ok: false, reason: 'unreachable' };
  if (!response.ok) return { ok: false, reason: 'http' };
  const json = await response.json().catch(() => null);
  const issued = parsePairingRedeemToken(json);
  if (!issued) return { ok: false, reason: 'no-token' };
  return { ok: true, clientToken: issued, serverLabel: parsePairingRedeemServerLabel(json) };
};

/** GET /auth/session on an already-live transport (pairing fallback / auth-disabled check). */
export const fetchSessionOnTransport = async (
  transport: LiveTransport,
  token?: string,
): Promise<SessionStatus | null> => {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response =
    transport.kind === 'relay'
      ? await raceWithTimeout(
          RELAY_CONNECT_TIMEOUT_MS,
          transport.tunnel.fetch('/auth/session', { headers }).then((r) => r as FetchLikeResponse).catch(() => null),
        )
      : await httpBackend.request(`${transport.url}/auth/session`, {
          method: 'GET',
          headers,
        });
  if (!response || (!response.ok && response.status !== 404)) return null;
  return readSessionStatus(response);
};
