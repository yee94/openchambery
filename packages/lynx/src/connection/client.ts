import type { PairingConnectionPayload } from '../pairing/payload';
import { createUuid } from '../uuid';
import { createRuntimeFetch, type LynxRuntimeFetch } from '../runtime/fetch';
import { createRuntimeIdentityStore, type LynxRuntimeIdentityStore } from '../runtime/identity';
import { buildCandidatesFromInput, candidateSetsMatch, pairingCandidatesToMobile } from './candidates';
import {
  RELAY_CONNECT_TIMEOUT_MS,
  createFetchHttpClient,
  createSystemClock,
  raceWithTimeout,
  requestWithTimeout,
} from './http';
import {
  deleteSecureToken,
  mobileClientDedupeKey,
  readConnections,
  readSecureToken,
  upsertConnectionInList,
  writeConnections,
  writeSecureToken,
} from './persist';
import { establishLiveTransport, probeConnectionCandidates, validateMobileConnectionSession } from './probe';
import type {
  LynxClock,
  LynxConnectInput,
  LynxConnectResult,
  LynxDevicePlatform,
  LynxHttpClient,
  LynxKvStore,
  LynxPendingConnection,
  LynxRelayTunnelFactory,
  LynxSavedConnection,
  LynxSecureStore,
  LynxTransportCandidate,
} from './types';
import {
  connectionDisplayUrl,
  getConnectionLabel,
  relayCandidateOf,
  secureTokenKeyOf,
} from './urls';

const CLIENT_LABEL = 'OpenChamber Mobile';

export type LynxConnectionClientDeps = {
  http?: LynxHttpClient;
  clock?: LynxClock;
  metadataStore: LynxKvStore;
  secureStore: LynxSecureStore;
  openRelayTunnel?: LynxRelayTunnelFactory;
  getDevicePlatform?: () => LynxDevicePlatform | undefined;
  identity?: LynxRuntimeIdentityStore;
};

export type LynxConnectionClient = {
  identity: LynxRuntimeIdentityStore;
  runtimeFetch: LynxRuntimeFetch;
  loadConnections: () => LynxSavedConnection[];
  upsert: (draft: {
    id?: string;
    label: string;
    candidates: LynxTransportCandidate[];
    clientToken?: string;
  }) => Promise<LynxSavedConnection[]>;
  remove: (id: string) => Promise<LynxSavedConnection[]>;
  connect: (input: LynxConnectInput) => Promise<LynxConnectResult>;
  redeemPairingConnection: (payload: PairingConnectionPayload) => Promise<LynxConnectResult>;
  submitPassword: (pending: LynxPendingConnection, password: string) => Promise<LynxConnectResult>;
  autoConnectLastInstance: () => Promise<boolean>;
  validateSession: (input: { url: string; clientToken?: string | null }) => Promise<boolean>;
};

const persistDraft = async (
  deps: Required<Pick<LynxConnectionClientDeps, 'metadataStore' | 'secureStore'>> & { clock: LynxClock },
  draft: {
    id?: string;
    label: string;
    candidates: LynxTransportCandidate[];
    clientToken?: string;
  },
): Promise<LynxSavedConnection[]> => {
  if (draft.clientToken) {
    const stored = await writeSecureToken(deps.secureStore, { candidates: draft.candidates }, draft.clientToken);
    if (!stored) throw new Error('secure-store-failed');
  }
  const next = upsertConnectionInList(readConnections(deps.metadataStore), {
    id: draft.id,
    label: draft.label,
    candidates: draft.candidates,
    hasToken: Boolean(draft.clientToken) || undefined,
    now: deps.clock.now(),
  });
  writeConnections(deps.metadataStore, next);
  return next;
};

const resolveToken = async (
  deps: Required<Pick<LynxConnectionClientDeps, 'secureStore' | 'metadataStore'>>,
  input: LynxConnectInput,
  saved: LynxSavedConnection | undefined,
): Promise<string | undefined> => {
  const explicit = input.clientToken?.trim() || undefined;
  if (explicit) return explicit;
  if (!saved?.hasToken) return undefined;
  return readSecureToken(deps.secureStore, saved);
};

const redeemBody = (
  payload: PairingConnectionPayload,
  metadataStore: LynxKvStore,
  platform: LynxDevicePlatform | undefined,
): string => JSON.stringify({
  pairingId: payload.pairingId,
  secret: payload.secret,
  clientLabel: CLIENT_LABEL,
  clientKind: 'mobile',
  deviceName: CLIENT_LABEL,
  devicePlatform: platform,
  dedupeKey: mobileClientDedupeKey(metadataStore),
});

const passwordBody = (
  password: string,
  metadataStore: LynxKvStore,
  platform: LynxDevicePlatform | undefined,
): string => JSON.stringify({
  password,
  trustDevice: true,
  issueClientToken: true,
  clientLabel: CLIENT_LABEL,
  clientKind: 'mobile',
  devicePlatform: platform,
  dedupeKey: mobileClientDedupeKey(metadataStore),
});

export const createLynxConnectionClient = (input: LynxConnectionClientDeps): LynxConnectionClient => {
  const http = input.http ?? createFetchHttpClient();
  const clock = input.clock ?? createSystemClock();
  const identity = input.identity ?? createRuntimeIdentityStore();
  const nativeClient = true;
  const probeDeps = {
    http,
    clock,
    openRelayTunnel: input.openRelayTunnel,
    nativeClient,
  };
  const runtimeFetch = createRuntimeFetch({ http, identity });

  const loadConnections = (): LynxSavedConnection[] => readConnections(input.metadataStore);

  const upsert: LynxConnectionClient['upsert'] = async (draft) => persistDraft(
    { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
    draft,
  );

  const remove: LynxConnectionClient['remove'] = async (id) => {
    const connections = loadConnections();
    const removed = connections.find((connection) => connection.id === id);
    const next = connections.filter((connection) => connection.id !== id);
    writeConnections(input.metadataStore, next);
    if (removed) await deleteSecureToken(input.secureStore, removed);
    const active = identity.get();
    if (removed && active && secureTokenKeyOf(removed) === active.runtimeKey) {
      identity.clear();
    }
    return next;
  };

  const connect: LynxConnectionClient['connect'] = async (connectInput) => {
    try {
      const saved = connectInput.id
        ? loadConnections().find((connection) => connection.id === connectInput.id)
        : undefined;
      const candidates = buildCandidatesFromInput(connectInput);
      const resolvedCandidates = candidates.length > 0 ? candidates : (saved?.candidates ?? []);
      if (resolvedCandidates.length === 0) return { status: 'failed', error: 'url-required' };
      const matched = saved ?? loadConnections().find((connection) => (
        candidateSetsMatch(connection.candidates, resolvedCandidates)
      ));
      const label = connectInput.label?.trim()
        || matched?.label
        || getConnectionLabel(connectionDisplayUrl({ candidates: resolvedCandidates }));
      const token = await resolveToken(
        { secureStore: input.secureStore, metadataStore: input.metadataStore },
        connectInput,
        matched,
      );
      const result = await probeConnectionCandidates(resolvedCandidates, token, probeDeps);
      if (result.status === 'unreachable') return { status: 'failed', error: 'unreachable' };
      if (result.status === 'needs-login') {
        await persistDraft(
          { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
          { id: matched?.id, label, candidates: resolvedCandidates },
        );
        return {
          status: 'needs-login',
          pending: {
            id: matched?.id ?? createUuid(),
            label,
            candidates: resolvedCandidates,
            relay: relayCandidateOf({ candidates: resolvedCandidates }) ?? undefined,
            relayGrant: connectInput.relayGrant,
          },
        };
      }
      const runtimeKey = secureTokenKeyOf({ candidates: resolvedCandidates });
      if (connectInput.clientToken?.trim()) {
        const stored = await writeSecureToken(input.secureStore, { candidates: resolvedCandidates }, connectInput.clientToken.trim());
        if (!stored) return { status: 'failed', error: 'secure-store-failed' };
      }
      const connections = await persistDraft(
        { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
        { id: matched?.id, label, candidates: resolvedCandidates, clientToken: token },
      );
      const connection = connections[0]!;
      identity.switchToTransport(result.transport, token ?? null, runtimeKey);
      return { status: 'connected', connection, transport: result.transport, runtimeKey };
    } catch {
      return { status: 'failed', error: 'invalid-url' };
    }
  };

  const redeemPairingConnection: LynxConnectionClient['redeemPairingConnection'] = async (payload) => {
    const deviceCandidates = pairingCandidatesToMobile(payload.candidates);
    const chosen = await establishLiveTransport(deviceCandidates, probeDeps);
    if (!chosen) return { status: 'failed', error: 'unreachable' };
    const body = redeemBody(payload, input.metadataStore, input.getDevicePlatform?.());
    const redeemInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    };
    try {
      const response = chosen.kind === 'relay'
        ? await raceWithTimeout(
          RELAY_CONNECT_TIMEOUT_MS,
          chosen.tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit),
        )
        : await requestWithTimeout(
          http,
          `${chosen.url}/api/client-auth/pairing/redeem`,
          redeemInit,
        );
      if (!response?.ok) return { status: 'failed', error: 'auth-required' };
      const result = await response.json().catch(() => null) as { clientToken?: unknown; server?: { label?: unknown } } | null;
      const issuedToken = typeof result?.clientToken === 'string' ? result.clientToken.trim() : '';
      if (!issuedToken) return { status: 'failed', error: 'auth-required' };
      const serverLabel = typeof result?.server?.label === 'string' ? result.server.label : '';
      const label = payload.label || serverLabel || getConnectionLabel(connectionDisplayUrl({ candidates: deviceCandidates }));
      const runtimeKey = secureTokenKeyOf({ candidates: deviceCandidates });
      const stored = await writeSecureToken(input.secureStore, { candidates: deviceCandidates }, issuedToken);
      if (!stored) return { status: 'failed', error: 'secure-store-failed' };
      const connections = await persistDraft(
        { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
        { label, candidates: deviceCandidates, clientToken: issuedToken },
      );
      const transport = chosen.kind === 'relay'
        ? { kind: 'relay' as const, relay: chosen.relay }
        : { kind: 'direct' as const, url: chosen.url };
      identity.switchToTransport(transport, issuedToken, runtimeKey);
      if (chosen.kind === 'relay') chosen.tunnel.close();
      return { status: 'connected', connection: connections[0]!, transport, runtimeKey };
    } catch {
      if (chosen.kind === 'relay') chosen.tunnel.close();
      return { status: 'failed', error: 'auth-required' };
    }
  };

  const submitPassword: LynxConnectionClient['submitPassword'] = async (pending, password) => {
    if (!password.trim()) return { status: 'failed', error: 'password-failed' };
    const chosen = await establishLiveTransport(pending.candidates, probeDeps);
    if (!chosen) return { status: 'failed', error: 'unreachable' };
    const loginInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: passwordBody(password, input.metadataStore, input.getDevicePlatform?.()),
    };
    try {
      const response = chosen.kind === 'relay'
        ? await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, chosen.tunnel.fetch('/auth/session', loginInit))
        : await requestWithTimeout(http, `${chosen.url}/auth/session`, loginInit);
      if (!response?.ok) return { status: 'failed', error: 'password-failed' };
      const body = await response.json().catch(() => null) as { clientToken?: unknown } | null;
      const issuedToken = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      if (!issuedToken) return { status: 'failed', error: 'auth-required' };
      const stored = await writeSecureToken(input.secureStore, { candidates: pending.candidates }, issuedToken);
      if (!stored) return { status: 'failed', error: 'secure-store-failed' };
      const connections = await persistDraft(
        { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
        { id: pending.id, label: pending.label, candidates: pending.candidates, clientToken: issuedToken },
      );
      const transport = chosen.kind === 'relay'
        ? { kind: 'relay' as const, relay: chosen.relay }
        : { kind: 'direct' as const, url: chosen.url };
      const runtimeKey = secureTokenKeyOf({ candidates: pending.candidates });
      identity.switchToTransport(transport, issuedToken, runtimeKey);
      if (chosen.kind === 'relay') chosen.tunnel.close();
      return { status: 'connected', connection: connections[0]!, transport, runtimeKey };
    } catch {
      if (chosen.kind === 'relay') chosen.tunnel.close();
      return { status: 'failed', error: 'password-failed' };
    }
  };

  const autoConnectLastInstance = async (): Promise<boolean> => {
    const candidate = loadConnections()[0];
    if (!candidate?.hasToken) return false;
    const token = await readSecureToken(input.secureStore, candidate);
    if (!token) return false;
    const result = await probeConnectionCandidates(candidate.candidates, token, probeDeps);
    if (result.status !== 'ok') return false;
    await persistDraft(
      { metadataStore: input.metadataStore, secureStore: input.secureStore, clock },
      { id: candidate.id, label: candidate.label, candidates: candidate.candidates },
    );
    identity.switchToTransport(result.transport, token, secureTokenKeyOf(candidate));
    return true;
  };

  const validateSession: LynxConnectionClient['validateSession'] = (sessionInput) =>
    validateMobileConnectionSession(sessionInput, probeDeps);

  return {
    identity,
    runtimeFetch,
    loadConnections,
    upsert,
    remove,
    connect,
    redeemPairingConnection,
    submitPassword,
    autoConnectLastInstance,
    validateSession,
  };
};
