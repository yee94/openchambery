/**
 * Recent OpenCode session errors, kept in memory for diagnostics and live UI.
 *
 * OpenCode reports a failed turn as `session.execution.failed` (v2) or
 * `session.error` (legacy). The message may arrive without an assistant row, so
 * a turn can end with nothing on screen unless this buffer and the notification
 * store retain the reason. In-memory only: never persisted, never sent, dropped
 * on reload.
 */

const MAX_RECORDED_SESSION_ERRORS = 20;
const MAX_MESSAGE_LENGTH = 400;

export type OpenCodeErrorSummary = {
  name: string | null;
  message: string | null;
};

export type SessionErrorRecord = OpenCodeErrorSummary & {
  at: number;
  sessionId: string;
  directory: string | null;
};

/**
 * v2 failed turns carry `{ type, message }`. Keep both: `type` names the
 * failure class, `message` is the text worth showing. Nulls mean "no details".
 */
export function summarizeOpenCodeError(error: unknown): OpenCodeErrorSummary {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { name: null, message: null };
  }
  const record = error as { type?: unknown; name?: unknown; message?: unknown };
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const nameField = typeof record.name === "string" ? record.name.trim() : "";
  const name = type || nameField || null;
  const rawMessage = typeof record.message === "string" ? record.message.trim() : "";
  return {
    name,
    message: rawMessage ? rawMessage.slice(0, MAX_MESSAGE_LENGTH) : null,
  };
}

const records: SessionErrorRecord[] = [];

export function recordSessionError(record: Omit<SessionErrorRecord, "at">): void {
  records.push({ ...record, at: Date.now() });
  if (records.length > MAX_RECORDED_SESSION_ERRORS) {
    records.splice(0, records.length - MAX_RECORDED_SESSION_ERRORS);
  }
}

/** Newest first. */
export function getRecentSessionErrors(): SessionErrorRecord[] {
  return [...records].reverse();
}

/** Test helper: drop in-memory records between cases. */
export function clearSessionErrorLogForTests(): void {
  records.length = 0;
}
