import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RelaySocketRole = 'client' | 'host-control' | 'host-data';

export interface Limits {
  maxUrlBytes: number;
  maxFieldBytes: number;
  maxHosts: number;
  maxSockets: number;
  maxConnections: number;
  maxClientsPerHost: number;
  maxClientsPerIp: number;
  maxPendingClients: number;
  pendingMs: number;
  maxRawSockets: number;
  maxRawSocketsPerIp: number;
  graceMs: number;
  timestampSkewMs: number;
  replayMs: number;
  maxReplayEntries: number;
  maxFrameBytes: number;
  maxQueuedBytesPerConnection: number;
  maxGlobalQueuedBytes: number;
  maxBufferedAmount: number;
  maxControlQueueEntries: number;
  maxControlQueuedBytes: number;
  pumpRetryMs: number;
  heartbeatMs: number;
  handshakeMs: number;
  closeDeadlineMs: number;
  admissionWindowMs: number;
  maxAdmissionsPerIp: number;
  maxAdmissionEntries: number;
  idAttempts: number;
}

export interface SnapshotReasons {
  authRejected: number;
  policyRejected: number;
  limited: number;
  heartbeatReaped: number;
  replayRejected: number;
}

export interface Snapshot {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  hosts: number;
  sockets: number;
  rawSockets: number;
  controls: number;
  clients: number;
  pairs: number;
  pending: number;
  queuedBytes: number;
  reasons: SnapshotReasons;
}

export interface Clock {
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

export interface Options {
  host?: string;
  port?: number;
  path?: string;
  trustProxy?: boolean;
  requestHandler?: (request: IncomingMessage, response: ServerResponse) => boolean;
  clock?: Partial<Clock>;
  randomBytes?: (size: number) => Buffer;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  limits?: Partial<Limits>;
  resolveClientIp?: (request: IncomingMessage) => string;
  onSocketAccepted?: (connection: { socket: unknown; role: RelaySocketRole }) => void;
}

export interface ServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): string | AddressInfo | null | undefined;
  readonly wsUrl: string | null;
  getSnapshot(): Snapshot;
}

export function resolveRelayClientIp(request: IncomingMessage, trustProxy?: boolean): string;
export function formatRelayWsUrl(host: string, port: number, relayPath: string): string;
export function createPrivateRelayServer(options?: Options): ServerInstance;
export function startPrivateRelayServer(options?: Options): Promise<ServerInstance>;
