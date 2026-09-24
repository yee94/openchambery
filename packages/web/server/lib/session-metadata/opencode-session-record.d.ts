export function mergeOwnedMetadata(
  openCodeMetadata: unknown,
  sideMetadata: unknown,
): Record<string, unknown>;

export function writeSessionRecordViaClient(
  client: { session?: { update?: (input: unknown, requestOptions?: unknown) => Promise<unknown> } } | null | undefined,
  input: {
    sessionID: string;
    metadata?: Record<string, unknown>;
    title?: string;
    requestOptions?: object;
  },
): Promise<void>;

export function readSessionRecordViaClient(
  client: { session?: { get?: (input: unknown, requestOptions?: unknown) => Promise<unknown> } } | null | undefined,
  input: { sessionID: string; requestOptions?: object },
): Promise<Record<string, unknown> | null>;

export function createHttpSessionRecordClient(options: {
  buildSessionUrl: (sessionID: string, directory?: string | null) => string;
  getHeaders?: () => Record<string, string>;
  fetchFn?: typeof fetch;
}): {
  read: (sessionID: string, directory?: string | null) => Promise<Record<string, unknown> | null>;
  write: (input: {
    sessionID: string;
    metadata?: Record<string, unknown>;
    title?: string;
    directory?: string | null;
  }) => Promise<void>;
};

export function migrateLoadedSideStore(input: {
  loadResult: { ok?: boolean; entries?: Record<string, object> | null } | null;
  readSession: (sessionID: string) => Promise<object | null>;
  writeMetadata: (sessionID: string, metadata: object, record: object) => Promise<void>;
}): Promise<{
  status: 'unavailable' | 'partial' | 'complete';
  migrated: string[];
  failed: Array<{ id: string; error: string }>;
  absent: string[];
}>;

export function retainOpenCodeSessions(
  openCodeSessions: unknown,
  sideById: Record<string, object> | null | undefined,
): unknown[];

export function startSideStoreMigration(options: {
  load: () => Promise<{ ok?: boolean; entries?: Record<string, object> }>;
  readSession: (sessionID: string) => Promise<object | null>;
  writeMetadata: (sessionID: string, metadata: object, record: object) => Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): () => void;
