/**
 * Type surface for session-metadata-store.js (consumed by VS Code Extension Host facades).
 * Runtime implementation stays in the .js module.
 */

export type SessionMetadataLoadResult =
  | { ok: true; entries: Record<string, Record<string, unknown>>; reason?: null }
  | { ok: false; entries: Record<string, unknown>; reason: string | null };

export type SessionMetadataStore = {
  load: () => Promise<SessionMetadataLoadResult>;
  get: (sessionID: string) => Promise<Record<string, unknown>>;
  getAll: () => Promise<Record<string, Record<string, unknown>>>;
  getSnapshotSync: () => Record<string, Record<string, unknown>> | null;
  isLoaded: () => boolean;
  getLoadFailureReason: () => string | null;
  setSessionMetadata: (
    sessionID: string,
    patch: object,
    options?: { allowArchive?: boolean },
  ) => Promise<Record<string, unknown>>;
  removeSession: (sessionID: string) => Promise<boolean>;
  filePath: string;
};

export function mergeMetadataPatch(
  current: unknown,
  patch: unknown,
): Record<string, unknown>;

export function createSessionMetadataStore(options: {
  dataDir: string;
  fsPromises?: typeof import('node:fs').promises;
  path?: typeof import('node:path');
  now?: () => number;
}): SessionMetadataStore;
