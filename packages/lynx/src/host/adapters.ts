import type {
  LynxDevicePlatform,
  LynxHttpInit,
  LynxHttpResponse,
  LynxHttpTransport,
  LynxQrScanRaw,
  LynxRelayConfig,
  LynxRuntimeBind,
} from '../connect/types.ts';

/**
 * Host adapters the Lynx shell (or a test) injects into the connect kernel.
 *
 * Integration point: a future iOS/Android Lynx host implements these and calls
 * `createLynxConnectionController`. There is no Lynx app package yet.
 *
 * - `request` — native HTTP to a LAN/tunnel URL (ATS/cleartext as the host allows).
 * - `openRelay` — open the official E2EE relay tunnel, then HTTP over it.
 *   Do not invent a redeem URL; redeem still hits `/api/client-auth/pairing/redeem`.
 * - `secureStore` — Keychain / Keystore. Tokens never enter metadata storage.
 * - `scanQr` — optional camera. Parsing is in the kernel; the host only returns raw text.
 * - `bindRuntime` — switch the shell's active OpenChamber origin + bearer.
 */
export type LynxSecureStore = {
  getToken: (key: string) => Promise<string | undefined>;
  setToken: (key: string, token: string) => Promise<boolean>;
  deleteToken: (key: string) => Promise<void>;
};

export type LynxJsonStore = {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  remove?: (key: string) => void;
};

export type LynxClock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type LynxLogger = {
  info: (step: string, detail?: Record<string, unknown>) => void;
  warn: (step: string, detail?: Record<string, unknown>) => void;
};

export type LynxHostAdapters = {
  request: (url: string, init?: LynxHttpInit) => Promise<LynxHttpResponse>;
  openRelay?: (relay: LynxRelayConfig, grant?: string) => Promise<LynxHttpTransport>;
  /** Authenticated fetch on the already-bound runtime (direct or relay). */
  runtimeFetch?: (path: string, init?: LynxHttpInit) => Promise<LynxHttpResponse>;
  secureStore: LynxSecureStore;
  metadataStore: LynxJsonStore;
  clock?: LynxClock;
  logger?: LynxLogger;
  createId?: () => string;
  devicePlatform?: LynxDevicePlatform;
  bindRuntime?: (bind: LynxRuntimeBind) => void;
  scanQr?: () => Promise<LynxQrScanRaw>;
  /** Bound runtime identity, used by resume re-probe. */
  getRuntimeKey?: () => string | null;
  isRelayModeActive?: () => boolean;
  getRuntimeDirectUrl?: () => string | null;
};
