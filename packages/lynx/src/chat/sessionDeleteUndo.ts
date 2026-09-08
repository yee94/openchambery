/**
 * Cap `scheduleSessionDeletes` / `deleteSessionsWithUndo` spirit for Lynx.
 * Portable schedule + undo banner — no Cap sonner/toast lib.
 */
export const SESSION_DELETE_UNDO_MS = 10_000;

export type LynxSessionDeleteTarget = {
  sessionId: string;
  directory: string | null;
};

export type LynxDeleteUndoBanner = {
  batchId: string;
  sessionIds: string[];
  expiresAt: number;
};

type PendingDeleteBatch = {
  entries: LynxSessionDeleteTarget[];
  timer: ReturnType<typeof setTimeout>;
  onCommit: (entries: LynxSessionDeleteTarget[]) => void | Promise<void>;
};

const pendingDeleteBatches = new Map<string, PendingDeleteBatch>();
let pendingDeleteBatchSeq = 0;

/**
 * Optimistically schedule hard deletes after `delayMs`.
 * Call `cancelLynxScheduledSessionDeletes` within the window to skip the server DELETE.
 */
export function scheduleLynxSessionDeletes(
  entries: LynxSessionDeleteTarget[],
  options: {
    delayMs?: number;
    onCommit: (entries: LynxSessionDeleteTarget[]) => void | Promise<void>;
  },
): { batchId: string; scheduledIds: string[] } {
  const unique = new Map<string, LynxSessionDeleteTarget>();
  for (const entry of entries) {
    const sessionId = entry.sessionId.trim();
    if (!sessionId) continue;
    if (unique.has(sessionId)) continue;
    unique.set(sessionId, {
      sessionId,
      directory: entry.directory?.trim() ? entry.directory.trim() : null,
    });
  }
  const scheduled = [...unique.values()];
  if (scheduled.length === 0) {
    return { batchId: '', scheduledIds: [] };
  }

  const batchId = `lynx-session-delete-${Date.now()}-${pendingDeleteBatchSeq += 1}`;
  const delayMs = options.delayMs ?? SESSION_DELETE_UNDO_MS;
  const timer = setTimeout(() => {
    void (async () => {
      const batch = pendingDeleteBatches.get(batchId);
      if (!batch) return;
      pendingDeleteBatches.delete(batchId);
      await batch.onCommit(batch.entries);
    })();
  }, delayMs);

  pendingDeleteBatches.set(batchId, {
    entries: scheduled,
    timer,
    onCommit: options.onCommit,
  });

  return { batchId, scheduledIds: scheduled.map((entry) => entry.sessionId) };
}

/** Cancel a pending delayed delete batch without hitting the server. */
export function cancelLynxScheduledSessionDeletes(batchId: string): boolean {
  if (!batchId) return false;
  const batch = pendingDeleteBatches.get(batchId);
  if (!batch) return false;
  clearTimeout(batch.timer);
  pendingDeleteBatches.delete(batchId);
  return true;
}

/** Test helper: drop pending timers without committing. */
export function clearLynxScheduledSessionDeletesForTests(): void {
  for (const batch of pendingDeleteBatches.values()) {
    clearTimeout(batch.timer);
  }
  pendingDeleteBatches.clear();
}

export const createLynxDeleteUndoBanner = (input: {
  batchId: string;
  sessionIds: string[];
  now?: number;
  durationMs?: number;
}): LynxDeleteUndoBanner => {
  const batchId = input.batchId.trim();
  const sessionIds = Array.from(new Set(input.sessionIds.map((id) => id.trim()).filter(Boolean)));
  if (!batchId || sessionIds.length === 0) {
    throw new Error('delete undo banner requires batchId and sessionIds');
  }
  const now = input.now ?? Date.now();
  const durationMs = input.durationMs ?? SESSION_DELETE_UNDO_MS;
  return {
    batchId,
    sessionIds,
    expiresAt: now + durationMs,
  };
};

export const isLynxDeleteUndoExpired = (
  banner: LynxDeleteUndoBanner | null | undefined,
  now = Date.now(),
): boolean => {
  if (!banner) return true;
  return now >= banner.expiresAt;
};

export const LYNX_SESSION_DELETE_UNDO_NOTES = [
  'Cap scheduleSessionDeletes / deleteSessionsWithUndo (~SESSION_DELETE_UNDO_MS 10s).',
  'Hard delete only after undo window; undo cancels without server DELETE.',
  'Portable banner — not Cap sonner/toast. Tree ids via collectLynxSessionTreeIds.',
  'Deferred: Cap toast lib / bulk multi-select / @dnd-kit / MobileWindowMotion / iPad.',
] as const;
