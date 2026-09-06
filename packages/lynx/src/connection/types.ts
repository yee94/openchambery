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
  hasToken?: boolean;
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

export type LynxConnectError =
  | 'url-required'
  | 'unreachable'
  | 'auth-required'
  | 'invalid-url'
  | 'password-failed'
  | 'secure-store-failed';

export type LynxChosenTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: LynxRelayConfig };

export type LynxConnectResult =
  | { status: 'connected'; connection: LynxSavedConnection; transport: LynxChosenTransport; runtimeKey: string }
  | { status: 'needs-login'; pending: LynxPendingConnection }
  | { status: 'failed'; error: LynxConnectError };

export type LynxHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional — Cap `/api/fs/read` returns text/plain; host/http clients should provide this. */
  text?: () => Promise<string>;
};

export type LynxRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type LynxHttpClient = {
  request: (url: string, init?: LynxRequestInit) => Promise<LynxHttpResponse | null>;
};

export type LynxRelayTunnel = {
  fetch: (path: string, init?: LynxRequestInit) => Promise<LynxHttpResponse | null>;
  close: () => void;
};

export type LynxRelayTunnelFactory = (
  relay: LynxRelayConfig,
  grant?: string,
) => LynxRelayTunnel;

export type LynxSecureStore = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
};

export type LynxKvStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

export type LynxClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type LynxDevicePlatform = 'ios' | 'android';

export type LynxRuntimeIdentity = {
  runtimeKey: string;
  clientToken: string | null;
  transport: LynxChosenTransport;
};

export type LynxSessionStatus = {
  authenticated?: boolean;
  disabled?: boolean;
  scope?: string;
};
