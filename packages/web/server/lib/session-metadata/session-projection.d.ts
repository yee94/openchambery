/**
 * Type surface for session-projection.js (consumed by VS Code Extension Host facades).
 * Runtime implementation stays in the .js module.
 */

export const HOST_ARCHIVE_METADATA_KEY: string;

export function normalizeSessionEventType(type: unknown): string;

export function isSessionLifecycleEventType(type: unknown): boolean;

export function extractSessionInfoFromPayload(
  payload: unknown,
): { id: string; [key: string]: unknown } | null;

export function resolveSessionDirectory(session: unknown): string | null;

export function readHostArchivedAt(metadata: unknown): number | null;

export function resolveProjectedArchivedAt(
  upstreamArchived: unknown,
  hostArchivedAt: unknown,
): number | null | undefined;

export function isSessionArchived(session: unknown): boolean;

export function projectSessionWithHostMetadata(
  session: unknown,
  hostMetadata: unknown,
): unknown;

export function projectSessionWithStoredMap(
  session: unknown,
  storedBySessionId: unknown,
): unknown;

export function projectSessionLifecyclePayload(
  payload: unknown,
  readHostMetadata: (sessionId: string) => unknown,
  options?: { hostReady?: boolean },
): unknown;
