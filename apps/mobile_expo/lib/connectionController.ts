import {
  candidateSetsMatch,
  connectionDisplayUrl,
  directCandidatesFromUrl,
  getConnectionLabel,
  pairingCandidatesToMobile,
  relayCandidateOf,
  secureTokenKeyOf,
  type ConnectionStatusKind,
  type MobileTransportCandidate,
} from '@/lib/connectionCandidates';
import {
  establishLiveTransport,
  fetchSessionOnTransport,
  isAuthDisabledSession,
  postAuthSession,
  probeSavedCandidates,
  redeemPairing,
  type ChosenTransport,
  type RedeemPairingResult,
} from '@/lib/connectionApi';
import {
  deleteMobileConnection,
  loadMobileConnections,
  readConnectionToken,
  upsertMobileConnection,
  type MobileSavedConnection,
} from '@/lib/connectionStore';
import { parseConnectionPayload, type PairingConnectionPayload } from '@/lib/connectionPayload';
import { writeSecureToken } from '@/lib/secureStore';
import { t } from '@/lib/i18n';


/** Cap primary copy is authRequired; append (HTTP N) / reason only on fail paths for logcat+screen. */
export const formatRedeemAuthRequiredError = (redeemed: Extract<RedeemPairingResult, { ok: false }>): string => {
  const base = t('mobile.connect.error.authRequired');
  if (redeemed.reason === 'http' && typeof redeemed.status === 'number') {
    return `${base} (HTTP ${redeemed.status})`;
  }
  if (redeemed.reason === 'unreachable') return `${base} (unreachable)`;
  if (redeemed.reason === 'no-token') return `${base} (no-token)`;
  return base;
};

export type ConnectionPhase = 'booting' | 'connecting' | 'onboarding' | 'password' | 'connected';

export type PendingPassword = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
};

export type ActiveRuntime = {
  connectionId: string;
  label: string;
  candidates: MobileTransportCandidate[];
  transport: ChosenTransport;
  clientToken: string | null;
};

export type ConnectionControllerState = {
  phase: ConnectionPhase;
  connections: MobileSavedConnection[];
  busy: boolean;
  error: string | null;
  pendingPassword: PendingPassword | null;
  active: ActiveRuntime | null;
  splashLabel: string | null;
};

type Listener = () => void;

export type ConnectionControllerOptions = {
  /** Injected wait for probe race tests. */
  relayRaceWait?: (ms: number) => Promise<void>;
  headstartMs?: number;
  skipAutoConnect?: boolean;
};

export class ConnectionController {
  private state: ConnectionControllerState = {
    phase: 'booting',
    connections: [],
    busy: false,
    error: null,
    pendingPassword: null,
    active: null,
    splashLabel: null,
  };
  private listeners = new Set<Listener>();
  private readonly options: ConnectionControllerOptions;

  constructor(options: ConnectionControllerOptions = {}) {
    this.options = options;
  }

  getState = (): ConnectionControllerState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState = (patch: Partial<ConnectionControllerState>): void => {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  };

  get activeTransportKind(): ConnectionStatusKind | null {
    const transport = this.state.active?.transport;
    if (!transport) return null;
    return transport.kind === 'relay' ? 'relay' : 'direct';
  }

  bootstrap = async (): Promise<void> => {
    const connections = await loadMobileConnections();
    this.setState({ connections });
    if (this.options.skipAutoConnect || connections.length === 0) {
      this.setState({ phase: 'onboarding', splashLabel: null });
      return;
    }
    const target = connections[0]!;
    this.setState({
      phase: 'connecting',
      splashLabel: target.label,
      busy: true,
      error: null,
    });
    const ok = await this.autoConnect(target);
    if (!ok && this.state.phase !== 'password') {
      this.setState({ phase: 'onboarding', busy: false, splashLabel: null });
    }
  };

  private adoptTransport = async (input: {
    id?: string;
    label: string;
    candidates: MobileTransportCandidate[];
    token: string | null;
    transport: ChosenTransport;
  }): Promise<void> => {
    const list = await upsertMobileConnection({
      id: input.id,
      label: input.label,
      candidates: input.candidates,
      clientToken: input.token ?? undefined,
    });
    const saved =
      list.find((c) => (input.id && c.id === input.id) || candidateSetsMatch(c.candidates, input.candidates)) ??
      list[0]!;
    // Close unused tunnel discard handle when adopting.
    if (input.transport.kind === 'relay') {
      // Keep tunnel alive on active runtime; clear discard.
      delete (input.transport as { discard?: () => void }).discard;
    }
    this.setState({
      connections: list,
      active: {
        connectionId: saved.id,
        label: saved.label,
        candidates: saved.candidates,
        transport: input.transport,
        clientToken: input.token,
      },
      phase: 'connected',
      busy: false,
      error: null,
      pendingPassword: null,
      splashLabel: null,
    });
  };

  private autoConnect = async (target: MobileSavedConnection): Promise<boolean> => {
    const token = await readConnectionToken(target);
    // Always probe — auth-disabled hosts connect without a token (Cap parity).
    const result = await probeSavedCandidates(target.candidates, token, {
      headstartMs: this.options.headstartMs,
      wait: this.options.relayRaceWait,
    });
    if (result.status === 'ok' && result.value) {
      await this.adoptTransport({
        id: target.id,
        label: target.label,
        candidates: target.candidates,
        token: token ?? null,
        transport: result.value,
      });
      return true;
    }
    if (result.status === 'needs-login') {
      this.setState({
        phase: 'password',
        pendingPassword: { id: target.id, label: target.label, candidates: target.candidates },
        busy: false,
      });
      return false;
    }
    return false;
  };

  connectWithUrl = async (input: {
    url: string;
    clientToken?: string;
    label?: string;
  }): Promise<boolean> => {
    this.setState({ busy: true, error: null });
    try {
      const candidates = directCandidatesFromUrl(input.url);
      if (candidates.length === 0) {
        this.setState({ error: t('mobile.connect.error.urlRequired'), busy: false });
        return false;
      }
      const label = input.label?.trim() || getConnectionLabel(connectionDisplayUrl(candidates));
      const token = input.clientToken?.trim() || undefined;
      const result = await probeSavedCandidates(candidates, token, {
        headstartMs: this.options.headstartMs,
        wait: this.options.relayRaceWait,
      });
      if (result.status === 'unreachable') {
        this.setState({ error: t('mobile.connect.error.unreachable'), busy: false });
        return false;
      }
      if (result.status === 'needs-login') {
        const list = await upsertMobileConnection({ label, candidates });
        const saved = list.find((c) => candidateSetsMatch(c.candidates, candidates)) ?? list[0]!;
        this.setState({
          connections: list,
          phase: 'password',
          pendingPassword: { id: saved.id, label, candidates },
          busy: false,
        });
        return false;
      }
      if (result.status === 'ok' && result.value) {
        if (!token) {
          // Auth disabled or cookie path — still require token on native except auth-disabled.
          // probe already gated needs-login when no token; so token may be optional when auth disabled.
        }
        await this.adoptTransport({
          label,
          candidates,
          token: token ?? null,
          transport: result.value,
        });
        return true;
      }
      this.setState({ error: t('mobile.connect.error.unreachable'), busy: false });
      return false;
    } catch {
      this.setState({ error: t('mobile.connect.error.invalidUrl'), busy: false });
      return false;
    }
  };

  connectSaved = async (id: string): Promise<boolean> => {
    const target = this.state.connections.find((c) => c.id === id);
    if (!target) return false;
    this.setState({ busy: true, error: null, splashLabel: target.label, phase: 'connecting' });
    const ok = await this.autoConnect(target);
    if (!ok && this.state.phase !== 'password') {
      this.setState({ phase: 'onboarding', busy: false, splashLabel: null, error: t('mobile.connect.error.unreachable') });
    }
    return ok;
  };

  redeemPairingPayload = async (payload: PairingConnectionPayload): Promise<boolean> => {
    this.setState({ busy: true, error: null });
    let chosen: Awaited<ReturnType<typeof establishLiveTransport>> = null;
    let adopted = false;
    try {
      // Cap redeemPairingConnection ordering + errors only.
      const candidates = pairingCandidatesToMobile(payload.candidates);
      if (candidates.length === 0) {
        this.setState({ error: t('mobile.connect.link.invalid'), busy: false });
        return false;
      }
      chosen = await establishLiveTransport(candidates);
      if (!chosen) {
        this.setState({ error: t('mobile.connect.error.unreachable'), busy: false });
        return false;
      }
      const redeemed = await redeemPairing(chosen, {
        pairingId: payload.pairingId,
        secret: payload.secret,
      });
      // Cap: HTTP fail / empty clientToken / SecureStore write fail / catch → authRequired ONLY.
      // Do NOT invent pairingFailed or auth-disabled tokenless adopt after failed redeem.
      if (!redeemed.ok || !redeemed.clientToken) {
        const detail = !redeemed.ok
          ? formatRedeemAuthRequiredError(redeemed)
          : t('mobile.connect.error.authRequired');
        console.info('[mobile-connect]', 'redeem:fail', JSON.stringify({
          reason: !redeemed.ok ? redeemed.reason : 'no-token',
          status: !redeemed.ok ? redeemed.status ?? null : null,
        }));
        this.setState({ error: detail, busy: false });
        return false;
      }
      const label =
        payload.label ||
        redeemed.serverLabel ||
        getConnectionLabel(connectionDisplayUrl(candidates));
      const runtimeKey = secureTokenKeyOf(candidates);
      const stored = await writeSecureToken(runtimeKey, redeemed.clientToken);
      if (!stored) {
        this.setState({ error: t('mobile.connect.error.authRequired'), busy: false });
        return false;
      }
      const transport =
        chosen.kind === 'relay'
          ? { kind: 'relay' as const, relay: chosen.relay, tunnel: chosen.tunnel }
          : { kind: 'direct' as const, url: chosen.url };
      await this.adoptTransport({
        label,
        candidates,
        token: redeemed.clientToken,
        transport,
      });
      adopted = true;
      return true;
    } catch (error) {
      console.warn('[mobile-connect] pairing threw', error);
      this.setState({ error: t('mobile.connect.error.authRequired'), busy: false });
      return false;
    } finally {
      if (!adopted && chosen?.kind === 'relay') chosen.tunnel.close();
      if (!adopted) this.setState({ busy: false });
    }
  };

  redeemPairingLink = async (raw: string): Promise<boolean> => {
    const parsed = parseConnectionPayload(raw);
    if (!parsed) {
      this.setState({ error: t('mobile.connect.link.invalid') });
      return false;
    }
    if ('pairing' in parsed) return this.redeemPairingPayload(parsed.pairing);
    return this.connectWithUrl({ url: parsed.url, clientToken: parsed.clientToken, label: parsed.label });
  };

  submitPassword = async (password: string): Promise<boolean> => {
    const pending = this.state.pendingPassword;
    if (!pending || !password.trim()) return false;
    this.setState({ busy: true, error: null });
    let chosen: Awaited<ReturnType<typeof establishLiveTransport>> = null;
    let adopted = false;
    try {
      chosen = await establishLiveTransport(pending.candidates);
      if (!chosen) {
        this.setState({ error: t('mobile.connect.error.unreachable'), busy: false });
        return false;
      }
      const result = await postAuthSession(chosen, password.trim());
      const transport =
        chosen.kind === 'relay'
          ? { kind: 'relay' as const, relay: chosen.relay, tunnel: chosen.tunnel }
          : { kind: 'direct' as const, url: chosen.url };
      if (!result.ok) {
        // Password endpoint may reject when auth is disabled — still allow connect.
        const session = await fetchSessionOnTransport(chosen);
        if (isAuthDisabledSession(session)) {
          await this.adoptTransport({
            id: pending.id,
            label: pending.label,
            candidates: pending.candidates,
            token: null,
            transport,
          });
          adopted = true;
          return true;
        }
        this.setState({ error: t('mobile.connect.error.passwordFailed'), busy: false });
        return false;
      }
      if (!result.clientToken) {
        const session = await fetchSessionOnTransport(chosen);
        if (isAuthDisabledSession(session)) {
          await this.adoptTransport({
            id: pending.id,
            label: pending.label,
            candidates: pending.candidates,
            token: null,
            transport,
          });
          adopted = true;
          return true;
        }
        this.setState({ error: t('mobile.connect.error.authRequired'), busy: false });
        return false;
      }
      await this.adoptTransport({
        id: pending.id,
        label: pending.label,
        candidates: pending.candidates,
        token: result.clientToken,
        transport,
      });
      adopted = true;
      return true;
    } catch {
      this.setState({ error: t('mobile.connect.error.passwordFailed'), busy: false });
      return false;
    } finally {
      if (!adopted && chosen?.kind === 'relay') chosen.tunnel.close();
      if (!adopted) this.setState({ busy: false });
    }
  };

  cancelPassword = (): void => {
    this.setState({ pendingPassword: null, phase: 'onboarding', error: null });
  };

  removeConnection = async (id: string): Promise<void> => {
    const wasActive = this.state.active?.connectionId === id;
    const next = await deleteMobileConnection(id);
    if (wasActive) {
      const active = this.state.active;
      if (active?.transport.kind === 'relay') active.transport.tunnel?.close();
      this.setState({
        connections: next,
        active: null,
        phase: 'onboarding',
        pendingPassword: null,
        error: null,
      });
      return;
    }
    this.setState({ connections: next });
  };

  disconnectToOnboarding = (): void => {
    const active = this.state.active;
    if (active?.transport.kind === 'relay') active.transport.tunnel?.close();
    this.setState({ active: null, phase: 'onboarding', pendingPassword: null, error: null });
  };
}

export const connectionRuntimeKey = (candidates: MobileTransportCandidate[]): string =>
  secureTokenKeyOf(candidates);

export { relayCandidateOf };
