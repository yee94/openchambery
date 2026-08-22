/**
 * OpenChamber-owned session Changes helpers (L2 file list / L3 single-file patch).
 *
 * Parity with packages/web/server/lib/session-turn-pages/changes.service.js:
 * L2 (no `file`): project summary.diffs to `{ files: [...] }` — never patch bodies.
 * L3 (with `file`): exact file match from official session.diff list → `{ diff }`.
 */

type Loose = Record<string, unknown>;

export type SessionTurnChangeFileSummary = {
  file: string;
  status?: string;
  additions: number;
  deletions: number;
};

/**
 * Project a raw summary.diffs entry to L2 file-list scalars.
 */
export const projectChangeFileEntry = (entry: unknown): SessionTurnChangeFileSummary | null => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Loose;
  const file = typeof record.file === 'string' ? record.file : null;
  if (!file || file.length === 0) {
    return null;
  }

  const out: SessionTurnChangeFileSummary = {
    file,
    additions: typeof record.additions === 'number' && Number.isFinite(record.additions)
      ? record.additions
      : 0,
    deletions: typeof record.deletions === 'number' && Number.isFinite(record.deletions)
      ? record.deletions
      : 0,
  };
  if (typeof record.status === 'string') {
    out.status = record.status;
  }
  return out;
};

/**
 * Extract L2 file list from a session.message response shape.
 * Accepts `{ info, parts }`, `{ data: { info, parts } }`, or bare info.
 */
export const projectChangeFileList = (messagePayload: unknown): { files: SessionTurnChangeFileSummary[] } => {
  const record = messagePayload && typeof messagePayload === 'object' && !Array.isArray(messagePayload)
    ? messagePayload as Loose
    : null;
  const info = record?.info && typeof record.info === 'object' && !Array.isArray(record.info)
    ? record.info as Loose
    : (record?.summary ? record : null);
  const summary = info?.summary && typeof info.summary === 'object' && !Array.isArray(info.summary)
    ? info.summary as Loose
    : null;
  const diffs = Array.isArray(summary?.diffs) ? summary.diffs as unknown[] : [];

  const files: SessionTurnChangeFileSummary[] = [];
  for (const entry of diffs) {
    const projected = projectChangeFileEntry(entry);
    if (projected) files.push(projected);
  }
  return { files };
};

/**
 * Find exact file match in a session.diff array.
 */
export const findChangeFileDiff = (diffs: unknown, file: string): unknown | null => {
  if (!Array.isArray(diffs) || typeof file !== 'string') {
    return null;
  }
  for (const entry of diffs) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as Loose).file === file) {
      return entry;
    }
  }
  return null;
};

export type SessionChangesLoadInput = {
  sessionID: string;
  messageID: string;
  directory?: string;
  file?: string;
  signal?: AbortSignal;
};

export type SessionChangesLoadResult =
  | { ok: true; body: { files: SessionTurnChangeFileSummary[] } | { diff: unknown } }
  | { ok: false; error: string };

/**
 * @param deps.fetchMessage - official legacy GET `/session/:id/message/:messageID`
 * @param deps.fetchDiff - official GET `/session/:id/diff?messageID=`
 */
export const createSessionChangesService = ({
  fetchMessage,
  fetchDiff,
}: {
  fetchMessage: (args: {
    sessionID: string;
    messageID: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  fetchDiff: (args: {
    sessionID: string;
    messageID: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
}) => {
  if (typeof fetchMessage !== 'function' || typeof fetchDiff !== 'function') {
    throw new Error('createSessionChangesService requires fetchMessage and fetchDiff');
  }

  const loadChanges = async (input: SessionChangesLoadInput): Promise<SessionChangesLoadResult> => {
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
        return { ok: false, error: 'upstream' };
      }
      const match = findChangeFileDiff(diffs, file);
      if (!match) {
        return { ok: false, error: 'change_not_found' };
      }
      return { ok: true, body: { diff: match } };
    } catch (error) {
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
        return { ok: false, error: 'aborted' };
      }
      if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
        const code = (error as { code: string }).code;
        if (code.length > 0) return { ok: false, error: code };
      }
      return { ok: false, error: 'upstream' };
    }
  };

  return { loadChanges };
};
