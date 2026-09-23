/**
 * Type surface for session-archive.js (consumed by VS Code Extension Host facades).
 * Runtime implementation stays in the .js module.
 */

export class SessionArchiveError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status?: number);
}

export type SessionArchiveIndexResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; error?: string; retryable?: boolean };

export type SessionForgetResult =
  | { ok: true; removed: boolean }
  | { ok: false; removed: false; retryable?: boolean; error?: string };

export type SessionArchiveService = {
  setArchive: (input: {
    sessionID: string;
    archivedAt: number;
    directory?: string;
  }) => Promise<{
    session: Record<string, unknown>;
    metadata: Record<string, unknown>;
    archivedAt: number;
    index?: SessionArchiveIndexResult;
  }>;
  forgetSession: (sessionID: string) => Promise<SessionForgetResult | boolean>;
  stop?: () => void;
};

export function createSessionArchiveService(deps?: {
  sessionMetadataStore: {
    setSessionMetadata: (
      sessionID: string,
      patch: object,
      options?: { allowArchive?: boolean },
    ) => Promise<Record<string, unknown>>;
    get: (sessionID: string) => Promise<Record<string, unknown>>;
    removeSession?: (sessionID: string) => Promise<boolean>;
    getSnapshotSync?: () => Record<string, Record<string, unknown>> | null;
  };
  fetchUpstreamSession: (input: {
    sessionID: string;
    directory?: string | null;
  }) => Promise<object | null>;
  sessionIndexService?: {
    upsert?: (...args: unknown[]) => unknown;
    upsertAndReportChange?: (...args: unknown[]) => unknown;
    remove?: (...args: unknown[]) => unknown;
  } | null;
  broadcastSessionEvent?: (
    event: { type: string; properties: object },
    options?: object,
  ) => void;
  onIndexChanged?: (sessionID: string) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): SessionArchiveService;

export function createUpstreamSessionFetcher(deps: {
  buildOpenCodeUrl: (path: string) => string;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (input: {
  sessionID: string;
  directory?: string | null;
}) => Promise<object | null>;
