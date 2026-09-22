/**
 * OpenChamber-owned session metadata.
 *
 * OpenCode 2.x accepts `metadata` only when a session is created; the v1
 * `PATCH /session/{id}` route is gone and nothing replaces it. Session goal
 * progress (and later assist / pinned notes) live here: one JSON file per data
 * dir, `{ [sessionID]: metadata }`, folded back onto the sessions the proxy
 * serves so clients keep reading `session.metadata` where they always did.
 *
 * Writes are a JSON Merge Patch (RFC 7386): nested objects merge key by key and
 * a `null` deletes. That is what the old PATCH did, and it is what keeps two
 * features writing into the same `openchamber` namespace from erasing each
 * other — goal mode saving progress must not drop an assist recap.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

const METADATA_FILE_NAME = 'sessions-metadata.json';

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

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createSessionMetadataStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const filePath = path.join(dataDir, METADATA_FILE_NAME);

  /** sessionID → metadata object. Authoritative once `loaded` is true. */
  const entries = new Map();
  let loaded = false;
  let loadPromise = null;
  /**
   * Writes stay disabled until one load has told us what is already on disk.
   * A failed read is not evidence that nothing is stored, and writing over a
   * file we could not read would drop exactly the state we are protecting.
   */
  let writable = false;
  let writeChain = Promise.resolve();

  const snapshot = () => Object.fromEntries(entries);

  const parseStored = (raw) => {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error('session metadata file is not a JSON object');
    }
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      // A non-object entry is not metadata; dropping it is better than handing
      // a consumer something it will read fields off.
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      // No file yet is the normal first run: nothing is stored, and writing is
      // safe because there is no state to lose.
      if (error?.code === 'ENOENT') return { ok: true, stored: new Map() };
      console.warn('[session-metadata] could not read the session metadata file:', error?.message ?? error);
      return { ok: false, stored: null };
    }

    try {
      return { ok: true, stored: parseStored(raw) };
    } catch (error) {
      // Malformed bytes are kept for the user instead of being overwritten on
      // the next write, and whatever this process already knows stays in memory
      // rather than collapsing to "no metadata".
      const backup = `${filePath}.corrupt-${now()}`;
      await fsPromises.rename(filePath, backup).catch(() => undefined);
      console.warn(
        `[session-metadata] session metadata file was unreadable and was moved to ${backup}: ${error?.message ?? error}`,
      );
      return { ok: true, stored: new Map() };
    }
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile().then((result) => {
        if (result.ok) {
          // Merge rather than replace: a write that happened while the first
          // load was still running must survive it.
          for (const [id, metadata] of result.stored) {
            if (!entries.has(id)) entries.set(id, metadata);
          }
          loaded = true;
          writable = true;
        } else {
          // Let a later call retry; until one succeeds the store answers reads
          // from memory and refuses writes.
          loadPromise = null;
        }
        return { ok: result.ok, entries: snapshot() };
      });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(snapshot());
    const write = async () => {
      await fsPromises.mkdir(dataDir, { recursive: true });
      // Temp file in the same directory so the rename is atomic on one device:
      // a reader sees either the previous file or the complete new one.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, payload, 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    };
    // Serialized so two overlapping writes cannot interleave their renames.
    const next = writeChain.then(write, write);
    writeChain = next.catch(() => undefined);
    return next;
  };

  const get = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await load();
    return entries.get(id) ?? {};
  };

  /** Whether the store holds anything for the session (an empty object counts as nothing). */
  const has = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return false;
    await load();
    return entries.has(id);
  };

  /**
   * Applies a merge patch and returns the session's full metadata afterwards.
   * A failed write rolls the memory back and throws, so a caller never believes
   * it saved something it did not.
   */
  const setSessionMetadata = async (sessionID, patch) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');

    const loadResult = await load();
    if (!loadResult.ok || !writable) {
      throw new Error('session metadata is unavailable: its file could not be read');
    }

    const had = entries.has(id);
    const previous = entries.get(id);
    const merged = mergeMetadataPatch(previous, patch);
    if (Object.keys(merged).length === 0) entries.delete(id);
    else entries.set(id, merged);

    try {
      await persist();
    } catch (error) {
      if (had) entries.set(id, previous);
      else entries.delete(id);
      throw error;
    }

    return merged;
  };

  const removeSession = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return false;
    await load();
    if (!writable || !entries.has(id)) return false;
    const previous = entries.get(id);
    entries.delete(id);
    try {
      await persist();
    } catch (error) {
      entries.set(id, previous);
      console.warn('[session-metadata] failed to drop session metadata:', error?.message ?? error);
      return false;
    }
    return true;
  };

  const getAll = async () => {
    await load();
    return snapshot();
  };

  return {
    load,
    get,
    getAll,
    list: getAll,
    isLoaded: () => loaded,
    has,
    setSessionMetadata,
    removeSession,
    filePath,
  };
};
