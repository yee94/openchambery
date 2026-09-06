import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type PushRelayState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
export type PushRelayEnv = 'production' | 'sandbox';

export interface PushRelayLimits {
  timestampSkewMs: number;
  replayMs: number;
  maxReplayEntries: number;
  registerLimitPerMinute: number;
  sendLimitPerMinute: number;
  serverSendLimitPerMinute: number;
  maxTokens: number;
  maxInFlight: number;
  maxRateLimitEntries: number;
  jsonBodyBytes: number;
}

export interface PushRelayApnsConfig {
  keyId: string;
  teamId: string;
  p8: string;
  bundleId: string;
}

export interface PushRelayClock {
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  setImmediate: typeof globalThis.setImmediate;
}

export interface PushApnsSendInput {
  token: string;
  env: PushRelayEnv;
  payload: unknown;
  collapseId?: string;
  pushType?: 'alert' | 'liveactivity';
}

export interface PushApnsSendResult {
  ok: boolean;
  drop?: boolean;
}

export interface PushApnsProvider {
  send(input: PushApnsSendInput): Promise<PushApnsSendResult>;
  close?(): void;
}

export interface PushTokenRecord {
  serverId: string;
  platform: string;
  updatedAt: number;
}

export interface PushTokenStore {
  get(token: string): PushTokenRecord | null;
  upsert(token: string, serverId: string, platform: string, updatedAt: number): void;
  delete(token: string): void;
  count(): number;
  close(): void;
}

export interface PushRelaySnapshotReasons {
  authRejected: number;
  policyRejected: number;
  limited: number;
  replayRejected: number;
}

export interface PushRelaySnapshot {
  state: PushRelayState;
  tokenCount: number;
  inFlight: number;
  replayEntries: number;
  reasons: PushRelaySnapshotReasons;
}

export interface PushRelayOptions {
  host?: string;
  port?: number;
  trustProxy?: boolean;
  databasePath?: string;
  limits?: Partial<PushRelayLimits>;
  apns?: PushRelayApnsConfig;
  apnsProvider?: PushApnsProvider;
  clock?: Partial<PushRelayClock>;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  resolveClientIp?: (request: IncomingMessage) => string;
  store?: PushTokenStore;
  http2?: { connect: typeof import('node:http2').connect };
}

export interface PushRelayServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): string | AddressInfo | null | undefined;
  readonly url: string | null;
  getSnapshot(): PushRelaySnapshot;
}

export function resolvePushRelayClientIp(request: IncomingMessage, trustProxy?: boolean): string;
export function formatPushRelayUrl(host: string, port: number): string;
export function canonicalPublicJwkString(jwk: { crv: string; kty: string; x: string; y: string }): string;
export function deriveServerId(jwk: { crv: string; kty: string; x: string; y: string }): string;
export function createPushRelayServer(options?: PushRelayOptions): PushRelayServerInstance;
export function startPushRelayServer(options?: PushRelayOptions): Promise<PushRelayServerInstance>;
