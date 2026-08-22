// ---------------------------------------------------------------------------
// Payload sanitization — strip oversized diff snapshot fields client-side.
//
// OpenCode session/message snapshots may carry large full-content diff fields
// (legacy before/after or from/to). Revert snapshots and diff text can also
// carry large file snapshots. The UI derives reverted-state behavior from the
// lightweight messageID/partID markers, so these blob fields are intentionally
// kept out of client stores.
//
// Applied at two points:
// 1. Event reducer — session.created/session.updated events
// 2. Message loading — fetchMessages response
// 3. Session list loading — list responses should not populate stores with
//    detail-only revert/diff blobs
// ---------------------------------------------------------------------------

import type { Session, Message } from "@opencode-ai/sdk/v2/client"

type DiffEntry = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  before?: string
  after?: string
  from?: string
  to?: string
  patch?: string
  [key: string]: unknown
}

/** Lightweight FileDiff fields safe for store / event hot paths (preview UI only). */
const FILE_DIFF_SUMMARY_KEYS = ["file", "status", "additions", "deletions"] as const

type SessionSummary = {
  diffs?: DiffEntry[]
  diffCount?: number
  hasDiffs?: boolean
  [key: string]: unknown
}

type SessionRevert = {
  messageID?: string
  partID?: string
  snapshot?: string
  diff?: string
  [key: string]: unknown
}

const getSessionListRevertMarker = (revert: unknown): Pick<SessionRevert, "messageID" | "partID"> | undefined => {
  if (!revert || typeof revert !== "object" || Array.isArray(revert)) {
    return undefined
  }

  const marker: Pick<SessionRevert, "messageID" | "partID"> = {}
  const record = revert as SessionRevert
  if (typeof record.messageID === "string") {
    marker.messageID = record.messageID
  }
  if (typeof record.partID === "string") {
    marker.partID = record.partID
  }

  return Object.keys(marker).length > 0 ? marker : undefined
}

const hasSessionListRevertDetails = (revert: unknown): boolean => {
  if (revert === undefined) {
    return false
  }
  if (!revert || typeof revert !== "object" || Array.isArray(revert)) {
    return true
  }

  return Object.keys(revert).some((key) => key !== "messageID" && key !== "partID")
}

const hasHeavyDiffBody = (diff: DiffEntry): boolean => {
  if (typeof diff.before === "string") return true
  if (typeof diff.after === "string") return true
  if (typeof diff.from === "string") return true
  if (typeof diff.to === "string") return true
  if (typeof diff.patch === "string") return true
  return false
}

/**
 * Reduce a FileDiff / SnapshotFileDiff to preview-safe scalars only.
 * Drops patch / before / after / from / to and any other large body fields.
 * Already-summary objects keep identity.
 */
export function summarizeFileDiff<T>(diff: T): T {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    return diff
  }

  const record = diff as DiffEntry
  if (!hasHeavyDiffBody(record)) {
    return diff
  }

  const summary: Record<string, unknown> = {}
  for (const key of FILE_DIFF_SUMMARY_KEYS) {
    if (key in record && record[key] !== undefined) {
      summary[key] = record[key]
    }
  }
  return summary as T
}

/** Summarize a FileDiff list; preserves array identity when nothing changes. */
export function summarizeFileDiffs<T>(diffs: T): T {
  if (!Array.isArray(diffs)) {
    return diffs
  }

  let changed = false
  const next = diffs.map((entry) => {
    const summarized = summarizeFileDiff(entry)
    if (summarized !== entry) {
      changed = true
    }
    return summarized
  })

  return (changed ? next : diffs) as T
}

/**
 * L1 Host-parity: replace `summary.diffs` with `diffCount` / `hasDiffs`.
 * Raw / legacy Host payloads that still carry the file array converge to the
 * same marker fields after sanitize. Identity when `diffs` is absent.
 */
export function projectSummaryDiffMarkers<T>(owner: T): T {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    return owner
  }

  const record = owner as { summary?: SessionSummary }
  const summary = record.summary
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return owner
  }

  if (!Object.prototype.hasOwnProperty.call(summary, "diffs")) {
    return owner
  }

  const diffs = summary.diffs
  const diffCount = Array.isArray(diffs) ? diffs.length : 0
  const nextSummary: SessionSummary = {
    ...summary,
    diffCount,
    hasDiffs: diffCount > 0,
  }
  delete nextSummary.diffs
  return { ...record, summary: nextSummary } as T
}

/** Strip oversized snapshot fields from summary.diffs on a session object */
export function stripSessionDiffSnapshots(session: Session): Session {
  const revert = (session as { revert?: SessionRevert }).revert

  let nextSession: Session = session
  let changed = false

  if (revert && (typeof revert.snapshot === "string" || typeof revert.diff === "string")) {
    const nextRevert = { ...revert }
    delete nextRevert.snapshot
    delete nextRevert.diff
    nextSession = { ...nextSession, revert: nextRevert } as Session
    changed = true
  }

  const projected = projectSummaryDiffMarkers(
    changed ? nextSession : session,
  ) as Session
  if (projected !== (changed ? nextSession : session)) {
    return projected
  }
  return nextSession
}

/** Strip detail-only fields from session list records before storing them. */
export function stripSessionListDetails(session: Session): Session {
  const record = session as Session & {
    summary?: SessionSummary
    revert?: unknown
    permission?: unknown
  }

  const shouldStrip = hasSessionListRevertDetails(record.revert)
    || Array.isArray(record.summary?.diffs)
    || typeof record.summary?.diffCount === "number"
    || typeof record.summary?.hasDiffs === "boolean"
    || "permission" in record

  if (!shouldStrip) {
    return session
  }

  const stripped = stripSessionDiffSnapshots(session) as typeof record
  const next: Record<string, unknown> = { ...stripped }
  delete next.permission

  const revertMarker = getSessionListRevertMarker(stripped.revert)
  if (revertMarker) {
    next.revert = revertMarker
  } else {
    delete next.revert
  }

  const summary = stripped.summary
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const summaryWithoutDiffMarkers = { ...summary }
    delete summaryWithoutDiffMarkers.diffs
    delete summaryWithoutDiffMarkers.diffCount
    delete summaryWithoutDiffMarkers.hasDiffs
    next.summary = summaryWithoutDiffMarkers
  }

  return next as unknown as Session
}

/** Strip oversized snapshot fields from summary.diffs on a message object */
export function stripMessageDiffSnapshots(message: Message): Message {
  return projectSummaryDiffMarkers(message)
}
