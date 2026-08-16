import type { Message, Part } from "@opencode-ai/sdk/v2"

import { allowsAuthoritativeShrink, isSlimPart } from "./displayParts"

/**
 * Durable transcript identity is the full runtime scope plus messageID.
 *
 * Query / repository scopes treat transport and generation as optional; this
 * store does not. A row written under generation N must not reappear after a
 * transport recycle, and directory/session alone is not enough to keep two
 * runtimes apart.
 */
export type TranscriptDurableScope = {
  readonly transport: string
  readonly generation: number
  readonly directory: string
  readonly sessionID: string
}

export type TranscriptDurableGeneration = {
  readonly transport: string
  readonly generation: number
}

/**
 * Client `Message` has no upstream `seq`. Conversation `messageOrder` is a
 * derived in-memory array, not a durable key — and messageID is identity only
 * (an earlier high-id row can precede later low-id turns).
 *
 * The durable order key is therefore (`time.created`, `messageID`), matching
 * the upstream `message_session_time_created_id_idx` scan order. Adapters must
 * sort by this pair; they must not persist or replay array indexes.
 */
export type TranscriptSortKey = {
  readonly created: number
  readonly messageID: string
}

export type TranscriptPartCompleteness = "slim" | "full"
export type TranscriptRecordCompleteness = "slim" | "full"

/**
 * One persisted message. Completeness is stamped per part via
 * `displayParts.isSlimPart`; the record-level flag is slim when any part is.
 *
 * `contentHash` / `byteSize` are derived from info+parts and exist only for
 * change detection and the byte-budget LRU. They are never the primary key.
 */
export type TranscriptDurableRecord = {
  readonly scope: TranscriptDurableScope
  readonly messageID: string
  readonly info: Message
  readonly parts: readonly Part[]
  readonly partCompleteness: readonly TranscriptPartCompleteness[]
  readonly completeness: TranscriptRecordCompleteness
  readonly contentHash: string
  readonly byteSize: number
  readonly lastAccessedAt: number
  readonly sortKey: TranscriptSortKey
}

export type TranscriptDurableSession = {
  readonly scope: TranscriptDurableScope
  readonly records: readonly TranscriptDurableRecord[]
  readonly byteSize: number
}

export type TranscriptUpsertSkipReason = "unchanged" | "not-settled" | "slim-downgrade"

export type TranscriptUpsertResult =
  | { readonly status: "written"; readonly record: TranscriptDurableRecord }
  | {
      readonly status: "skipped"
      readonly reason: TranscriptUpsertSkipReason
      readonly record?: TranscriptDurableRecord
    }

export type TranscriptEvictToBytesOptions = {
  readonly protect?: readonly TranscriptDurableScope[]
}

export type TranscriptEvictResult = {
  readonly evicted: number
  readonly freedBytes: number
  readonly remainingBytes: number
}

/**
 * Medium-agnostic settled-transcript cache. IndexedDB and SQLite adapters
 * implement this same surface; the contract suite asserts only these methods.
 */
export type TranscriptDurableStore = {
  readSession: (scope: TranscriptDurableScope) => Promise<TranscriptDurableSession>
  readMessage: (scope: TranscriptDurableScope, messageID: string) => Promise<TranscriptDurableRecord | undefined>
  upsertSettled: (scope: TranscriptDurableScope, info: Message, parts: readonly Part[]) => Promise<TranscriptUpsertResult>
  removeMessage: (scope: TranscriptDurableScope, messageID: string) => Promise<void>
  clearSession: (scope: TranscriptDurableScope) => Promise<void>
  clearGeneration: (generation: TranscriptDurableGeneration) => Promise<void>
  evictToBytes: (maxBytes: number, options?: TranscriptEvictToBytesOptions) => Promise<TranscriptEvictResult>
  /**
   * Drop every transcript row on this backend. Other app storage stays.
   * User-facing current-runtime clear uses this; `destroy` is lifecycle-only.
   */
  clearAll: () => Promise<void>
  destroy: () => Promise<void>
}

export type MemoryTranscriptDurableStoreOptions = {
  now?: () => number
}

type InternalRow = {
  scope: TranscriptDurableScope
  messageID: string
  info: Message
  parts: Part[]
  partCompleteness: TranscriptPartCompleteness[]
  completeness: TranscriptRecordCompleteness
  contentHash: string
  byteSize: number
  lastAccessedAt: number
  sortKey: TranscriptSortKey
}

const cloneValue = <T>(value: T): T => structuredClone(value)

const cloneScope = (scope: TranscriptDurableScope): TranscriptDurableScope => ({
  transport: scope.transport,
  generation: scope.generation,
  directory: scope.directory,
  sessionID: scope.sessionID,
})

/** Stable map key for the four-field scope. Generation is required, not optional. */
export function transcriptDurableScopeKey(scope: TranscriptDurableScope): string {
  return JSON.stringify([scope.transport, scope.generation, scope.directory, scope.sessionID])
}

/** Message identity is scope + messageID. Content hash is never part of this key. */
export function transcriptDurableIdentityKey(scope: TranscriptDurableScope, messageID: string): string {
  return JSON.stringify([scope.transport, scope.generation, scope.directory, scope.sessionID, messageID])
}

export function sameTranscriptDurableScope(left: TranscriptDurableScope, right: TranscriptDurableScope): boolean {
  return (
    left.transport === right.transport
    && left.generation === right.generation
    && left.directory === right.directory
    && left.sessionID === right.sessionID
  )
}

export function sameTranscriptDurableGeneration(
  scope: TranscriptDurableScope,
  generation: TranscriptDurableGeneration,
): boolean {
  return scope.transport === generation.transport && scope.generation === generation.generation
}

/** Index key for `clearGeneration`: every session under one transport+generation. */
export function transcriptDurableGenerationKey(generation: TranscriptDurableGeneration): string {
  return JSON.stringify([generation.transport, generation.generation])
}

/**
 * Compare durable order keys. Created time wins; messageID breaks ties only.
 * Callers that sort by messageID alone, or by a `messageOrder` index, violate
 * the store contract — those orders diverge on earlier high-id rows.
 */
export function compareTranscriptSortKey(left: TranscriptSortKey, right: TranscriptSortKey): number {
  if (left.created !== right.created) return left.created - right.created
  if (left.messageID < right.messageID) return -1
  if (left.messageID > right.messageID) return 1
  return 0
}

export function transcriptSortKeyOf(info: Message): TranscriptSortKey {
  const created = (info as { time?: { created?: unknown } }).time?.created
  return {
    created: typeof created === "number" && Number.isFinite(created) ? created : 0,
    messageID: info.id,
  }
}

/**
 * Persistable rows are settled assistants (`finish` or `time.completed`) and
 * every non-assistant row. Open assistant turns stay in the live merge path.
 */
export function isTranscriptSettled(info: Message): boolean {
  return allowsAuthoritativeShrink(info)
}

export function transcriptPartCompleteness(part: Part): TranscriptPartCompleteness {
  return isSlimPart(part) ? "slim" : "full"
}

export function transcriptRecordCompleteness(parts: readonly Part[]): TranscriptRecordCompleteness {
  return parts.some((part) => isSlimPart(part)) ? "slim" : "full"
}

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const record = value as Record<string, unknown>
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry === undefined) continue
    ordered[key] = canonicalize(entry)
  }
  return ordered
}

const hexDigest = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes)
  let hex = ""
  for (const byte of view) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/**
 * Stable content fingerprint. Hash is a change detector only — same identity
 * plus same hash skips the write and refreshes `lastAccessedAt`.
 */
export async function fingerprintTranscriptContent(
  info: Message,
  parts: readonly Part[],
): Promise<{ hash: string; byteSize: number }> {
  const payload = JSON.stringify(canonicalize({ info, parts }))
  const bytes = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return { hash: hexDigest(digest), byteSize: bytes.byteLength }
}

const snapshotRecord = (row: InternalRow): TranscriptDurableRecord => ({
  scope: cloneScope(row.scope),
  messageID: row.messageID,
  info: cloneValue(row.info),
  parts: cloneValue(row.parts),
  partCompleteness: row.partCompleteness.slice(),
  completeness: row.completeness,
  contentHash: row.contentHash,
  byteSize: row.byteSize,
  lastAccessedAt: row.lastAccessedAt,
  sortKey: { created: row.sortKey.created, messageID: row.sortKey.messageID },
})

const createMonotonicClock = (now: () => number): (() => number) => {
  let last = 0
  return () => {
    const value = now()
    last = value > last ? value : last + 1
    return last
  }
}

const sessionFromRows = (scope: TranscriptDurableScope, rows: InternalRow[]): TranscriptDurableSession => {
  const records = rows
    .slice()
    .sort((left, right) => compareTranscriptSortKey(left.sortKey, right.sortKey))
    .map(snapshotRecord)
  return {
    scope: cloneScope(scope),
    records,
    byteSize: records.reduce((sum, record) => sum + record.byteSize, 0),
  }
}

/**
 * Shared row / clone / clock helpers for medium adapters.
 *
 * IndexedDB and SQLite must assemble the same public record the Memory store
 * returns. These functions are the only sanctioned way to clone, stamp
 * lastAccessedAt, and rebuild a session so sort order cannot drift.
 */
export type TranscriptDurableRow = InternalRow
export const cloneTranscriptValue = <T>(value: T): T => cloneValue(value)
export const cloneTranscriptScope = (scope: TranscriptDurableScope): TranscriptDurableScope => cloneScope(scope)
export const createTranscriptMonotonicClock = (now: () => number = Date.now): (() => number) => createMonotonicClock(now)
export const snapshotTranscriptDurableRecord = (row: TranscriptDurableRow): TranscriptDurableRecord => snapshotRecord(row)
export const sessionFromTranscriptRows = (
  scope: TranscriptDurableScope,
  rows: readonly TranscriptDurableRow[],
): TranscriptDurableSession => sessionFromRows(scope, rows.slice())

/**
 * Upsert gate shared by every adapter. Hash is consulted only after settle and
 * slim-downgrade checks so a projected page never hashes its way over a full row.
 */
export function decideTranscriptUpsertSettled(input: {
  info: Message
  existing?: Pick<TranscriptDurableRow, "completeness" | "contentHash">
  incomingCompleteness: TranscriptRecordCompleteness
  incomingHash?: string
}): { status: "written" } | { status: "skipped"; reason: TranscriptUpsertSkipReason } {
  if (!isTranscriptSettled(input.info)) return { status: "skipped", reason: "not-settled" }
  if (input.existing?.completeness === "full" && input.incomingCompleteness === "slim") {
    return { status: "skipped", reason: "slim-downgrade" }
  }
  if (input.incomingHash !== undefined && input.existing?.contentHash === input.incomingHash) {
    return { status: "skipped", reason: "unchanged" }
  }
  return { status: "written" }
}

/**
 * In-memory adapter used to lock the contract before IndexedDB / SQLite land.
 * It is the reference for observable behavior, not a production backing store.
 */
export function createMemoryTranscriptDurableStore(
  options: MemoryTranscriptDurableStoreOptions = {},
): TranscriptDurableStore {
  const now = createMonotonicClock(options.now ?? Date.now)
  const rows = new Map<string, InternalRow>()

  const rowsForScope = (scope: TranscriptDurableScope): InternalRow[] => {
    const key = transcriptDurableScopeKey(scope)
    const matched: InternalRow[] = []
    for (const row of rows.values()) {
      if (transcriptDurableScopeKey(row.scope) === key) matched.push(row)
    }
    return matched
  }

  const touch = (row: InternalRow): TranscriptDurableRecord => {
    row.lastAccessedAt = now()
    return snapshotRecord(row)
  }

  return {
    async readSession(scope) {
      const matched = rowsForScope(scope)
      for (const row of matched) row.lastAccessedAt = now()
      return sessionFromRows(scope, matched)
    },

    async readMessage(scope, messageID) {
      const row = rows.get(transcriptDurableIdentityKey(scope, messageID))
      if (!row) return undefined
      return touch(row)
    },

    async upsertSettled(scope, info, parts) {
      if (!isTranscriptSettled(info)) {
        return { status: "skipped", reason: "not-settled" }
      }

      const messageID = info.id
      const identity = transcriptDurableIdentityKey(scope, messageID)
      const incomingParts = cloneValue(parts.slice())
      const completeness = transcriptRecordCompleteness(incomingParts)
      const existing = rows.get(identity)

      if (existing && existing.completeness === "full" && completeness === "slim") {
        return { status: "skipped", reason: "slim-downgrade", record: snapshotRecord(existing) }
      }

      const fingerprint = await fingerprintTranscriptContent(info, incomingParts)
      if (existing && existing.contentHash === fingerprint.hash) {
        return { status: "skipped", reason: "unchanged", record: touch(existing) }
      }

      const row: InternalRow = {
        scope: cloneScope(scope),
        messageID,
        info: cloneValue(info),
        parts: incomingParts,
        partCompleteness: incomingParts.map(transcriptPartCompleteness),
        completeness,
        contentHash: fingerprint.hash,
        byteSize: fingerprint.byteSize,
        lastAccessedAt: now(),
        sortKey: transcriptSortKeyOf(info),
      }
      rows.set(identity, row)
      return { status: "written", record: snapshotRecord(row) }
    },

    async removeMessage(scope, messageID) {
      rows.delete(transcriptDurableIdentityKey(scope, messageID))
    },

    async clearSession(scope) {
      const key = transcriptDurableScopeKey(scope)
      for (const [identity, row] of rows) {
        if (transcriptDurableScopeKey(row.scope) === key) rows.delete(identity)
      }
    },

    async clearGeneration(generation) {
      for (const [identity, row] of rows) {
        if (sameTranscriptDurableGeneration(row.scope, generation)) rows.delete(identity)
      }
    },

    async evictToBytes(maxBytes, options) {
      const budget = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0
      const protectedKeys = new Set((options?.protect ?? []).map(transcriptDurableScopeKey))
      let remainingBytes = 0
      for (const row of rows.values()) remainingBytes += row.byteSize
      if (remainingBytes <= budget) {
        return { evicted: 0, freedBytes: 0, remainingBytes }
      }

      const candidates = [...rows.values()]
        .filter((row) => !protectedKeys.has(transcriptDurableScopeKey(row.scope)))
        .sort((left, right) => {
          if (left.lastAccessedAt !== right.lastAccessedAt) return left.lastAccessedAt - right.lastAccessedAt
          return compareTranscriptSortKey(left.sortKey, right.sortKey)
        })

      let evicted = 0
      let freedBytes = 0
      for (const row of candidates) {
        if (remainingBytes <= budget) break
        rows.delete(transcriptDurableIdentityKey(row.scope, row.messageID))
        remainingBytes -= row.byteSize
        freedBytes += row.byteSize
        evicted += 1
      }
      return { evicted, freedBytes, remainingBytes }
    },

    async clearAll() {
      rows.clear()
    },

    async destroy() {
      rows.clear()
    },
  }
}
