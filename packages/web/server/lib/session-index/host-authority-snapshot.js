/**
 * Apply committed Host archive authority onto a session-index snapshot / lookup.
 * Used by production GET routes so SQLite rows never surface Host-archived
 * sessions (or pins) after a crash between metadata commit and index apply.
 */

import {
  isSessionArchived,
  projectSessionWithHostMetadata,
  readHostArchivedAt,
} from '../session-metadata/session-projection.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object | null | undefined} session summary-shaped session from index
 * @param {Record<string, object> | null} storedById committed Host metadata map
 */
export const projectIndexSessionWithHost = (session, storedById) => {
  if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
  const host = storedById && isPlainObject(storedById[session.id]) ? storedById[session.id] : null;
  // Index summaries already carry time.*; fold Host archive the same way as proxy.
  return projectSessionWithHostMetadata(session, host);
};

/**
 * Filter a full index snapshot through Host archive authority.
 * Archived sessions drop from directory lists; pins for Host-archived ids drop.
 *
 * @param {object} snapshot `{ directories, pinnedSessionIds, ... }`
 * @param {Record<string, object>} storedById
 */
export const applyHostArchiveToIndexSnapshot = (snapshot, storedById) => {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const stored = storedById && typeof storedById === 'object' ? storedById : {};

  const directories = Array.isArray(snapshot.directories)
    ? snapshot.directories.map((directory) => {
      if (!directory || typeof directory !== 'object') return directory;
      const sessions = Array.isArray(directory.sessions)
        ? directory.sessions
          .map((session) => projectIndexSessionWithHost(session, stored))
          .filter((session) => session && !isSessionArchived(session))
        : [];
      return { ...directory, sessions };
    })
    : snapshot.directories;

  const pinnedSessionIds = Array.isArray(snapshot.pinnedSessionIds)
    ? snapshot.pinnedSessionIds.filter((id) => {
      if (typeof id !== 'string' || !id) return false;
      const hostArchived = readHostArchivedAt(stored[id]);
      // positive Host archive hides pin; 0 / missing keep pin membership.
      return !(typeof hostArchived === 'number' && hostArchived > 0);
    })
    : snapshot.pinnedSessionIds;

  return {
    ...snapshot,
    directories,
    pinnedSessionIds,
  };
};

/**
 * Lookup hit: if Host-archived, treat as not found for active deep-links.
 * @returns {{ session: object } | { hidden: true } | null}
 */
export const applyHostArchiveToLookupHit = (hit, storedById) => {
  if (!hit || typeof hit !== 'object') return null;
  const projected = projectIndexSessionWithHost(
    {
      ...hit,
      time: {
        created: hit.createdAt,
        updated: hit.updatedAt,
        ...(hit.archivedAt ? { archived: hit.archivedAt } : {}),
      },
    },
    storedById,
  );
  if (isSessionArchived(projected)) return { hidden: true };
  return {
    session: {
      ...hit,
      // Expose projected archive stamp for clients that read time from lookup.
      archivedAt: projected?.time?.archived ?? 0,
      time: projected?.time,
      metadata: projected?.metadata,
    },
  };
};
