import type { LynxHostAdapters } from '../host/adapters.ts';
import { createLynxDeepLinkInbox, type LynxApplyDeepLinkResult, type LynxDeepLinkInbox } from './applyDeepLink.ts';
import { refreshConnectionCandidates } from './candidates.ts';
import { createLynxId, readOrCreateDeviceId } from './ids.ts';
import { loginWithPasswordOnTransport } from './password.ts';
import {
  establishLiveTransport,
  pairingCandidatesToMobile,
  probeConnectionCandidates,
  validateDirectSession,
} from './probe.ts';
import { qrScanStatusToError, resultFromQrRaw } from './qr.ts';
import { redeemPairingOnTransport } from './redeem.ts';
import { safeLogInfo, safeLogWarn } from './sanitizeLog.ts';
import {
  createLynxConnectionStore,
  deleteSecureToken,
  migrateLegacyInlineTokens,
  readSecureToken,
  writeSecureToken,
  type LynxConnectionStore,
} from './store.ts';
import {
  type LynxConnectError,
  type LynxConnectInput,
  type LynxConnectPhase,
  type LynxPairingConnectionPayload,
  type LynxPendingConnection,
  type LynxReprobeOutcome,
  type LynxSavedConnection,
  type LynxTransportCandidate,
} from './types.ts';
import {
  candidateSetsMatch,
  connectionDisplayUrl,
  directCandidates,
  getConnectionLabel,
  isSameConnectionUrl,
  normalizeConnectionUrl,
  relayCandidateOf,
  secureTokenKeyOf,
} from './urls.ts';

export type LynxConnectionSnapshot = {
  phase: LynxConnectPhase;
  autoConnectLabel: string | null;
  connections: LynxSavedConnection[];
  pendingConnection: LynxPendingConnection | null;
  error: LynxConnectError | null;
  busy: boolean;
  passwordBusy: boolean;
};

export type LynxConnectionController = {
  snapshot: () => LynxConnectionSnapshot;
  subscribe: (listener: () => void) => () => void;
  resolveLaunch: () => Promise<boolean>;
  autoConnectLastInstance: () => Promise<boolean>;
  connect: (input: LynxConnectInput) => Promise<void>;
  redeemPairing: (payload: LynxPairingConnectionPayload) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  saveConnection: (input: LynxConnectInput) => Promise<LynxSavedConnection | null>;
  removeConnection: (id: string) => Promise<LynxSavedConnection | null>;
  scanAndConnect: () => Promise<void>;
  applyDeepLinkUrl: (raw: string | null | undefined) => LynxApplyDeepLinkResult;
  deepLinks: LynxDeepLinkInbox;
  setReady: (ready: boolean) => void;
  setError: (error: LynxConnectError | null) => void;
  reprobeActive: () => Promise<LynxReprobeOutcome>;
  refreshCandidates: () => Promise<void>;
};

const buildCandidatesFromInput = (input: LynxConnectInput): LynxTransportCandidate[] => {
  if (input.candidates && input.candidates.length > 0) return input.candidates;
  const list: LynxTransportCandidate[] = [];
  if (typeof input.url === 'string' && input.url.trim() && !/^relay:\/\//i.test(input.url.trim())) {
    try {
      const url = normalizeConnectionUrl(input.url);
      if (url) list.push({ kind: 'direct', url });
    } catch {
      // invalid
    }
  }
  if (input.relay) list.push({ kind: 'relay', relay: input.relay });
  return list;
};

export const createLynxConnectionController = (host: LynxHostAdapters): LynxConnectionController => {
  const store: LynxConnectionStore = createLynxConnectionStore(host.metadataStore);
  const createId = host.createId ?? createLynxId;
  const deepLinks = createLynxDeepLinkInbox();
  const listeners = new Set<() => void>();

  let connections = store.load();
  let phase: LynxConnectPhase = 'resolving';
  let pendingConnection: LynxPendingConnection | null = null;
  let error: LynxConnectError | null = null;
  let busyOperation: 'connect' | 'password' | 'pairing' | null = null;
  let boundKey: string | null = host.getRuntimeKey?.() ?? null;

  const deviceId = () => readOrCreateDeviceId(host.metadataStore, createId);

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const snapshot = (): LynxConnectionSnapshot => ({
    phase,
    autoConnectLabel: connections[0]?.label?.trim() ? connections[0].label : null,
    connections,
    pendingConnection,
    error,
    busy: busyOperation !== null,
    passwordBusy: busyOperation === 'password',
  });

  const applyConnections = (next: LynxSavedConnection[]) => {
    connections = next;
    emit();
  };

  const persistMetadata = (draft: {
    id?: string;
    label: string;
    candidates: LynxTransportCandidate[];
    hasToken?: boolean;
  }) => {
    const next = store.upsert({
      ...draft,
      now: host.clock?.now(),
      createId,
    });
    applyConnections(next);
    return next;
  };

  const bind = (candidates: LynxTransportCandidate[], token: string | null, transport: { kind: 'direct'; url: string } | { kind: 'relay'; relay: NonNullable<ReturnType<typeof relayCandidateOf>> }) => {
    const runtimeKey = secureTokenKeyOf({ candidates });
    boundKey = runtimeKey;
    host.bindRuntime?.({ runtimeKey, transport, clientToken: token });
    phase = 'connected';
    pendingConnection = null;
    emit();
  };

  const autoConnectLastInstance = async (): Promise<boolean> => {
    await migrateLegacyInlineTokens(host.metadataStore, host.secureStore);
    connections = store.load();
    const candidate = connections[0];
    if (!candidate?.hasToken) return false;
    const token = await readSecureToken(host.secureStore, candidate);
    if (!token) return false;
    const result = await probeConnectionCandidates(candidate.candidates, token, host);
    if (result.status !== 'ok') return false;
    persistMetadata({ id: candidate.id, label: candidate.label, candidates: candidate.candidates, hasToken: true });
    bind(candidate.candidates, token, result.transport);
    return true;
  };

  const resolveLaunch = async (): Promise<boolean> => {
    phase = 'resolving';
    error = null;
    emit();
    const connected = await autoConnectLastInstance();
    if (!connected) {
      phase = pendingConnection ? 'password' : 'welcome';
      emit();
    }
    return connected;
  };

  const connect = async (input: LynxConnectInput): Promise<void> => {
    error = null;
    busyOperation = 'connect';
    emit();
    try {
      const candidates = buildCandidatesFromInput(input);
      if (candidates.length === 0) {
        error = 'url-required';
        return;
      }
      const saved = input.id
        ? connections.find((connection) => connection.id === input.id)
        : connections.find((connection) => candidateSetsMatch(connection.candidates, candidates));
      const label = input.label?.trim() || saved?.label || getConnectionLabel(connectionDisplayUrl({ candidates }));
      let token = input.clientToken?.trim() || undefined;
      const tokenIsNew = Boolean(token);
      if (!token && saved?.hasToken) token = await readSecureToken(host.secureStore, saved);

      safeLogInfo(host.logger, 'connect:start', {
        candidates: candidates.map((candidate) => candidate.kind),
        hasToken: Boolean(token),
      });

      const result = await probeConnectionCandidates(candidates, token, host, { grant: input.relayGrant });
      safeLogInfo(host.logger, 'connect:probe', { status: result.status });

      if (result.status === 'unreachable') {
        error = 'unreachable';
        return;
      }
      if (result.status === 'needs-login') {
        persistMetadata({ id: saved?.id, label, candidates, hasToken: Boolean(token) });
        pendingConnection = {
          id: saved?.id ?? createId(),
          label,
          candidates,
          relay: relayCandidateOf({ candidates }) ?? undefined,
          relayGrant: input.relayGrant,
        };
        phase = 'password';
        return;
      }

      if (token && tokenIsNew) {
        const stored = await writeSecureToken(host.secureStore, { candidates }, token);
        if (!stored) {
          error = 'secure-store-failed';
          return;
        }
      }
      persistMetadata({ id: saved?.id, label, candidates, hasToken: Boolean(token) });
      bind(candidates, token ?? null, result.transport);
    } catch (caught) {
      safeLogWarn(host.logger, 'connect:threw', { error: caught instanceof Error ? caught.message : 'error' });
      error = 'invalid-url';
    } finally {
      if (busyOperation === 'connect') busyOperation = null;
      emit();
    }
  };

  const redeemPairing = async (payload: LynxPairingConnectionPayload): Promise<void> => {
    if (busyOperation === 'pairing') return;
    error = null;
    busyOperation = 'pairing';
    emit();
    const deviceCandidates = pairingCandidatesToMobile(payload.candidates);
    let chosen: Awaited<ReturnType<typeof establishLiveTransport>> = null;
    try {
      chosen = await establishLiveTransport(deviceCandidates, host);
      if (!chosen) {
        error = 'unreachable';
        return;
      }
      const redeemed = await redeemPairingOnTransport(chosen, payload, host, { deviceId: deviceId() });
      if (!redeemed) {
        error = 'auth-required';
        return;
      }
      const label = payload.label || redeemed.serverLabel || getConnectionLabel(connectionDisplayUrl({ candidates: deviceCandidates }));
      const stored = await writeSecureToken(host.secureStore, { candidates: deviceCandidates }, redeemed.token);
      if (!stored) {
        error = 'secure-store-failed';
        return;
      }
      persistMetadata({ label, candidates: deviceCandidates, hasToken: true });
      bind(
        deviceCandidates,
        redeemed.token,
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay } : { kind: 'direct', url: chosen.url },
      );
    } catch (caught) {
      safeLogWarn(host.logger, 'pairing:threw', { error: caught instanceof Error ? caught.message : 'error' });
      error = 'auth-required';
    } finally {
      if (chosen?.kind === 'relay') chosen.tunnel.close?.();
      if (busyOperation === 'pairing') busyOperation = null;
      emit();
    }
  };

  const submitPassword = async (password: string): Promise<void> => {
    if (!pendingConnection || !password.trim() || busyOperation === 'password') return;
    error = null;
    busyOperation = 'password';
    emit();
    const { id, label, candidates } = pendingConnection;
    let chosen: Awaited<ReturnType<typeof establishLiveTransport>> = null;
    try {
      chosen = await establishLiveTransport(candidates, host);
      if (!chosen) {
        error = 'unreachable';
        return;
      }
      safeLogInfo(host.logger, 'password:start', { transport: chosen.kind });
      const issued = await loginWithPasswordOnTransport(chosen, password, host, { deviceId: deviceId() });
      safeLogInfo(host.logger, 'password:done', { issued: Boolean(issued) });
      if (!issued) {
        error = 'password-failed';
        return;
      }
      const stored = await writeSecureToken(host.secureStore, { candidates }, issued.token);
      if (!stored) {
        error = 'secure-store-failed';
        return;
      }
      persistMetadata({ id, label, candidates, hasToken: true });
      bind(
        candidates,
        issued.token,
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay } : { kind: 'direct', url: chosen.url },
      );
    } catch (caught) {
      safeLogWarn(host.logger, 'password:threw', { error: caught instanceof Error ? caught.message : 'error' });
      error = 'password-failed';
    } finally {
      if (chosen?.kind === 'relay') chosen.tunnel.close?.();
      if (busyOperation === 'password') busyOperation = null;
      emit();
    }
  };

  const saveConnection = async (input: LynxConnectInput): Promise<LynxSavedConnection | null> => {
    error = null;
    let candidates = buildCandidatesFromInput(input);
    const existing = input.id ? connections.find((connection) => connection.id === input.id) ?? null : null;
    if (existing) {
      const inputDirects = candidates.filter((candidate): candidate is Extract<LynxTransportCandidate, { kind: 'direct' }> => candidate.kind === 'direct');
      const preservedHttps = directCandidates(existing).filter(
        (candidate) => candidate.url.startsWith('https://') && !inputDirects.some((next) => isSameConnectionUrl(next.url, candidate.url)),
      );
      const relay = relayCandidateOf(existing);
      candidates = [...inputDirects, ...preservedHttps, ...(relay ? [{ kind: 'relay' as const, relay }] : [])];
    }
    if (candidates.length === 0) {
      error = 'url-required';
      emit();
      return null;
    }
    const clientToken = input.clientToken?.trim() || undefined;
    const label = input.label?.trim() || getConnectionLabel(connectionDisplayUrl({ candidates }));
    const nextKey = secureTokenKeyOf({ candidates });
    if (clientToken) {
      const stored = await writeSecureToken(host.secureStore, { candidates }, clientToken);
      if (!stored) {
        error = 'secure-store-failed';
        emit();
        return null;
      }
    } else if (existing?.hasToken) {
      const previousKey = secureTokenKeyOf(existing);
      if (previousKey && nextKey && previousKey !== nextKey) {
        const storedToken = await readSecureToken(host.secureStore, existing);
        if (storedToken) await writeSecureToken(host.secureStore, { candidates }, storedToken);
      }
    }
    const next = persistMetadata({
      id: input.id,
      label,
      candidates,
      hasToken: Boolean(clientToken) || existing?.hasToken,
    });
    return next.find((connection) => candidateSetsMatch(connection.candidates, candidates)) ?? null;
  };

  const removeConnection = async (id: string): Promise<LynxSavedConnection | null> => {
    const { next, removed } = store.remove(id);
    if (removed) await deleteSecureToken(host.secureStore, removed);
    applyConnections(next);
    if (removed && secureTokenKeyOf(removed) === boundKey) {
      boundKey = null;
      phase = 'welcome';
      host.bindRuntime?.({
        runtimeKey: 'mobile-disconnected',
        transport: { kind: 'direct', url: '' },
        clientToken: null,
      });
    }
    return removed;
  };

  const scanAndConnect = async (): Promise<void> => {
    if (!host.scanQr) {
      error = 'scan-unsupported';
      emit();
      return;
    }
    error = null;
    emit();
    const scanned = await host.scanQr();
    if (scanned.status === 'cancelled') return;
    if (scanned.status !== 'ok') {
      error = qrScanStatusToError(scanned.status);
      emit();
      return;
    }
    const parsed = resultFromQrRaw(scanned.raw);
    if (parsed.status === 'invalid') {
      error = 'scan-invalid';
      emit();
      return;
    }
    if (parsed.status === 'pairing') {
      await redeemPairing(parsed.pairing);
      return;
    }
    await connect({ url: parsed.url, clientToken: parsed.clientToken, label: parsed.label });
  };

  deepLinks.setPairingHandler((pairing) => {
    void redeemPairing(pairing);
  });

  const applyDeepLinkUrl = (raw: string | null | undefined): LynxApplyDeepLinkResult =>
    deepLinks.applyUrl(raw);

  const transportMatchesCurrent = (connection: LynxSavedConnection): number => {
    const relayActive = host.isRelayModeActive?.() === true;
    const directUrl = host.getRuntimeDirectUrl?.() ?? '';
    return connection.candidates.findIndex((candidate) => (
      candidate.kind === 'relay'
        ? relayActive
        : !relayActive && Boolean(directUrl) && isSameConnectionUrl(candidate.url, directUrl)
    ));
  };

  const reprobeActive = async (): Promise<LynxReprobeOutcome> => {
    const runtimeKey = host.getRuntimeKey?.() ?? boundKey;
    if (!runtimeKey) return 'no-connection';
    const active = connections.find((connection) => secureTokenKeyOf(connection) === runtimeKey) ?? null;
    if (!active) return 'no-connection';
    const token = active.hasToken ? await readSecureToken(host.secureStore, active) : undefined;
    if (!token) return 'unreachable';
    const currentIndex = transportMatchesCurrent(active);
    const higher = currentIndex >= 0 ? active.candidates.slice(0, currentIndex) : active.candidates;
    const better = await probeConnectionCandidates(higher, token, host, { fast: true });
    if (better.status === 'ok') {
      persistMetadata({ id: active.id, label: active.label, candidates: active.candidates, hasToken: true });
      bind(active.candidates, token, better.transport);
      return 'switched';
    }
    if (better.status === 'needs-login') return 'unreachable';
    if (currentIndex >= 0) {
      const current = active.candidates[currentIndex];
      if (current?.kind === 'direct') {
        const stillValid = await validateDirectSession(current.url, token, host, { fast: true });
        if (stillValid) return 'unchanged';
      } else if (host.runtimeFetch) {
        const session = await host.runtimeFetch('/auth/session', { method: 'GET' }).catch(() => null);
        if (session && session.status !== 401) return 'unchanged';
      }
    }
    const lower = currentIndex >= 0 ? active.candidates.slice(currentIndex + 1) : [];
    const fallback = await probeConnectionCandidates(lower, token, host, { fast: true });
    if (fallback.status === 'ok') {
      persistMetadata({ id: active.id, label: active.label, candidates: active.candidates, hasToken: true });
      bind(active.candidates, token, fallback.transport);
      return 'switched';
    }
    return 'unreachable';
  };

  const refreshCandidates = async (): Promise<void> => {
    const runtimeKey = host.getRuntimeKey?.() ?? boundKey;
    const active = connections.find((connection) => secureTokenKeyOf(connection) === runtimeKey) ?? null;
    if (!active) return;
    const result = await refreshConnectionCandidates(active, host);
    if (result.next) applyConnections(store.load());
  };

  return {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolveLaunch,
    autoConnectLastInstance,
    connect,
    redeemPairing,
    submitPassword,
    cancelPassword: () => {
      pendingConnection = null;
      error = null;
      if (phase === 'password') phase = 'welcome';
      emit();
    },
    saveConnection,
    removeConnection,
    scanAndConnect,
    applyDeepLinkUrl,
    deepLinks,
    setReady: (ready) => deepLinks.setReady(ready),
    setError: (next) => {
      error = next;
      emit();
    },
    reprobeActive,
    refreshCandidates,
  };
};
