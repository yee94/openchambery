import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { isMessageSnapshotOpen, isSlimPart } from "./displayParts"
import {
  DEFAULT_SESSION_MERGE_STRATEGY,
  shouldPreserveStreamingParts,
  type OptimisticPartProtection,
  type SessionMergeStrategy,
} from "./session-merge-strategy"
import {
  compareTranscriptSortKey,
  transcriptSortKeyOf,
} from "./transcript-durable-store"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const STREAMING_PART_FIELDS = ["text", "output"] as const

/** Tool status rank: higher means further along the lifecycle. */
const TOOL_STATUS_RANK: Record<string, number> = {
  pending: 1,
  started: 2,
  running: 3,
  completed: 4,
  error: 4,
}

export type MaterializedMessageRecord = {
  info: Message
  parts: Part[]
}

export type MaterializedState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

export type MaterializeSessionSnapshotsOptions = {
  skipPartTypes?: ReadonlySet<string>
  /** Resolved by `resolveSessionMergeStrategy`; defaults to `initial` semantics. */
  merge?: SessionMergeStrategy
  /**
   * Where to put snapshot IDs that share no neighbor with the live transcript.
   * Prepend uses `"prepend"` so older history stays in front; idle/queue
   * materialize uses `"append"` so a just-sent user turn stays at the tail.
   * Reconcile continuation windows use `"by-created"` so older-than-head Host
   * pages insert by (`time.created`, id) instead of appending past newer gap
   * records already merged from a previous page.
   */
  placeUnanchoredNewMessages?: "append" | "prepend" | "by-created"
}

export type MaterializeSessionSnapshotsResult = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  messagesChanged: boolean
  partsChanged: boolean
}

export type SessionMaterializationStatus = {
  hasMessages: boolean
  renderable: boolean
  missingPartMessageIDs: string[]
}

/**
 * Transcript projection for materialization status (Ticket 09 batch 1A).
 * Prefer repository TranscriptData over child-store message/part maps.
 * - `messages === undefined` means the session has never been loaded.
 * - An explicit empty `messages` array is a loaded-empty snapshot.
 * - Missing `parts[id]` means parts were never fetched; `[]` is fetched-empty.
 */
export type SessionMaterializationProjection = {
  messages: readonly Message[] | undefined
  parts: Readonly<Record<string, readonly Part[] | undefined>>
}

function sortParts(parts: Part[], skipPartTypes: ReadonlySet<string>) {
  return parts
    .filter((part) => !!part?.id && !skipPartTypes.has(part.type))
    .sort((a, b) => cmp(a.id, b.id))
}

function haveEquivalentPartSnapshots(left: Part[] | undefined, right: Part[]): boolean {
  // `undefined` means "parts never fetched", which is NOT equivalent to a
  // fetched-empty snapshot — the empty array must be committed so
  // getSessionMaterializationStatus can tell the two apart.
  if (!left) return false
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (!leftPart || !rightPart) return false
    if (leftPart.id !== rightPart.id) return false
    if (JSON.stringify(leftPart) !== JSON.stringify(rightPart)) return false
  }

  return true
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getStringField(part: Part, field: "text" | "output"): string | undefined {
  const value = (part as Record<string, unknown>)[field]
  return typeof value === "string" ? value : undefined
}

function hasLiveStreamingField(part: Part): boolean {
  if (getPartEndTime(part) !== undefined) return false
  return STREAMING_PART_FIELDS.some((field) => {
    const value = getStringField(part, field)
    return typeof value === "string" && value.length > 0
  })
}

function getPartState(part: Part): Record<string, unknown> | undefined {
  const state = (part as { state?: unknown }).state
  if (!state || typeof state !== "object") return undefined
  return state as Record<string, unknown>
}

function getToolStatus(part: Part): string | undefined {
  const status = getPartState(part)?.status
  return typeof status === "string" ? status : undefined
}

function toolStatusRank(status: string | undefined): number {
  if (!status) return 0
  return TOOL_STATUS_RANK[status] ?? 0
}

/**
 * Whether a local part omitted by the HTTP snapshot must be kept.
 *
 * Text/output streaming fields are always kept (existing contract). Tool and
 * other parts lack those top-level fields: an open (no end time) part is kept
 * whenever preserve-streaming is on, and settled tools are kept while the
 * snapshot message is still open so mid-turn lag cannot blank the Activity
 * timeline.
 */
function shouldPreserveMissingPart(part: Part, messageStillOpen: boolean): boolean {
  if (hasLiveStreamingField(part)) return true
  if (getPartEndTime(part) === undefined) {
    // In-flight tool/reasoning/etc. (no end). Completed tools usually carry
    // end; if status says settled without end, fall through to message-open.
    if (part.type === "tool") {
      const status = getToolStatus(part)
      if (status === "completed" || status === "error") {
        return messageStillOpen
      }
      return true
    }
    return true
  }
  // Settled local parts (completed tools, closed reasoning): keep them only
  // while the snapshot message is still open — a lagging mid-turn page must
  // not erase earlier tools; a completed message snapshot is authoritative.
  return messageStillOpen
}

function getPartStateTime(part: Part): { start?: number; end?: number } | undefined {
  const stateTime = (part as { state?: { time?: { start?: unknown; end?: unknown } } }).state?.time
  if (!stateTime || typeof stateTime !== "object") return undefined
  const start = typeof stateTime.start === "number" ? stateTime.start : undefined
  const end = typeof stateTime.end === "number" ? stateTime.end : undefined
  if (start === undefined && end === undefined) return undefined
  return { start, end }
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0
}

function mergeOpenToolState(existing: Part, next: Part, base: Part): Part {
  if (existing.type !== "tool" || next.type !== "tool") return base

  const existingState = getPartState(existing)
  if (!existingState) return base

  // Start from `base` (already may include preserved state.time) rather than
  // raw `next`, so status/input upgrades do not drop earlier merges.
  const baseState = getPartState(base) ?? {}
  const nextState = getPartState(next) ?? {}
  let state = { ...baseState }
  let changed = false

  const existingStatus = getToolStatus(existing)
  const nextStatus = getToolStatus(next)
  if (toolStatusRank(existingStatus) > toolStatusRank(nextStatus) && existingStatus) {
    state = { ...state, status: existingStatus }
    changed = true
  }

  const existingInput = existingState.input
  const nextInput = nextState.input
  if (isNonEmptyObject(existingInput) && !isNonEmptyObject(nextInput)) {
    state = { ...state, input: existingInput }
    changed = true
  }

  const existingOutput = existingState.output
  const nextOutput = nextState.output
  if (typeof existingOutput === "string" && existingOutput.length > 0) {
    if (typeof nextOutput !== "string" || nextOutput.length < existingOutput.length) {
      if (typeof nextOutput !== "string" || nextOutput.length === 0 || existingOutput.startsWith(nextOutput)) {
        state = { ...state, output: existingOutput }
        changed = true
      }
    }
  } else if (existingOutput !== undefined && nextOutput === undefined) {
    state = { ...state, output: existingOutput }
    changed = true
  }

  const existingMeta = existingState.metadata
  if (isNonEmptyObject(existingMeta) && !isNonEmptyObject(nextState.metadata)) {
    state = { ...state, metadata: existingMeta }
    changed = true
  }

  if (!changed) return base
  if (base === next) {
    return { ...next, state } as Part
  }
  return { ...base, state } as Part
}

function mergeMaterializedPart(existing: Part | undefined, next: Part): Part {
  if (!existing || getPartEndTime(next) !== undefined) return next

  let merged: Part = next
  for (const field of STREAMING_PART_FIELDS) {
    const existingValue = getStringField(existing, field)
    if (!existingValue) continue

    const nextValue = getStringField(next, field)
    if (typeof nextValue === "string" && nextValue.length >= existingValue.length) continue
    if (typeof nextValue === "string" && nextValue.length > 0 && !existingValue.startsWith(nextValue)) continue

    if (merged === next) merged = { ...next }
    const mergedRecord = merged as Record<string, unknown>
    mergedRecord[field] = existingValue
  }

  const existingTime = getPartStateTime(existing)
  if (existingTime) {
    const nextTime = getPartStateTime(next)
    const preservedStart = nextTime?.start ?? existingTime.start
    const preservedEnd = nextTime?.end ?? existingTime.end
    if (preservedStart !== nextTime?.start || preservedEnd !== nextTime?.end) {
      if (merged === next) merged = { ...next }
      const mergedRecord = merged as Record<string, unknown>
      const nextState = (merged as Record<string, unknown>).state as Record<string, unknown> | undefined
      const newState = { ...(nextState ?? {}), time: { start: preservedStart, end: preservedEnd } }
      mergedRecord.state = newState
    }
  }

  // Laggy snapshots can re-admit a tool as pending/shell without input while
  // SSE already advanced status/input/output. Keep the richer live state.
  merged = mergeOpenToolState(existing, next, merged)

  return merged
}

/**
 * Same-id incoming slim never replaces a full part already in the model.
 *
 * This is the QueryCache/store rule, not a render hold: initial HTTP,
 * materialize, recovery, and durable-seed collisions all pass through here.
 * Full snapshots still overlay slim. Authoritative deletes stay on
 * `message.part.removed` / `remove-message`.
 */
function preferExistingFullOverIncomingSlim(
  existing: Part[] | undefined,
  incoming: Part[],
): Part[] {
  if (!existing || existing.length === 0) return incoming
  if (!incoming.some((part) => isSlimPart(part))) return incoming

  const fullById = new Map<string, Part>()
  for (const part of existing) {
    if (part.id && !isSlimPart(part)) fullById.set(part.id, part)
  }
  if (fullById.size === 0) return incoming

  let upgraded = false
  const resolved = incoming.map((part) => {
    if (!isSlimPart(part) || !part.id) return part
    const full = fullById.get(part.id)
    if (!full) return part
    upgraded = true
    return full
  })
  return upgraded ? resolved : incoming
}

function isUnconfirmedOptimisticPart(part: Part): boolean {
  return (part as { __openchamberOptimistic?: unknown }).__openchamberOptimistic === true
}

function hasUnconfirmedOptimisticPart(parts: readonly Part[] | undefined): boolean {
  return Boolean(parts && parts.length > 0 && parts.some(isUnconfirmedOptimisticPart))
}

function incomingPartsAreSlimOrEmpty(parts: readonly Part[]): boolean {
  return parts.length === 0 || parts.some((part) => isSlimPart(part))
}

function mergeMaterializedParts(
  existing: Part[] | undefined,
  nextParts: Part[],
  skipPartTypes: ReadonlySet<string>,
  preserveLiveStreamingParts: boolean,
  messageStillOpen: boolean,
  protectOptimistic: OptimisticPartProtection,
): Part[] {
  // Reconcile-page only: a slim/empty Host copy must not replace an
  // unconfirmed optimistic set. Same-id full-over-slim cannot help when the
  // server copy uses a different part id. Full incoming still replaces.
  if (
    protectOptimistic === "keep-unless-full"
    && existing
    && hasUnconfirmedOptimisticPart(existing)
    && incomingPartsAreSlimOrEmpty(nextParts)
  ) {
    return existing
  }

  const incoming = preferExistingFullOverIncomingSlim(existing, nextParts)
  if (!existing || existing.length === 0) return incoming
  if (!preserveLiveStreamingParts) return incoming

  const existingByID = new Map(existing.map((part) => [part.id, part]))
  let mergedParts = incoming
  let changed = false

  for (let index = 0; index < incoming.length; index += 1) {
    const nextPart = incoming[index]
    const mergedPart = mergeMaterializedPart(existingByID.get(nextPart.id), nextPart)
    if (mergedPart === nextPart) continue
    if (!changed) mergedParts = [...incoming]
    mergedParts[index] = mergedPart
    changed = true
  }

  const snapshotIDs = new Set(incoming.map((part) => part.id))
  const missingLiveParts = existing.filter(
    (part) =>
      !!part?.id
      && !snapshotIDs.has(part.id)
      && !skipPartTypes.has(part.type)
      && shouldPreserveMissingPart(part, messageStillOpen),
  )
  if (missingLiveParts.length === 0) return mergedParts

  return [...mergedParts, ...missingLiveParts].sort((a, b) => cmp(a.id, b.id))
}

type MessageTerminalFields = {
  finish?: unknown
  error?: unknown
  time?: { created?: unknown; completed?: unknown }
}

const readTerminalFields = (message: Message): MessageTerminalFields => message as MessageTerminalFields

const hasNonEmptyFinish = (message: Message): boolean => {
  const finish = readTerminalFields(message).finish
  return typeof finish === "string" && finish.length > 0
}

const hasCompletedTime = (message: Message): boolean => (
  typeof readTerminalFields(message).time?.completed === "number"
)

const hasError = (message: Message): boolean => Boolean(readTerminalFields(message).error)

/**
 * Copy terminal settle fields the live object is still missing.
 * Insert-only must not replace live messages (a lagging snapshot would clobber
 * the last turn), but Activity auto-collapse needs `finish` / `time.completed`
 * / `error` when SSE omitted them and the HTTP snapshot has them.
 * Live terminal fields are never cleared or overwritten.
 */
function fillMissingTerminalMessageFields(live: Message, snapshot: Message): Message {
  const snapshotFields = readTerminalFields(snapshot)
  const snapshotFinish = snapshotFields.finish
  const snapshotCompleted = snapshotFields.time?.completed
  const snapshotError = snapshotFields.error

  const takeFinish = !hasNonEmptyFinish(live)
    && typeof snapshotFinish === "string"
    && snapshotFinish.length > 0
  const takeCompleted = !hasCompletedTime(live) && typeof snapshotCompleted === "number"
  const takeError = !hasError(live) && Boolean(snapshotError)

  if (!takeFinish && !takeCompleted && !takeError) {
    return live
  }

  const next: MessageTerminalFields = { ...live }
  if (takeFinish) {
    next.finish = snapshotFinish
  }
  if (takeCompleted) {
    next.time = { ...readTerminalFields(live).time, completed: snapshotCompleted }
  }
  if (takeError) {
    next.error = snapshotError
  }
  return next as Message
}

/**
 * Fold snapshot rows into live conversation order.
 * Known IDs stay where they are. New IDs insert after the previous snapshot
 * neighbor already in the live list. A snapshot that shares no IDs uses
 * `unanchored` (prepend older history, append idle/queue tail, or insert by
 * Host `time.created` for reconcile continuation pages).
 */
function mergeMessagesInConversationOrder(
  existing: Message[],
  snapshots: Message[],
  resolveExisting: (live: Message, snapshot: Message | undefined) => Message,
  unanchored: "append" | "prepend" | "by-created",
): Message[] {
  if (snapshots.length === 0) return existing
  const snapshotByID = new Map(snapshots.map((message) => [message.id, message]))
  let changed = false
  const merged: Message[] = []
  for (const message of existing) {
    const next = resolveExisting(message, snapshotByID.get(message.id))
    if (next !== message) changed = true
    merged.push(next)
  }
  const existingIDs = new Set(existing.map((message) => message.id))
  const newcomers = snapshots.filter((message) => !existingIDs.has(message.id))
  if (newcomers.length === 0) return changed ? merged : existing

  const anchored = snapshots.some((message) => existingIDs.has(message.id))
  if (!anchored) {
    if (unanchored === "prepend") return [...newcomers, ...merged]
    if (unanchored === "by-created") return insertMessagesByCreated(merged, newcomers)
    return [...merged, ...newcomers]
  }

  let lastPlacedIndex = -1
  for (const snapshot of snapshots) {
    const index = merged.findIndex((message) => message.id === snapshot.id)
    if (index >= 0) {
      lastPlacedIndex = index
      continue
    }
    lastPlacedIndex += 1
    merged.splice(lastPlacedIndex, 0, snapshot)
  }
  return merged
}

/**
 * Insert-only merge that still fills missing terminal settle fields.
 * New snapshot IDs keep conversation position; existing IDs keep the live
 * object unless the snapshot supplies `finish`, `time.completed`, or `error`
 * the live row lacks.
 */
function insertMessagesByCreated(existing: Message[], newcomers: Message[]): Message[] {
  const next = existing.slice()
  for (const snapshot of newcomers) {
    const key = transcriptSortKeyOf(snapshot)
    let insertAt = next.length
    for (let index = 0; index < next.length; index += 1) {
      if (compareTranscriptSortKey(key, transcriptSortKeyOf(next[index]!)) < 0) {
        insertAt = index
        break
      }
    }
    next.splice(insertAt, 0, snapshot)
  }
  return next
}

function mergeInsertOnlyMessages(
  existing: Message[],
  snapshots: Message[],
  unanchored: "append" | "prepend" | "by-created",
): Message[] {
  return mergeMessagesInConversationOrder(
    existing,
    snapshots,
    (live, snapshot) => (snapshot ? fillMissingTerminalMessageFields(live, snapshot) : live),
    unanchored,
  )
}

/**
 * `upsert` semantics: fetched snapshots replace their existing counterparts and
 * unseen snapshots keep conversation position. Contrast with `mergeMessages`,
 * which is insert-only and therefore never refreshes a message the store
 * already holds.
 */
function upsertMessages(
  existing: Message[],
  snapshots: Message[],
  unanchored: "append" | "prepend" | "by-created",
): Message[] {
  return mergeMessagesInConversationOrder(
    existing,
    snapshots,
    (live, snapshot) => {
      if (!snapshot) return live
      return JSON.stringify(live) === JSON.stringify(snapshot) ? live : snapshot
    },
    unanchored,
  )
}

export function materializeSessionSnapshots(
  state: MaterializedState,
  sessionID: string,
  records: MaterializedMessageRecord[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const merge = options.merge ?? DEFAULT_SESSION_MERGE_STRATEGY
  const unanchored = options.placeUnanchoredNewMessages ?? "append"
  // Keep page/conversation order. Message ids are identity only — sorting here
  // used to hide a just-sent user turn in the middle of the transcript.
  const snapshots = records.filter((record) => !!record?.info?.id)
  const nextMessages = snapshots.map((record) => record.info)
  const existingMessages = state.message[sessionID]
  const currentMessages = existingMessages ?? []
  const messages = merge.messages === "upsert"
    ? upsertMessages(currentMessages, nextMessages, unanchored)
    : mergeInsertOnlyMessages(currentMessages, nextMessages, unanchored)
  const messagesChanged = messages !== currentMessages || (existingMessages === undefined && snapshots.length === 0)

  let partsChanged = false
  const nextPartState = { ...state.part }
  const skipMaterializedParts = merge.parts === "skip-existing"

  for (const record of snapshots) {
    const messageID = record.info.id
    if (skipMaterializedParts && nextPartState[messageID]) continue

    const isAssistant = record.info.role === "assistant"
    const existing = nextPartState[messageID]
    const nextParts = mergeMaterializedParts(
      existing,
      sortParts(record.parts ?? [], skipPartTypes),
      skipPartTypes,
      shouldPreserveStreamingParts(merge, record.info.role),
      isMessageSnapshotOpen(record.info),
      merge.protectOptimistic,
    )
    // User/system rows: an empty HTTP snapshot is not proof the server cleared
    // parts. Idle/materialize/initial turn pages can lag SSE and return a shell
    // with [] (or id-filtered-empty). Deleting here wipes the bubble —
    // ChatMessage hides user rows when displayParts is empty. Keep local parts
    // until a non-empty snapshot arrives. First paint with no local parts still
    // leaves the key absent (not an explicit []).
    //
    // Assistant rows still store fetched-empty as [] so
    // getSessionMaterializationStatus treats aborted turns as renderable.
    const equivalent = existing
      ? haveEquivalentPartSnapshots(existing, nextParts)
      : nextParts.length === 0 && !isAssistant
    if (equivalent) continue

    if (nextParts.length === 0 && !isAssistant) {
      // Keep non-empty local parts; leave absence as absence. Never invent [].
      continue
    }

    // Store fetched-empty as an explicit [] (not absence): an assistant
    // message the server returned with zero parts (e.g. aborted before any
    // output) is authoritatively empty and must count as renderable, or
    // the ensure-renderable effects retry syncSession forever.
    nextPartState[messageID] = nextParts
    partsChanged = true
  }

  return {
    message: messagesChanged ? { ...state.message, [sessionID]: messages } : state.message,
    part: partsChanged ? nextPartState : state.part,
    messages,
    messagesChanged,
    partsChanged,
  }
}

function isOpenAssistantMessage(message: Message): boolean {
  const completed = (message as { time?: { completed?: unknown } }).time?.completed
  if (typeof completed === "number") return false
  const finish = (message as { finish?: unknown }).finish
  if (typeof finish === "string" && finish.length > 0) return false
  return true
}

/**
 * Compute renderability from a flat transcript projection (repository or store).
 */
export function getSessionMaterializationStatusFromProjection(
  projection: SessionMaterializationProjection,
): SessionMaterializationStatus {
  const messages = projection.messages
  if (!messages) {
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }

  const trailingID = messages.length > 0 ? messages[messages.length - 1]?.id : undefined
  const missingPartMessageIDs: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    // `undefined` = parts never fetched (not renderable yet). An explicit []
    // is a fetched-empty snapshot (e.g. aborted assistant turn) and counts
    // as renderable — otherwise sessions containing such a message can never
    // reach renderable state and ensure-renderable callers loop forever.
    const parts = projection.parts[message.id]
    if (parts) continue

    // Live multi-step turns emit message.updated for a new trailing assistant
    // before the first part.updated. Counting that gap as "missing parts"
    // flips hasRenderableSessionSnapshot false and re-fires
    // ensureSessionRenderable → thrashing GET /messages mid-turn (trace:
    // 5+ messages pulls within ~4s of one prompt), which blanks Activity tools.
    if (message.id === trailingID && isOpenAssistantMessage(message)) {
      continue
    }
    missingPartMessageIDs.push(message.id)
  }

  return {
    hasMessages: true,
    renderable: missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}

/**
 * Materialization status from either:
 * - MaterializedState + sessionID (store / materializeSessionSnapshots result)
 * - SessionMaterializationProjection (repository TranscriptData projection)
 */
export function getSessionMaterializationStatus(
  state: MaterializedState,
  sessionID: string,
): SessionMaterializationStatus
export function getSessionMaterializationStatus(
  projection: SessionMaterializationProjection,
): SessionMaterializationStatus
export function getSessionMaterializationStatus(
  stateOrProjection: MaterializedState | SessionMaterializationProjection,
  sessionID?: string,
): SessionMaterializationStatus {
  if (typeof sessionID === "string") {
    const state = stateOrProjection as MaterializedState
    return getSessionMaterializationStatusFromProjection({
      messages: state.message[sessionID],
      parts: state.part,
    })
  }
  return getSessionMaterializationStatusFromProjection(
    stateOrProjection as SessionMaterializationProjection,
  )
}