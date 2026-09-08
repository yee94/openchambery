/**
 * Cap MobileSessionsSheet archive confirm + sessionMutationUndo spirit for Lynx.
 * Portable helpers only — no Cap toast lib / bulk multi-select.
 */
export const SESSION_ARCHIVE_UNDO_MS = 10_000;

export type LynxArchiveUndoEntry = {
  sessionId: string;
  directory: string | null;
};

export type LynxArchiveUndoBanner = {
  /** Root + descendants successfully archived (Cap archivedIds). */
  entries: LynxArchiveUndoEntry[];
  expiresAt: number;
};

/** Cap two-step archive: first tap arms confirm, second tap on same row cancels. */
export const toggleLynxArchiveConfirm = (
  currentConfirmingId: string | null,
  sessionId: string,
): string | null => (currentConfirmingId === sessionId ? null : sessionId);

export const createLynxArchiveUndoBanner = (input: {
  /** Prefer `entries` for tree archive; single sessionId kept for callers. */
  sessionId?: string;
  directory?: string | null;
  entries?: LynxArchiveUndoEntry[];
  now?: number;
  durationMs?: number;
}): LynxArchiveUndoBanner => {
  const fromEntries = (input.entries ?? [])
    .map((entry) => ({
      sessionId: entry.sessionId.trim(),
      directory: entry.directory?.trim() ? entry.directory.trim() : null,
    }))
    .filter((entry) => entry.sessionId);
  const singleId = input.sessionId?.trim();
  const entries = fromEntries.length > 0
    ? Array.from(
      new Map(fromEntries.map((entry) => [entry.sessionId, entry])).values(),
    )
    : singleId
      ? [{
        sessionId: singleId,
        directory: input.directory?.trim() ? input.directory.trim() : null,
      }]
      : [];
  if (entries.length === 0) throw new Error('session id required');
  const now = input.now ?? Date.now();
  const durationMs = input.durationMs ?? SESSION_ARCHIVE_UNDO_MS;
  return {
    entries,
    expiresAt: now + durationMs,
  };
};

export const isLynxArchiveUndoExpired = (
  banner: LynxArchiveUndoBanner | null | undefined,
  now = Date.now(),
): boolean => {
  if (!banner) return true;
  return now >= banner.expiresAt;
};

export const LYNX_SESSION_ARCHIVE_UNDO_NOTES = [
  'Cap confirmingArchive / onRequestArchive / onConfirmArchive two-step control.',
  `Undo window mirrors Cap SESSION_DELETE_UNDO_MS (${SESSION_ARCHIVE_UNDO_MS}ms).`,
  'Undo calls unarchiveLynxSession → PATCH { time: { archived: 0 } }; never fake-success.',
  'Tree archive uses Cap collectSessionTreeIds + archivedIds/failedIds honesty.',
  'Deferred: Cap toast lib, bulk multi-select, @dnd-kit.',
] as const;
