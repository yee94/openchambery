/**
 * Cap MobileSessionsSheet archive confirm + sessionMutationUndo spirit for Lynx.
 * Portable helpers only — no Cap toast lib / ArchivedSessionsDialog / bulk multi-select.
 */
export const SESSION_ARCHIVE_UNDO_MS = 10_000;

export type LynxArchiveUndoBanner = {
  sessionId: string;
  directory: string | null;
  expiresAt: number;
};

/** Cap two-step archive: first tap arms confirm, second tap on same row cancels. */
export const toggleLynxArchiveConfirm = (
  currentConfirmingId: string | null,
  sessionId: string,
): string | null => (currentConfirmingId === sessionId ? null : sessionId);

export const createLynxArchiveUndoBanner = (input: {
  sessionId: string;
  directory?: string | null;
  now?: number;
  durationMs?: number;
}): LynxArchiveUndoBanner => {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('session id required');
  const now = input.now ?? Date.now();
  const durationMs = input.durationMs ?? SESSION_ARCHIVE_UNDO_MS;
  return {
    sessionId,
    directory: input.directory?.trim() ? input.directory.trim() : null,
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
  'Deferred: Cap toast lib, bulk multi-select, ArchivedSessionsDialog, @dnd-kit.',
] as const;
