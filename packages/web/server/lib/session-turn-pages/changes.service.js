/**
 * OpenChamber-owned session Changes API (L2 file list / L3 single-file patch).
 *
 * L2 (no `file`): read official `session.message`, project summary.diffs to
 *   `{ files: [{ file, status?, additions, deletions }] }` — never patch bodies
 *   or the full message envelope.
 * L3 (with `file`): call official `session.diff({ sessionID, messageID })`,
 *   return `{ diff: SnapshotFileDiff }` for the exact file string match.
 *
 * Dependency-injected for unit tests (`fetchMessage`, `fetchDiff`).
 */

/**
 * Project a raw summary.diffs entry to L2 file-list scalars.
 * @param {unknown} entry
 * @returns {{ file: string, status?: string, additions: number, deletions: number } | null}
 */
export const projectChangeFileEntry = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const file = typeof entry.file === 'string' ? entry.file : null;
  if (!file || file.length === 0) {
    return null;
  }

  /** Built from allowlist only — patch/before/after/from/to never copied. */
  const out = { file };
  if (typeof entry.status === 'string') {
    out.status = entry.status;
  }
  out.additions = typeof entry.additions === 'number' && Number.isFinite(entry.additions)
    ? entry.additions
    : 0;
  out.deletions = typeof entry.deletions === 'number' && Number.isFinite(entry.deletions)
    ? entry.deletions
    : 0;
  return out;
};

/**
 * Extract L2 file list from a session.message response shape.
 * Accepts `{ info, parts }`, `{ data: { info, parts } }`, or bare info.
 * @param {unknown} messagePayload
 * @returns {{ files: Array<{ file: string, status?: string, additions: number, deletions: number }> }}
 */
export const projectChangeFileList = (messagePayload) => {
  const record = messagePayload && typeof messagePayload === 'object' && !Array.isArray(messagePayload)
    ? messagePayload
    : null;
  const info = record?.info && typeof record.info === 'object' && !Array.isArray(record.info)
    ? record.info
    : (record?.summary ? record : null);
  const summary = info?.summary && typeof info.summary === 'object' && !Array.isArray(info.summary)
    ? info.summary
    : null;
  const diffs = Array.isArray(summary?.diffs) ? summary.diffs : [];

  const files = [];
  for (const entry of diffs) {
    const projected = projectChangeFileEntry(entry);
    if (projected) files.push(projected);
  }
  return { files };
};

/**
 * Find exact file match in a session.diff array.
 * @param {unknown} diffs
 * @param {string} file
 * @returns {unknown | null}
 */
export const findChangeFileDiff = (diffs, file) => {
  if (!Array.isArray(diffs) || typeof file !== 'string') {
    return null;
  }
  for (const entry of diffs) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.file === file) {
      return entry;
    }
  }
  return null;
};

/**
 * @param {{
 *   fetchMessage: (args: { sessionID: string, messageID: string, directory?: string, signal?: AbortSignal }) => Promise<unknown>,
 *   fetchDiff: (args: { sessionID: string, messageID: string, directory?: string, signal?: AbortSignal }) => Promise<unknown>,
 *   logger?: { warn?: Function },
 * }} deps
 */
export const createSessionChangesService = (deps) => {
  const {
    fetchMessage,
    fetchDiff,
    logger = console,
  } = deps;

  if (typeof fetchMessage !== 'function' || typeof fetchDiff !== 'function') {
    throw new Error('createSessionChangesService requires fetchMessage and fetchDiff');
  }

  /**
   * @param {{
   *   sessionID: string,
   *   messageID: string,
   *   directory?: string,
   *   file?: string,
   *   signal?: AbortSignal,
   * }} input
   */
  const loadChanges = async (input) => {
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    const messageID = typeof input?.messageID === 'string' ? input.messageID : '';
    const directory = typeof input?.directory === 'string' && input.directory.length > 0
      ? input.directory
      : undefined;
    const file = typeof input?.file === 'string' && input.file.length > 0
      ? input.file
      : undefined;
    const signal = input?.signal;

    if (!sessionID || !messageID) {
      return { ok: false, error: 'invalid_params' };
    }

    try {
      if (!file) {
        const payload = await fetchMessage({ sessionID, messageID, directory, signal });
        return { ok: true, body: projectChangeFileList(payload) };
      }

      const diffs = await fetchDiff({ sessionID, messageID, directory, signal });
      if (!Array.isArray(diffs)) {
        logger?.warn?.('[session-changes] session.diff malformed payload');
        return { ok: false, error: 'upstream' };
      }
      const match = findChangeFileDiff(diffs, file);
      if (!match) {
        return { ok: false, error: 'change_not_found' };
      }
      return { ok: true, body: { diff: match } };
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'aborted') {
        return { ok: false, error: 'aborted' };
      }
      if (typeof error?.code === 'string' && error.code.length > 0) {
        return { ok: false, error: error.code };
      }
      logger?.warn?.('[session-changes] upstream failure');
      return { ok: false, error: 'upstream' };
    }
  };

  return { loadChanges };
};
