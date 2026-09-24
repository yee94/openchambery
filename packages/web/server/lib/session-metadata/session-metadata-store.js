/**
 * OpenChamber session metadata cache and migration source.
 *
 * The OpenCode session record is the durable authority for title, archive, and
 * other OpenChamber metadata (`opencode-session-record.js`). This JSON file
 * remains the cache and the pre-migration source. A failed or corrupt read is
 * never empty success: the store stays unwritable and does not overwrite
 * unknown disk state or the OpenCode record.
 *
 * Writes are a JSON Merge Patch (RFC 7386): nested objects merge key by key and
 * a `null` deletes. That keeps two features writing into the same `openchamber`
 * namespace from erasing each other — goal mode saving progress must not drop
 * an assist recap. When a record reader and writer are wired, the merged object
 * is written onto the OpenCode session before the local cache commits. A failed
 * record read is not treated as empty metadata.
 *
 * Mutations are fully serialized. Committed `entries` update only after a
 * successful persist so concurrent readers never observe uncommitted drafts.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { mergeOwnedMetadata } from './opencode-session-record.js';

const METADATA_FILE_NAME = 'sessions-metadata.json';
const HOST_ARCHIVE_KEY = 'archive';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current, patch) => {
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

const readPriorArchivedAt = (metadata) => {
  if (!isPlainObject(metadata?.openchamber)) return null;
  if (!Object.prototype.hasOwnProperty.call(metadata.openchamber, HOST_ARCHIVE_KEY)) return null;
  const archive = metadata.openchamber[HOST_ARCHIVE_KEY];
  if (!isPlainObject(archive) || !Object.prototype.hasOwnProperty.call(archive, 'archivedAt')) return null;
  const value = archive.archivedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Strip Host archive writes from generic metadata patches. */
const stripArchiveFromMetadataPatch = (patch) => {
  if (!isPlainObject(patch) || !isPlainObject(patch.openchamber)) return patch;
  if (!Object.prototype.hasOwnProperty.call(patch.openchamber, HOST_ARCHIVE_KEY)) return patch;
  const openchamber = { ...patch.openchamber };
  delete openchamber[HOST_ARCHIVE_KEY];
  return { ...patch, openchamber };
};

/**
 * Restore reserved archive after a generic merge so null ancestor deletes
 * (`openchamber: null` / `archive: null`) cannot wipe Host archive state.
 */
const applyReservedArchiveProtection = (previous, patch, merged, { allowArchive = false } = {}) => {
  if (allowArchive) return merged;
  const priorArchive = readPriorArchivedAt(previous);
  const result = isPlainObject(merged) ? { ...merged } : {};
  const openchamber = isPlainObject(result.openchamber) ? { ...result.openchamber } : {};

  if (isPlainObject(patch?.openchamber) && Object.prototype.hasOwnProperty.call(patch.openchamber, HOST_ARCHIVE_KEY)) {
    delete openchamber[HOST_ARCHIVE_KEY];
  }

  if (priorArchive !== null) {
    openchamber[HOST_ARCHIVE_KEY] = {
      ...(isPlainObject(previous?.openchamber?.[HOST_ARCHIVE_KEY])
        ? previous.openchamber[HOST_ARCHIVE_KEY]
        : {}),
      archivedAt: priorArchive,
    };
  } else {
    delete openchamber[HOST_ARCHIVE_KEY];
  }

  if (Object.keys(openchamber).length > 0) result.openchamber = openchamber;
  else delete result.openchamber;
  return result;
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 * @param {(sessionID: string, directory?: string | null) => Promise<object | null>} [options.recordReader]
 *   OpenCode session read. Null means the session is gone. Any other failure throws.
 * @param {(sessionID: string, metadata: object, directory?: string | null) => Promise<void>} [options.recordWriter]
 *   Writes the full merged metadata onto the OpenCode session record. Must not send title.
 */
export const createSessionMetadataStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
  recordReader = null,
  recordWriter = null,
}) => {
  if (typeof recordWriter === 'function' && typeof recordReader !== 'function') {
    throw new Error('session record writer requires a record reader');
  }
  const filePath = path.join(dataDir, METADATA_FILE_NAME);

  /** sessionID → metadata. Committed only — never holds an in-flight draft. */
  const entries = new Map();
  let loaded = false;
  let loadPromise = null;
  /**
   * Writes stay disabled until one load has told us what is already on disk.
   * A failed/corrupt read is not evidence that nothing is stored.
   */
  let writable = false;
  let loadFailureReason = null;
  /** Full RMW + persist chain — concurrent writers cannot interleave merges. */
  let mutationChain = Promise.resolve();

  const snapshotFrom = (map) => Object.fromEntries(map);
  const snapshot = () => snapshotFrom(entries);

  const unavailableError = (detail = loadFailureReason) => {
    const suffix = detail ? `: ${detail}` : ': its file could not be read';
    return new Error(`session metadata is unavailable${suffix.startsWith(':') ? suffix : `: ${suffix}`}`);
  };

  const parseStored = (raw) => {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error('session metadata file is not a JSON object');
    }
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, stored: new Map() };
      console.warn('[session-metadata] could not read the session metadata file:', error?.message ?? error);
      return { ok: false, stored: null, reason: error?.message || 'read failed' };
    }

    try {
      return { ok: true, stored: parseStored(raw) };
    } catch (error) {
      // Corrupt bytes must not become empty success. Keep the file, stay
      // unwritable, and surface the error so callers can report/retry.
      console.warn(
        `[session-metadata] session metadata file is corrupt and will not be overwritten: ${error?.message ?? error}`,
      );
      return { ok: false, stored: null, reason: error?.message || 'corrupt metadata file' };
    }
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile().then((result) => {
        if (result.ok) {
          for (const [id, metadata] of result.stored) {
            if (!entries.has(id)) entries.set(id, metadata);
          }
          loaded = true;
          writable = true;
          loadFailureReason = null;
        } else {
          loadPromise = null;
          loaded = false;
          writable = false;
          loadFailureReason = result.reason || 'its file could not be read';
        }
        return { ok: result.ok, entries: snapshot(), reason: result.reason || null };
      });
    }
    return loadPromise;
  };

  const ensureReadable = async () => {
    const result = await load();
    if (!result.ok || !writable) throw unavailableError(result.reason);
    return result;
  };

  const persistMap = async (map) => {
    const payload = JSON.stringify(snapshotFrom(map));
    await fsPromises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  };

  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  const runExclusive = (work) => {
    const next = mutationChain.then(work, work);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const readRecordMetadata = async (id, directory) => {
    if (typeof recordReader !== 'function') return undefined;
    try {
      const record = await recordReader(id, directory);
      if (record == null) return null;
      return isPlainObject(record.metadata) ? record.metadata : {};
    } catch (error) {
      if (entries.has(id)) return undefined;
      throw error;
    }
  };

  const get = async (sessionID, options = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await ensureReadable();
    const side = entries.get(id);
    const fromRecord = await readRecordMetadata(id, options.directory);
    if (fromRecord === undefined) return side ?? {};
    if (fromRecord === null) return side ?? {};
    return mergeOwnedMetadata(fromRecord, side);
  };

  const has = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return false;
    await ensureReadable();
    return entries.has(id);
  };

  /**
   * Shared exclusive commit path: merge → persist draft → publish committed.
   * Readers never observe the draft; persist failure leaves prior committed state.
   *
   * @param {string} id
   * @param {object | undefined} previous
   * @param {object} patch
   * @param {{ allowArchive?: boolean }} options
   */
  const commitMergedPatch = async (id, previous, patch, options = {}) => {
    const allowArchive = options.allowArchive === true;
    let base = previous;
    if (typeof recordReader === 'function') {
      let record;
      try {
        record = await recordReader(id, options.directory);
      } catch (error) {
        // A failed read is not an empty record. Do not replace metadata we could not see.
        throw error;
      }
      if (record == null) {
        const error = new Error(`session ${id} was not found`);
        error.status = 404;
        throw error;
      }
      base = mergeOwnedMetadata(record.metadata, previous);
    }
    const effectivePatch = allowArchive ? patch : stripArchiveFromMetadataPatch(patch);

    let merged = mergeMetadataPatch(base, effectivePatch);
    merged = applyReservedArchiveProtection(base, patch, merged, { allowArchive });

    if (typeof recordWriter === 'function') {
      await recordWriter(id, merged, options.directory);
    }

    const nextMap = new Map(entries);
    if (Object.keys(merged).length === 0) nextMap.delete(id);
    else nextMap.set(id, merged);

    // OpenCode write already landed. Publish the local cache only after its persist succeeds.
    await persistMap(nextMap);

    if (Object.keys(merged).length === 0) entries.delete(id);
    else entries.set(id, merged);

    return merged;
  };

  /**
   * Applies a merge patch and returns the session's full metadata afterwards.
   * Committed map updates only after persist succeeds — readers never see drafts.
   *
   * @param {string} sessionID
   * @param {object} patch
   * @param {{ allowArchive?: boolean }} [options]
   */
  const setSessionMetadata = async (sessionID, patch, options = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');

    return runExclusive(async () => {
      await ensureReadable();
      return commitMergedPatch(id, entries.get(id), patch, options);
    });
  };

  /**
   * Conditional metadata mutation on the same exclusive serial boundary as
   * setSessionMetadata. `decide(committedMetadata)` runs while the lock is held
   * and must return synchronously:
   *   - `{ ok: false, reason? }` — no persist; readers keep prior committed state
   *   - `{ ok: true, patch }` — merge-patch, persist, then publish
   *
   * Use this for goal generation / status preconditions so a stale auditor
   * cannot commit after a user pause that already landed.
   *
   * @param {string} sessionID
   * @param {(current: object) => { ok: false, reason?: string } | { ok: true, patch: object }} decide
   * @param {{ allowArchive?: boolean }} [options]
   * @returns {Promise<{ committed: boolean, reason?: string, metadata: object }>}
   */
  const mutateSessionMetadata = async (sessionID, decide, options = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (typeof decide !== 'function') throw new Error('a decide function is required to mutate session metadata');

    return runExclusive(async () => {
      await ensureReadable();

      const previous = entries.get(id);
      const current = previous ?? {};
      const decision = decide(current);
      if (!decision || decision.ok !== true) {
        return {
          committed: false,
          reason: typeof decision?.reason === 'string' && decision.reason
            ? decision.reason
            : 'rejected',
          metadata: current,
        };
      }
      if (!isPlainObject(decision.patch)) {
        throw new Error('a successful mutate decision must include an object patch');
      }

      const merged = await commitMergedPatch(id, previous, decision.patch, options);
      return { committed: true, metadata: merged };
    });
  };

  /**
   * Drop a session's metadata.
   * @returns {Promise<boolean>} true if a row was removed; false if already absent
   *   (idempotent). Disk/write failures **throw** so callers can retry — never
   *   conflate not-found with write failure.
   */
  const removeSession = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return false;

    return runExclusive(async () => {
      await ensureReadable();
      if (!entries.has(id)) return false;

      const nextMap = new Map(entries);
      nextMap.delete(id);
      // Write failures propagate — do not report as "already gone".
      await persistMap(nextMap);
      entries.delete(id);
      return true;
    });
  };

  const getAll = async () => {
    await ensureReadable();
    return snapshot();
  };

  /**
   * Synchronous committed snapshot for event hot paths.
   * Returns `null` when not successfully loaded (unknown — never empty).
   */
  const getSnapshotSync = () => (loaded && writable ? snapshot() : null);

  return {
    load,
    get,
    getAll,
    list: getAll,
    getSnapshotSync,
    isLoaded: () => loaded && writable,
    getLoadFailureReason: () => loadFailureReason,
    has,
    setSessionMetadata,
    mutateSessionMetadata,
    removeSession,
    filePath,
  };
};
