/**
 * Typed facades over shared Web session-metadata JS cores.
 * Logic stays in packages/web/server/lib/session-metadata/* — this file only
 * re-exports stable TypeScript shapes from sibling .d.ts next to those JS modules
 * (no @ts-nocheck; no blind casts of the runtime bindings).
 */
import {
  createSessionArchiveService,
  SessionArchiveError,
  type SessionArchiveService,
  type SessionForgetResult,
  type SessionArchiveIndexResult,
} from '../../web/server/lib/session-metadata/session-archive.js';
import {
  createSessionMetadataStore,
  type SessionMetadataStore,
} from '../../web/server/lib/session-metadata/session-metadata-store.js';
import {
  createHttpSessionRecordClient,
  startSideStoreMigration,
} from '../../web/server/lib/session-metadata/opencode-session-record.js';
import {
  extractSessionInfoFromPayload,
  isSessionLifecycleEventType,
  normalizeSessionEventType,
  projectSessionLifecyclePayload,
  projectSessionWithStoredMap,
  resolveSessionDirectory,
} from '../../web/server/lib/session-metadata/session-projection.js';

export type {
  SessionMetadataStore,
  SessionArchiveService,
  SessionArchiveIndexResult,
  SessionForgetResult,
};

export type SessionArchiveErrorLike = Error & {
  code: string;
  status: number;
};

export const isSessionArchiveError = (error: unknown): error is SessionArchiveErrorLike =>
  Boolean(
    error
    && typeof error === 'object'
    && error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { status?: unknown }).status === 'number',
  );

export {
  SessionArchiveError,
  createSessionMetadataStore,
  createHttpSessionRecordClient,
  startSideStoreMigration,
  createSessionArchiveService,
  projectSessionWithStoredMap,
  projectSessionLifecyclePayload,
  normalizeSessionEventType,
  isSessionLifecycleEventType,
  extractSessionInfoFromPayload,
  resolveSessionDirectory,
};
