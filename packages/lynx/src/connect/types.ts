/**
 * Lynx connect types. Transport and pairing shapes match Capacitor
 * `mobileConnections.ts` / `connectionPayload.ts` so a Lynx host can persist
 * the same LAN+relay candidate set and redeem the same v2 payload.
 */

export type LynxConnectionMode = 'direct' | 'relay';

export type LynxRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type LynxTransportCandidate =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: LynxRelayConfig };

export type LynxSavedConnection = {
  id: string;
  label: string;
  candidates: LynxTransportCandidate[];
  lastUsedAt: number;
  hasToken: boolean;
};

export type LynxPendingConnection = {
  id: string;
  label: string;
  candidates: LynxTransportCandidate[];
  relay?: LynxRelayConfig;
  relayGrant?: string;
};

export type LynxConnectInput = {
  id?: string;
  url?: string;
  candidates?: LynxTransportCandidate[];
  clientToken?: string;
  label?: string;
  relay?: LynxRelayConfig;
  relayGrant?: string;
};

export type LynxChosenTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: LynxRelayConfig };

export type LynxRuntimeBind = {
  runtimeKey: string;
  transport: LynxChosenTransport;
  clientToken: string | null;
};

export type LynxConnectError =
  | 'url-required'
  | 'invalid-url'
  | 'unreachable'
  | 'auth-required'
  | 'password-failed'
  | 'pairing-invalid'
  | 'pairing-expired'
  | 'scan-permission-denied'
  | 'scan-invalid'
  | 'scan-unsupported'
  | 'scan-failed'
  | 'secure-store-failed';

export type LynxConnectPhase = 'resolving' | 'welcome' | 'password' | 'connected';

export type LynxHttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type LynxHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type LynxHttpTransport = {
  fetch: (path: string, init?: LynxHttpInit) => Promise<LynxHttpResponse>;
  close?: () => void;
};

export type LynxQrScanRaw =
  | { status: 'ok'; raw: string }
  | { status: 'cancelled' }
  | { status: 'permission-denied' }
  | { status: 'unsupported' }
  | { status: 'failed' };

export type LynxDevicePlatform = 'ios' | 'android';

export type LynxSessionStatus = {
  authenticated?: boolean;
  disabled?: boolean;
  scope?: string;
  serverId?: string;
};

export type LynxPairingDirectCandidate = {
  type: 'lan' | 'tunnel';
  url: string;
  priority?: number;
};

export type LynxPairingRelayCandidate = {
  type: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
  priority?: number;
};

export type LynxPairingEndpointCandidate = LynxPairingDirectCandidate | LynxPairingRelayCandidate;

export type LynxPairingConnectionPayload = {
  v: 2;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt?: string;
  candidates: LynxPairingEndpointCandidate[];
};

export type LynxSessionsFilter = 'all' | 'attention' | 'recent';
export type LynxViewTarget = 'files' | 'mcp' | 'instances' | 'update';

export type LynxDeepLinkIntent =
  | { type: 'connect'; pairing: LynxPairingConnectionPayload }
  | { type: 'session'; sessionId: string; directory?: string }
  | { type: 'new-session'; directory?: string; projectId?: string; agent?: string; model?: string; prompt?: string }
  | { type: 'open-project'; directory: string }
  | { type: 'sessions'; filter?: LynxSessionsFilter }
  | { type: 'status' }
  | { type: 'settings'; section?: string }
  | { type: 'changes'; path?: string; staged?: boolean }
  | { type: 'view'; target: LynxViewTarget };

export type LynxProbeResult =
  | { status: 'ok'; transport: LynxChosenTransport }
  | { status: 'needs-login' }
  | { status: 'unreachable' };

export type LynxReprobeOutcome = 'switched' | 'unchanged' | 'unreachable' | 'no-connection';

export type LynxCandidateRefreshResult = 'updated' | 'unchanged' | 'skipped';

export const LYNX_CONNECTIONS_LIMIT = 12;
export const LYNX_CONNECT_TIMEOUT_MS = 8_000;
export const LYNX_RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const LYNX_FAST_PROBE_TIMEOUT_MS = 2_500;
export const LYNX_RELAY_RACE_HEADSTART_MS = 1_500;
export const LYNX_CANDIDATE_REFRESH_DELAY_MS = 5_000;
export const LYNX_SECURE_TIMEOUT_MS = 3_000;

export const LYNX_METADATA_STORAGE_KEY = 'openchamber.mobile.connections.v1';
export const LYNX_DEVICE_ID_STORAGE_KEY = 'openchamber.mobile.deviceId';
export const LYNX_SECURE_TOKEN_PREFIX = 'openchamber.mobile.token.';

export const LYNX_CLIENT_LABEL = 'OpenChamber Mobile';
export const LYNX_CLIENT_KIND = 'mobile';
