import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { runtimeFetch } from '@/lib/runtime-fetch';

type DesktopInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const isReservedRequestHeaderName = (name: string): boolean => name.trim().toLowerCase() === 'authorization';

const sanitizeRequestHeaders = (headers: unknown): Record<string, string> | undefined => {
  if (!isRecord(headers)) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    const headerValue = typeof value === 'string' ? value.trim() : '';
    if (!name || !headerValue || /[\r\n:]/.test(name) || /[\r\n]/.test(headerValue)) continue;
    if (isReservedRequestHeaderName(name)) continue;
    next[name] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

/**
 * Private-relay reachability for a host. A host may carry this ALONGSIDE a
 * direct `apiUrl` (multi-transport: direct on the home network, E2EE tunnel
 * away — mirrors the mobile connection model) or as its only transport.
 * `hostEncPubJwk` is the trust anchor that pins the tunnel to the real server.
 * The relay admission `grant` is a one-time pairing artifact and is
 * intentionally NOT persisted — steady-state relay connections route by
 * `serverId` alone.
 */
export type DesktopHostRelay = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

/** Hosts created by redeeming an Import connection / pairing link. */
export const DESKTOP_HOST_SOURCE_CONNECT_LINK = 'connect-link' as const;

export type DesktopHostSource = typeof DESKTOP_HOST_SOURCE_CONNECT_LINK;

/**
 * Imported SSH remote reached through another desktop's relay tunnel.
 * `clientToken` on the host is the SSH instance token (runtime APIs).
 * `desktopClientToken` authorizes desktop-side routes like ssh-host-token.
 */
export type DesktopHostSshTarget = {
  hostId: string;
  desktopClientToken: string;
};

export type DesktopHost = {
  id: string;
  label: string;
  /** Legacy/UI URL. During migration this may equal apiUrl. For relay hosts this is a display-only `relay://<serverId>` pseudo-URL. Empty for SSH hosts listed via relay (no direct URL on the phone). */
  url: string;
  /** API endpoint used by packaged Electron UI for this instance. Absent for relay-only hosts. */
  apiUrl?: string;
  /** Remote client bearer token for packaged-client API access. */
  clientToken?: string;
  /** Extra headers for desktop runtime API requests. */
  requestHeaders?: Record<string, string>;
  /** When set, this host is reached over the private relay tunnel. */
  relay?: DesktopHostRelay;
  /**
   * SSH remote instance exposed by the paired desktop over the active relay.
   * Mobile/browser clients keep the relay transport and route with
   * `x-openchamber-target-port` = localPort.
   */
  viaSshRelay?: { localPort: number };
  /**
   * PC-B / imported SSH pairing: route via the paired desktop's relay with
   * target-port. Runtime APIs use `clientToken` (SSH); desktop mint uses
   * `sshTarget.desktopClientToken`.
   */
  sshTarget?: DesktopHostSshTarget;
  /** Provenance for display filtering. Absent on legacy manually-added hosts. */
  source?: DesktopHostSource;
};

/**
 * Whether a persisted desktop host should appear in the host switcher.
 * Hidden hosts stay on disk; this is display-only.
 *
 * A host is visible when any of these authoritative facts hold:
 * 1. it was imported via a connect/pairing link (`source === 'connect-link'`)
 * 2. its id matches a desktop SSH instance (SSH connect writes back the same id)
 * 3. it carries a relay descriptor (pairing-produced)
 *
 * Settings remote instances already render SSH rows from `desktopSshInstances`.
 * Use `isSettingsLinkDesktopHost` there so the SSH mirror host is not also
 * shown as a connect-link row.
 */
export const isVisibleDesktopHost = (
  host: DesktopHost,
  sshInstanceIds: ReadonlySet<string>,
): boolean => {
  if (host.source === DESKTOP_HOST_SOURCE_CONNECT_LINK) return true;
  if (host.relay) return true;
  if (host.viaSshRelay) return true;
  if (host.sshTarget) return true;
  return sshInstanceIds.has(host.id);
};

/**
 * Whether a persisted desktop host should appear as a Settings "链接" row.
 * Local SSH instance mirrors share an id with `desktopSshInstances` and stay
 * available to the host switcher; Settings already owns those as SSH rows.
 */
export const isSettingsLinkDesktopHost = (
  host: DesktopHost,
  sshInstanceIds: ReadonlySet<string>,
): boolean => {
  if (sshInstanceIds.has(host.id)) return false;
  return isVisibleDesktopHost(host, sshInstanceIds);
};

/** Display-only pseudo-URL for a relay host (never fetched). */
export const relayHostDisplayUrl = (serverId: string): string => `relay://${serverId}`;

const parseHostRelay = (value: unknown): DesktopHostRelay | null => {
  if (!isRecord(value)) return null;
  const relayUrl = readString(value, 'relayUrl') || readString(value, 'relay_url');
  const serverId = readString(value, 'serverId') || readString(value, 'server_id');
  const jwk = value.hostEncPubJwk ?? value.host_enc_pub_jwk;
  if (!relayUrl || !serverId || !isRecord(jwk)) return null;
  return { relayUrl, serverId, hostEncPubJwk: jwk as JsonWebKey };
};

export type DesktopHostsConfig = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted: boolean;
  localOrigin?: string | null;
};

/** Backward-compatible input type — callers may omit `initialHostChoiceCompleted`. */
export type DesktopHostsConfigInput = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted?: boolean;
  localClientToken?: string | null;
};

export type HostProbeResult = {
  status: 'ok' | 'auth' | 'update-recommended' | 'incompatible' | 'wrong-service' | 'unreachable';
  latencyMs: number;
};

export type DesktopHostUrlResolution = {
  persistedUrl: string;
  redeemUrl: string | null;
  kind: 'normal-host' | 'tunnel-connect-link';
};

const SENSITIVE_QUERY_KEY = /^(t|.*(?:token|auth|secret|api).*)$/i;

export const normalizeHostUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return trimmed.split('#')[0] || null;
  } catch {
    return null;
  }
};

export const resolveDesktopHostUrl = (raw: string): DesktopHostUrlResolution | null => {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/connect' && url.searchParams.has('t')) {
      return {
        persistedUrl: url.origin,
        redeemUrl: url.toString(),
        kind: 'tunnel-connect-link',
      };
    }
  } catch {
    return null;
  }

  return {
    persistedUrl: normalized,
    redeemUrl: null,
    kind: 'normal-host',
  };
};

export const redactSensitiveUrl = (raw: string): string => {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) {
    return raw;
  }

  try {
    const url = new URL(normalized);
    // Redact embedded credentials (userinfo) to prevent leaking user:pass
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }

    const keys = Array.from(new Set(Array.from(url.searchParams.keys())));
    for (const key of keys) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

export const locationMatchesHost = (locationHref: string, hostUrl: string): boolean => {
  const normalizedCurrent = normalizeHostUrl(locationHref);
  const normalizedHost = normalizeHostUrl(hostUrl);
  if (!normalizedCurrent || !normalizedHost) {
    return false;
  }

  try {
    const current = new URL(normalizedCurrent);
    const host = new URL(normalizedHost);
    if (current.origin !== host.origin) {
      return false;
    }

    if (host.search && current.search !== host.search) {
      return false;
    }

    const hostPath = host.pathname.length > 1 ? host.pathname.replace(/\/+$/, '') : host.pathname;
    const currentPath = current.pathname.length > 1 ? current.pathname.replace(/\/+$/, '') : current.pathname;
    if (hostPath === '/') {
      return true;
    }
    return currentPath === hostPath || currentPath.startsWith(`${hostPath}/`);
  } catch {
    return false;
  }
};

const readString = (obj: Record<string, unknown>, key: string): string | null => {
  const val = obj[key];
  return typeof val === 'string' ? val : null;
};

const readNumber = (obj: Record<string, unknown>, key: string): number | null => {
  const val = obj[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
};

const parseViaSshRelay = (value: unknown): DesktopHost['viaSshRelay'] | null => {
  if (!isRecord(value)) return null;
  const localPort = readNumber(value, 'localPort') ?? readNumber(value, 'local_port');
  if (localPort === null || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    return null;
  }
  return { localPort };
};

const parseSshTarget = (value: unknown): DesktopHostSshTarget | null => {
  if (!isRecord(value)) return null;
  const hostId = readString(value, 'hostId') || readString(value, 'host_id');
  const desktopClientToken = readString(value, 'desktopClientToken')
    || readString(value, 'desktop_client_token');
  if (!hostId?.trim() || !desktopClientToken?.trim()) return null;
  return { hostId: hostId.trim(), desktopClientToken: desktopClientToken.trim() };
};

const parseHost = (value: unknown): DesktopHost | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const label = readString(value, 'label');
  const url = readString(value, 'url');
  const apiUrl = readString(value, 'apiUrl') || readString(value, 'api_url');
  const clientToken = readString(value, 'clientToken') || readString(value, 'client_token');
  const requestHeaders = sanitizeRequestHeaders(value.requestHeaders);
  const relay = parseHostRelay(value.relay);
  const viaSshRelay = parseViaSshRelay(value.viaSshRelay ?? value.via_ssh_relay);
  const sshTarget = parseSshTarget(value.sshTarget ?? value.ssh_target);
  const source = readString(value, 'source') === DESKTOP_HOST_SOURCE_CONNECT_LINK
    ? DESKTOP_HOST_SOURCE_CONNECT_LINK
    : undefined;
  // SSH-via-relay / imported SSH hosts may omit a direct URL.
  if (!id || !label || (!url && !viaSshRelay && !(sshTarget && relay))) return null;
  return {
    id,
    label,
    url: url || '',
    ...(apiUrl ? { apiUrl } : {}),
    ...(clientToken ? { clientToken } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(relay ? { relay } : {}),
    ...(viaSshRelay ? { viaSshRelay } : {}),
    ...(sshTarget ? { sshTarget } : {}),
    ...(source ? { source } : {}),
  };
};

const parseDesktopHostsApiResponse = (raw: unknown): DesktopHost[] => {
  if (!isRecord(raw)) return [];
  const hostsRaw = raw.hosts;
  if (!Array.isArray(hostsRaw)) return [];
  const hosts: DesktopHost[] = [];
  for (const entry of hostsRaw) {
    if (!isRecord(entry)) continue;
    const id = readString(entry, 'id');
    const label = readString(entry, 'label');
    const localPort = readNumber(entry, 'localPort') ?? readNumber(entry, 'local_port');
    if (!id || !label || localPort === null || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      continue;
    }
    hosts.push({
      id,
      label,
      url: '',
      apiUrl: '',
      viaSshRelay: { localPort },
    });
  }
  return hosts;
};

export const getDesktopHostApiUrl = (host: DesktopHost): string => {
  return normalizeHostUrl(host.apiUrl || host.url) || host.apiUrl || host.url;
};

const getInvoke = (): DesktopInvoke | null => {
  if (!hasDesktopInvoke()) return null;
  return (command, args) => invokeDesktop(command, args) as Promise<unknown>;
};

export const desktopHostsGet = async (): Promise<DesktopHostsConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    // Phone / browser: list SSH hosts exposed by the paired desktop over the
    // active runtime (typically a relay tunnel). Failure must not look like
    // an authoritative empty catalog.
    const response = await runtimeFetch('/api/openchamber/desktop-hosts');
    if (!response.ok) {
      throw new Error(`desktop-hosts failed: ${response.status}`);
    }
    const raw: unknown = await response.json().catch(() => null);
    return {
      hosts: parseDesktopHostsApiResponse(raw),
      defaultHostId: null,
      initialHostChoiceCompleted: false,
    };
  }

  const raw = await invoke('desktop_hosts_get');
  if (!isRecord(raw)) {
    return { hosts: [], defaultHostId: null, initialHostChoiceCompleted: false };
  }

  const hostsRaw = raw.hosts;
  const hosts = Array.isArray(hostsRaw)
    ? hostsRaw.map(parseHost).filter((h): h is DesktopHost => Boolean(h))
    : [];

  const defaultHostId =
    readString(raw, 'defaultHostId') ||
    readString(raw, 'default_host_id') ||
    readString(raw, 'defaultHostID');

  const initialHostChoiceCompleted =
    raw.initialHostChoiceCompleted === true || raw.initial_host_choice_completed === true;
  const localOrigin = readString(raw, 'localOrigin') || readString(raw, 'local_origin');

  return { hosts, defaultHostId, initialHostChoiceCompleted, localOrigin };
};

export type SshHostTokenResult = {
  token: string;
  localPort: number | null;
  reachable: boolean;
};

export type SshHostTokenFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Mint / refresh an SSH host token (+ live localPort) on the paired desktop.
 * `pairingId` binds the mint to a redeemed pairing session (mobile QR path).
 * Omit pairingId for legacy reconnect probes.
 */
export const requestSshHostToken = async (
  hostId: string,
  options?: {
    pairingId?: string;
    /** Override transport (e.g. a live redeem tunnel before runtime switch). */
    fetch?: SshHostTokenFetch;
    headers?: Record<string, string>;
  },
): Promise<SshHostTokenResult> => {
  const id = hostId.trim();
  if (!id) {
    throw new Error('ssh-host-token requires hostId');
  }
  const doFetch = options?.fetch ?? ((path: string, init?: RequestInit) => runtimeFetch(path, init));
  const response = await doFetch('/api/openchamber/ssh-host-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options?.headers || {}),
    },
    body: JSON.stringify({
      hostId: id,
      ...(options?.pairingId?.trim() ? { pairingId: options.pairingId.trim() } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`ssh-host-token failed: ${response.status}`);
  }
  const raw: unknown = await response.json().catch(() => null);
  if (!isRecord(raw)) {
    throw new Error('ssh-host-token missing token');
  }
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!token) {
    throw new Error('ssh-host-token missing token');
  }
  const localPortRaw = raw.localPort ?? raw.local_port;
  const localPort = typeof localPortRaw === 'number' && Number.isFinite(localPortRaw)
    ? Math.round(localPortRaw)
    : null;
  const reachable = raw.reachable === true
    && localPort !== null
    && Number.isInteger(localPort)
    && localPort >= 1
    && localPort <= 65535;
  return {
    token,
    localPort: reachable ? localPort : (localPort !== null && Number.isInteger(localPort) ? localPort : null),
    reachable,
  };
};

/** @deprecated Prefer requestSshHostToken — kept for callers that only need the token string. */
export const fetchSshHostToken = async (hostId: string): Promise<string> => {
  const result = await requestSshHostToken(hostId);
  return result.token;
};

export const desktopHostsSet = async (config: DesktopHostsConfigInput): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  const input: Record<string, unknown> = {
    hosts: config.hosts,
    defaultHostId: config.defaultHostId,
    initialHostChoiceCompleted: config.initialHostChoiceCompleted,
  };
  if (config.localClientToken !== undefined) {
    input.localClientToken = config.localClientToken;
  }
  await invoke('desktop_hosts_set', {
    input,
  });
};

export const desktopLocalClientTokenGet = async (): Promise<string> => {
  const invoke = getInvoke();
  if (!invoke) return '';
  const raw = await invoke('desktop_local_client_token_get').catch(() => null);
  return typeof raw === 'string' ? raw.trim() : '';
};

/**
 * Stable per-install identifier for this desktop. Used as the client dedupe key
 * so re-pairing or re-authenticating this desktop reuses its single device
 * record on a server instead of piling up duplicates. Empty string when not in
 * the desktop shell.
 */
export const desktopInstallIdGet = async (): Promise<string> => {
  const invoke = getInvoke();
  if (!invoke) return '';
  const raw = await invoke('desktop_install_id_get').catch(() => null);
  return typeof raw === 'string' ? raw.trim() : '';
};

const RELAY_PROBE_TIMEOUT_MS = 8_000;

export type ProbeRelayDesktopHostResult = HostProbeResult & {
  tunnel?: ReturnType<typeof createRelayTunnelClient>;
  /** Live SSH localPort when probing an imported sshTarget host. */
  localPort?: number;
  /** Fresh SSH client token when the mint returned one. */
  sshToken?: string;
};

/**
 * Reachability check for a relay host: open a throwaway E2EE tunnel and hit
 * /health. Relay hosts have no HTTP address for `desktopHostProbe`. Hard
 * timeout: a ghost relay registration (relay lost the host, host doesn't know)
 * leaves the tunnel in `connecting` forever — the probe must report
 * unreachable instead of hanging every status/switch flow with it.
 *
 * With `sshTarget`, mint live localPort via ssh-host-token (desktop bearer) and
 * probe /health with x-openchamber-target-port so status reflects the SSH host.
 */
export const probeRelayDesktopHost = async (
  relay: DesktopHostRelay,
  // With `keepTunnel`, an 'ok' probe RETURNS its live tunnel (the caller owns
  // it — typically adopting it as the runtime tunnel, skipping a second
  // WebSocket connect + E2EE handshake); every other outcome closes it.
  options?: {
    keepTunnel?: boolean;
    sshTarget?: DesktopHostSshTarget | null;
  },
): Promise<ProbeRelayDesktopHostResult> => {
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
  });
  const startedAt = Date.now();
  let keep = false;
  try {
    let targetPortHeader: Record<string, string> | undefined;
    let localPort: number | undefined;
    let sshToken: string | undefined;
    const sshTarget = options?.sshTarget;
    if (sshTarget?.hostId && sshTarget.desktopClientToken) {
      const minted = await requestSshHostToken(sshTarget.hostId, {
        fetch: (path, init) => tunnel.fetch(path, init),
        headers: { Authorization: `Bearer ${sshTarget.desktopClientToken}` },
      }).catch(() => null);
      if (!minted?.reachable || typeof minted.localPort !== 'number') {
        return { status: 'unreachable', latencyMs: 0 };
      }
      localPort = minted.localPort;
      sshToken = minted.token;
      targetPortHeader = { 'x-openchamber-target-port': String(minted.localPort) };
    }

    const response = await Promise.race([
      tunnel.fetch('/health', targetPortHeader ? { headers: targetPortHeader } : undefined),
      new Promise<null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), RELAY_PROBE_TIMEOUT_MS);
        if (typeof timer !== 'number' && typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
      }),
    ]);
    if (!response?.ok) return { status: 'unreachable', latencyMs: 0 };
    keep = options?.keepTunnel === true;
    return {
      status: 'ok',
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(keep ? { tunnel } : {}),
      ...(localPort !== undefined ? { localPort } : {}),
      ...(sshToken ? { sshToken } : {}),
    };
  } catch {
    return { status: 'unreachable', latencyMs: 0 };
  } finally {
    if (!keep) tunnel.close();
  }
};

export const desktopHostProbe = async (url: string, options?: { clientToken?: string | null; requestHeaders?: Record<string, string> | null; expectedServerId?: string | null }): Promise<HostProbeResult> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  // `expectedServerId` makes the main-process probe verify the address's
  // UNAUTHENTICATED /health identity before sending the bearer token — required
  // when probing an address learned at runtime rather than typed by the user.
  const raw = await invoke('desktop_host_probe', { url, clientToken: options?.clientToken || undefined, requestHeaders: options?.requestHeaders || undefined, expectedServerId: options?.expectedServerId || undefined });
  if (!isRecord(raw)) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  const rawStatus = raw.status;
  const status: HostProbeResult['status'] =
    rawStatus === 'ok' || rawStatus === 'auth' || rawStatus === 'update-recommended' || rawStatus === 'incompatible' || rawStatus === 'wrong-service' || rawStatus === 'unreachable'
      ? rawStatus
      : 'unreachable';

  const latencyMs = readNumber(raw, 'latencyMs') ?? readNumber(raw, 'latency_ms') ?? 0;
  return { status, latencyMs };
};

export const desktopOpenNewWindowAtUrl = async (url: string, options?: { clientToken?: string | null; requestHeaders?: Record<string, string> | null }): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_new_window_at_url', { url, clientToken: options?.clientToken || undefined, requestHeaders: options?.requestHeaders || undefined });
};

/**
 * Open a saved host in a new window by id. Required for relay-capable hosts —
 * the new window boots the local UI and picks the transport itself (direct
 * first, E2EE tunnel fallback), which a fixed URL cannot express.
 */
export const desktopOpenNewWindowForHost = async (hostId: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_new_window_for_host', { hostId });
};
