/**
 * Host authority projection for OpenCode sessions.
 *
 * OpenCode 2.x has no durable archive write. OpenChamber stores archive state
 * under `metadata.openchamber.archive.archivedAt` and folds it onto session
 * list/detail/event payloads so clients keep reading `time.archived`.
 *
 * Authority:
 * - positive archivedAt → Host archive wins
 * - 0 → explicit unarchive (clears time.archived even if upstream still has history)
 * - missing Host archive key → fall back to upstream time.archived
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** RFC 7386 merge (local copy — avoid circular import with the metadata store). */
const mergeMetadataPatch = (current, patch) => {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value;
  }
  return base;
};

export const HOST_ARCHIVE_METADATA_KEY = 'archive';

const SESSION_LIFECYCLE_BASE = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
]);

/**
 * Strip optional version suffixes: `session.updated.v2` → `session.updated`.
 * @param {unknown} type
 * @returns {string}
 */
export const normalizeSessionEventType = (type) => {
  if (typeof type !== 'string' || !type) return '';
  const match = type.match(/^(session\.(?:created|updated|deleted|status|idle|error))(?:\.|$)/);
  return match ? match[1] : type;
};

export const isSessionLifecycleEventType = (type) => SESSION_LIFECYCLE_BASE.has(normalizeSessionEventType(type));

/**
 * Resolve session info from legacy `properties.info`, native v2 `data.info`,
 * or a bare session object under properties/data.
 * @param {object | null | undefined} payload
 */
export const extractSessionInfoFromPayload = (payload) => {
  if (!isPlainObject(payload)) return null;
  const properties = isPlainObject(payload.properties) ? payload.properties : null;
  const data = isPlainObject(payload.data) ? payload.data : null;

  const candidates = [
    properties?.info,
    data?.info,
    // Bare session on properties/data when shape is already a Session.
    properties && typeof properties.id === 'string' ? properties : null,
    data && typeof data.id === 'string' ? data : null,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && typeof candidate.id === 'string' && candidate.id) {
      return candidate;
    }
  }
  return null;
};

/**
 * Authoritative worktree directory: v2 `location.directory`, then legacy fields.
 * @param {object | null | undefined} session
 */
export const resolveSessionDirectory = (session) => {
  if (!isPlainObject(session)) return null;
  const candidates = [
    session.location?.directory,
    session.directory,
    session.project?.worktree,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized) return normalized;
  }
  return null;
};

/**
 * @param {unknown} value
 * @returns {number | null} finite number including 0, else null when absent/invalid
 */
export const readHostArchivedAt = (metadata) => {
  if (!isPlainObject(metadata)) return null;
  const openchamber = metadata.openchamber;
  if (!isPlainObject(openchamber)) return null;
  if (!Object.prototype.hasOwnProperty.call(openchamber, HOST_ARCHIVE_METADATA_KEY)) return null;
  const archive = openchamber[HOST_ARCHIVE_METADATA_KEY];
  if (!isPlainObject(archive) || !Object.prototype.hasOwnProperty.call(archive, 'archivedAt')) return null;
  const value = archive.archivedAt;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

/**
 * @param {unknown} upstreamArchived
 * @param {number | null} hostArchivedAt
 * @returns {number | undefined}
 */
export const resolveProjectedArchivedAt = (upstreamArchived, hostArchivedAt) => {
  if (hostArchivedAt === 0) return undefined;
  if (typeof hostArchivedAt === 'number' && hostArchivedAt > 0) return Math.trunc(hostArchivedAt);
  if (typeof upstreamArchived === 'number' && Number.isFinite(upstreamArchived) && upstreamArchived > 0) {
    return Math.trunc(upstreamArchived);
  }
  return undefined;
};

export const isSessionArchived = (session) => {
  const archived = session?.time?.archived;
  return typeof archived === 'number' && Number.isFinite(archived) && archived > 0;
};

/**
 * Deep-merge Host metadata onto an upstream session and apply archive authority
 * to `time.archived`. Does not mutate created/updated.
 *
 * @param {object | null | undefined} session
 * @param {object | null | undefined} hostMetadata single session metadata object
 * @returns {object | null | undefined}
 */
export const projectSessionWithHostMetadata = (session, hostMetadata) => {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  if (typeof session.id !== 'string' || !session.id) return session;

  const theirs = isPlainObject(session.metadata) ? session.metadata : {};
  const ours = isPlainObject(hostMetadata) ? hostMetadata : null;
  const metadata = ours ? mergeMetadataPatch(theirs, ours) : theirs;

  const hostArchivedAt = readHostArchivedAt(ours ?? metadata);
  const upstreamArchived = session.time && typeof session.time === 'object'
    ? session.time.archived
    : undefined;
  const projectedArchived = resolveProjectedArchivedAt(upstreamArchived, hostArchivedAt);

  const timeBase = session.time && typeof session.time === 'object' && !Array.isArray(session.time)
    ? { ...session.time }
    : {};
  if (projectedArchived === undefined) delete timeBase.archived;
  else timeBase.archived = projectedArchived;

  const directory = resolveSessionDirectory(session);
  const next = {
    ...session,
    metadata: Object.keys(metadata).length > 0 ? metadata : (session.metadata ?? metadata),
    time: timeBase,
    ...(directory ? { directory } : {}),
  };
  if (Object.keys(metadata).length === 0 && session.metadata === undefined) {
    delete next.metadata;
  }
  return next;
};

/**
 * @param {object | null | undefined} session
 * @param {Record<string, object> | null | undefined} storedBySessionId
 */
export const projectSessionWithStoredMap = (session, storedBySessionId) => {
  if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
  if (!storedBySessionId || typeof storedBySessionId !== 'object') {
    return projectSessionWithHostMetadata(session, null);
  }
  const host = storedBySessionId[session.id];
  return projectSessionWithHostMetadata(session, isPlainObject(host) ? host : null);
};

const projectLifecycleInner = (payload, readHostMetadata) => {
  const baseType = normalizeSessionEventType(payload.type);
  if (baseType !== 'session.created' && baseType !== 'session.updated') return payload;

  const info = extractSessionInfoFromPayload(payload);
  if (!info) return payload;

  let host = null;
  if (typeof readHostMetadata === 'function') {
    try {
      host = readHostMetadata(info.id);
    } catch {
      host = null;
    }
  }
  const projected = projectSessionWithHostMetadata(info, isPlainObject(host) ? host : null);
  if (projected === info) return payload;

  const next = { ...payload };
  if (isPlainObject(payload.properties) && payload.properties.info === info) {
    next.properties = { ...payload.properties, info: projected };
  } else if (isPlainObject(payload.properties) && payload.properties === info) {
    next.properties = projected;
  }
  if (isPlainObject(payload.data) && payload.data.info === info) {
    next.data = { ...payload.data, info: projected };
  } else if (isPlainObject(payload.data) && payload.data === info) {
    next.data = projected;
  }
  // Keep original type string (including version suffix).
  return next;
};

/**
 * Project session.created / session.updated event payloads.
 * Supports GlobalEvent wrap, versioned types, legacy properties.info, and
 * native v2 data.info. Non-lifecycle payloads are returned unchanged.
 * Envelope fields outside the inner payload are preserved.
 *
 * @param {unknown} payload
 * @param {(sessionId: string) => object | null | undefined} readHostMetadata
 * @param {{ hostReady?: boolean }} [options]
 *   When `hostReady === false`, lifecycle payloads return `null` (caller drops
 *   outbound publish). Transcript/message events are unaffected.
 */
export const projectSessionLifecyclePayload = (payload, readHostMetadata, options = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  // GlobalEvent wrap: { directory, payload: { type, ... } } — preserve envelope.
  if (isPlainObject(payload.payload) && typeof payload.payload.type === 'string') {
    const innerType = normalizeSessionEventType(payload.payload.type);
    if (SESSION_LIFECYCLE_BASE.has(innerType) || innerType.startsWith('session.')) {
      if (options.hostReady === false && isSessionLifecycleEventType(payload.payload.type)) {
        return null;
      }
      const inner = projectSessionLifecyclePayload(payload.payload, readHostMetadata, options);
      if (inner == null) return null;
      return inner === payload.payload ? payload : { ...payload, payload: inner };
    }
  }

  const type = typeof payload.type === 'string' ? payload.type : '';
  if (options.hostReady === false && isSessionLifecycleEventType(type)) {
    return null;
  }
  if (!isSessionLifecycleEventType(type) && normalizeSessionEventType(type) !== 'session.created'
    && normalizeSessionEventType(type) !== 'session.updated') {
    return payload;
  }

  return projectLifecycleInner(payload, readHostMetadata);
};
