/**
 * Pure merge for canonical session transcript InfiniteData.
 *
 * Query adapters call this from setQueryData / structuralSharing.
 * Reuses reduceSessionMessagePage (HTTP) and applyDirectoryEvent (SSE)
 * so merge strategy / live-revision semantics stay single-sourced.
 */

import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { InfiniteData } from "@tanstack/react-query"

import {
  applyTranscriptDirectoryEvent,
  type TranscriptEventDraft,
} from "./transcript-event-reducer"
import { materializeSessionSnapshots } from "./materialization"
import {
  reduceSessionMessagePage,
  type SessionMessageReducerState,
} from "./session-message-reducer"
import type {
  SessionMergeStrategy,
  SessionMessagePagePurpose,
} from "./session-merge-strategy"
import type { SessionHistoryBoundary } from "./types"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"
import {
  compareTranscriptSortKey,
  transcriptSortKeyOf,
} from "./transcript-durable-store"
import {
  isTranscriptSseEventType,
  type TranscriptCommandResult,
  type TranscriptTransportPage,
} from "./transcript-repository"

// ---------------------------------------------------------------------------
// Canonical page model
// ---------------------------------------------------------------------------

export type TranscriptPageSync = {
  readonly liveRevision: number
  readonly confirmedHeadMessageID: string | null
}

export type TranscriptPage = {
  readonly kind: "history" | "tail"
  readonly messageOrder: readonly string[]
  readonly messagesByID: Readonly<Record<string, Message>>
  readonly partsByMessageID: Readonly<Record<string, readonly Part[]>>
  readonly cursor: string | null
  readonly complete: boolean
  readonly turnCount: number
  readonly sync: TranscriptPageSync
}

export type SessionTranscriptData = InfiniteData<TranscriptPage, string | null>

export type TranscriptMergeInput =
  | {
      readonly type: "http-page"
      readonly purpose: SessionMessagePagePurpose
      readonly page: TranscriptTransportPage
      readonly capturedLiveRevision?: number
      readonly liveRevision?: number
      readonly skipPartTypes?: ReadonlySet<string>
      readonly optimistic?: readonly { message: Message; parts: Part[] }[]
    }
  | {
      readonly type: "sse-event"
      readonly event: Event
    }
  | {
      /**
       * Apply N transcript SSE events in order on one draft, then rebuild once.
       * Preserves per-event reducer order (no coalesce); empty / non-transcript
       * events are skipped without aborting the batch.
       */
      readonly type: "sse-event-batch"
      readonly events: readonly Event[]
    }
  | {
      readonly type: "optimistic-add"
      readonly message: Message
      readonly parts: readonly Part[]
    }
  | {
      readonly type: "optimistic-confirm"
      readonly messageID: string
    }
  | {
      readonly type: "optimistic-remove"
      readonly messageID: string
    }
  | {
      readonly type: "reset"
      readonly page?: TranscriptTransportPage
      readonly capturedLiveRevision?: number
      readonly liveRevision?: number
      readonly skipPartTypes?: ReadonlySet<string>
    }
  | {
      /**
       * Local continuity paint. Writes messages/parts without claiming a
       * pagination contract: complete stays false and cursor stays null so
       * `boundaryFromTranscriptData` remains `unknown`.
       */
      readonly type: "durable-seed"
      readonly records: readonly {
        readonly info: Message
        readonly parts?: readonly Part[]
      }[]
      readonly skipPartTypes?: ReadonlySet<string>
      readonly merge?: SessionMergeStrategy
    }

export type TranscriptMergeResult = {
  readonly data: SessionTranscriptData | undefined
  readonly result: TranscriptCommandResult
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const EMPTY_SYNC: TranscriptPageSync = Object.freeze({
  liveRevision: 0,
  confirmedHeadMessageID: null,
})

function emptySessionTranscriptData(): SessionTranscriptData {
  return { pages: [], pageParams: [] }
}

function freezePage(page: TranscriptPage): TranscriptPage {
  const messagesByID: Record<string, Message> = {}
  for (const [id, message] of Object.entries(page.messagesByID)) {
    messagesByID[id] = message
  }
  const partsByMessageID: Record<string, readonly Part[]> = {}
  for (const [id, parts] of Object.entries(page.partsByMessageID)) {
    // Preserve already-frozen parts arrays so structural sharing survives freeze.
    partsByMessageID[id] = Object.isFrozen(parts)
      ? parts
      : Object.freeze([...parts]) as readonly Part[]
  }
  return Object.freeze({
    kind: page.kind,
    messageOrder: Object.isFrozen(page.messageOrder)
      ? page.messageOrder
      : Object.freeze([...page.messageOrder]) as readonly string[],
    messagesByID: Object.freeze(messagesByID),
    partsByMessageID: Object.freeze(partsByMessageID),
    cursor: page.cursor,
    complete: page.complete,
    turnCount: page.turnCount,
    sync: Object.freeze({ ...page.sync }),
  })
}

export function freezeSessionTranscriptData(
  data: SessionTranscriptData,
): SessionTranscriptData {
  return {
    pages: Object.freeze(data.pages.map(freezePage)) as TranscriptPage[],
    pageParams: Object.freeze([...data.pageParams]) as (string | null)[],
  }
}

export function transportPageToTranscriptPage(
  page: TranscriptTransportPage,
  kind: "history" | "tail",
  sync: TranscriptPageSync = EMPTY_SYNC,
): TranscriptPage {
  const messageOrder: string[] = []
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  for (const record of page.records) {
    const id = record.info?.id
    if (!id || messagesByID[id]) continue
    messageOrder.push(id)
    messagesByID[id] = record.info
    if (record.parts) partsByMessageID[id] = Object.freeze([...record.parts]) as readonly Part[]
  }
  const turnCount =
    typeof page.turnCount === "number" && Number.isFinite(page.turnCount)
      ? Math.max(0, Math.floor(page.turnCount))
      : typeof page.requestedTurnLimit === "number" && Number.isFinite(page.requestedTurnLimit)
        ? Math.max(0, Math.floor(page.requestedTurnLimit))
        : page.records.length > 0
          ? 1
          : 0
  return freezePage({
    kind,
    messageOrder,
    messagesByID,
    partsByMessageID,
    cursor: page.complete ? null : (page.cursor ?? null),
    complete: page.complete,
    turnCount,
    sync,
  })
}

export function boundaryFromTranscriptData(
  data: SessionTranscriptData | undefined,
): SessionHistoryBoundary {
  if (!data || data.pages.length === 0) return UNKNOWN_SESSION_HISTORY_BOUNDARY
  const first = data.pages[0]!
  const loadedTurns = data.pages.reduce((sum, page) => sum + page.turnCount, 0)
  if (first.complete) {
    return { kind: "exhausted", loadedTurns }
  }
  if (typeof first.cursor === "string" && first.cursor.length > 0) {
    return { kind: "has-more", cursor: first.cursor, loadedTurns }
  }
  return { kind: "unknown", loadedTurns }
}

export function flattenTranscriptData(
  data: SessionTranscriptData | undefined,
  sessionID: string,
): SessionMessageReducerState {
  const message: Record<string, Message[]> = {}
  const part: Record<string, Part[]> = {}
  const messages: Message[] = []
  const seen = new Set<string>()

  for (const page of data?.pages ?? []) {
    for (const id of page.messageOrder) {
      if (seen.has(id)) continue
      const info = page.messagesByID[id]
      if (!info) continue
      seen.add(id)
      messages.push(info)
      const parts = page.partsByMessageID[id]
      if (parts) part[id] = [...parts]
    }
  }
  message[sessionID] = messages

  const boundary = boundaryFromTranscriptData(data)
  return {
    message,
    part,
    session_history_boundary:
      boundary.kind === "unknown" && boundary.loadedTurns === 0
        ? {}
        : { [sessionID]: boundary },
  }
}

function confirmedHeadMessageID(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.id) return message.id
  }
  return null
}

function pageFromMessages(
  kind: "history" | "tail",
  messages: readonly Message[],
  part: Record<string, Part[]>,
  cursor: string | null,
  complete: boolean,
  turnCount: number,
  liveRevision: number,
): TranscriptPage {
  const messageOrder: string[] = []
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  for (const message of messages) {
    if (!message?.id) continue
    messageOrder.push(message.id)
    messagesByID[message.id] = message
    const parts = part[message.id]
    if (parts) partsByMessageID[message.id] = Object.freeze([...parts]) as readonly Part[]
  }
  return freezePage({
    kind,
    messageOrder,
    messagesByID,
    partsByMessageID,
    cursor,
    complete,
    turnCount,
    sync: {
      liveRevision,
      confirmedHeadMessageID: confirmedHeadMessageID(messages),
    },
  })
}

/**
 * Rebuild InfiniteData after a flat reducer commit.
 * Preserves page structure and object identity for unchanged message/parts refs.
 */
function rebuildFromReducedState(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  reduced: {
    message: Record<string, Message[]>
    part: Record<string, Part[]>
    messages: Message[]
    boundary: SessionHistoryBoundary | undefined
  },
  purpose: SessionMessagePagePurpose,
  page: TranscriptTransportPage,
  liveRevision: number,
): SessionTranscriptData {
  const nextMessages = reduced.messages
  const nextPart = reduced.part
  const pageTurnCount =
    typeof page.turnCount === "number" && Number.isFinite(page.turnCount)
      ? Math.max(0, Math.floor(page.turnCount))
      : typeof page.requestedTurnLimit === "number" && Number.isFinite(page.requestedTurnLimit)
        ? Math.max(0, Math.floor(page.requestedTurnLimit))
        : page.records.length > 0
          ? 1
          : 0

  const pageCursor = page.complete ? null : (page.cursor ?? null)
  const pageComplete = page.complete

  if (!previous || previous.pages.length === 0 || purpose === "initial") {
    const tail = pageFromMessages(
      "tail",
      nextMessages,
      nextPart,
      // Tail page carries the older-history cursor from the HTTP response.
      pageCursor,
      pageComplete,
      pageTurnCount,
      liveRevision,
    )
    return freezeSessionTranscriptData({
      pages: [tail],
      pageParams: [null],
    })
  }

  // reconcile-page reuses the recovery layout path below (in-place upsert /
  // created-time insert) after the reducer already preserved the history boundary.

  if (purpose === "prepend") {
    const previousIDs = new Set<string>()
    for (const prevPage of previous.pages) {
      for (const id of prevPage.messageOrder) previousIDs.add(id)
    }
    const historyMessages = nextMessages.filter((message) => {
      // Page records define the prepend window; also include insert-only adds.
      const inPage = page.records.some((record) => record.info.id === message.id)
      return inPage || !previousIDs.has(message.id)
    }).filter((message) => {
      // History page should only hold messages that belong to the prepend set
      // or were newly inserted ahead of the previous chain.
      if (page.records.some((record) => record.info.id === message.id)) return true
      if (!previousIDs.has(message.id)) {
        // Only place newly inserted messages that sort before the previous head.
        const previousFirst = previous.pages[0]?.messageOrder[0]
        return !previousFirst || message.id < previousFirst
      }
      return false
    })

    // Prefer records order from the HTTP page for the new history page.
    const historyOrdered: Message[] = []
    const historySeen = new Set<string>()
    for (const record of page.records) {
      const message = nextMessages.find((item) => item.id === record.info.id)
      if (!message || historySeen.has(message.id)) continue
      historySeen.add(message.id)
      historyOrdered.push(message)
    }
    for (const message of historyMessages) {
      if (historySeen.has(message.id)) continue
      historySeen.add(message.id)
      historyOrdered.push(message)
    }

    const historyPage = pageFromMessages(
      "history",
      historyOrdered,
      nextPart,
      pageCursor,
      pageComplete,
      pageTurnCount,
      liveRevision,
    )

    const remainingIDs = new Set(historySeen)
    const nextPages: TranscriptPage[] = [historyPage]
    const nextParams: (string | null)[] = [pageCursor]

    for (let index = 0; index < previous.pages.length; index += 1) {
      const prevPage = previous.pages[index]!
      const keptMessages: Message[] = []
      for (const id of prevPage.messageOrder) {
        if (remainingIDs.has(id)) continue
        const message = reduced.message[sessionID]?.find((item) => item.id === id)
          ?? prevPage.messagesByID[id]
        if (message) keptMessages.push(message)
      }
      // Also absorb any nextMessages that still belong to this page slot and
      // were not placed in history (e.g. upsert of existing tail ids).
      nextPages.push(
        sharePageMessages(prevPage, keptMessages, nextPart, liveRevision),
      )
      nextParams.push(previous.pageParams[index] ?? null)
    }

    return freezeSessionTranscriptData({
      pages: nextPages,
      pageParams: nextParams,
    })
  }

  // recovery / materialize / reconcile-page: keep page layout, update messages
  // in place. Recovery/materialize append new rows to the tail. Reconcile
  // continuation windows insert by (`time.created`, id) so a later older page
  // cannot land after a newer gap page already merged in this round.
  const owned = new Map<string, number>()
  previous.pages.forEach((prevPage, index) => {
    for (const id of prevPage.messageOrder) {
      if (!owned.has(id)) owned.set(id, index)
    }
  })

  const pageBuckets: Message[][] = previous.pages.map(() => [])
  const unowned: Message[] = []
  for (const message of nextMessages) {
    const pageIndex = owned.get(message.id)
    if (pageIndex === undefined) {
      unowned.push(message)
    } else {
      pageBuckets[pageIndex]!.push(message)
    }
  }

  const nextPages = previous.pages.map((prevPage, index) => {
    const bucket = pageBuckets[index] ?? []
    if (index === previous.pages.length - 1 && unowned.length > 0) {
      const merged = purpose === "reconcile-page"
        ? insertPageMessagesByCreated(bucket, unowned)
        : [...bucket, ...unowned]
      return sharePageMessages(prevPage, merged, nextPart, liveRevision)
    }
    return sharePageMessages(prevPage, bucket, nextPart, liveRevision)
  })

  // Boundary / older cursor lives on the first page; update from reduced boundary.
  if (nextPages.length > 0 && reduced.boundary) {
    const first = nextPages[0]!
    const cursor =
      reduced.boundary.kind === "has-more" ? reduced.boundary.cursor : null
    const complete = reduced.boundary.kind === "exhausted"
    if (first.cursor !== cursor || first.complete !== complete) {
      nextPages[0] = freezePage({
        ...first,
        cursor,
        complete,
        sync: { ...first.sync, liveRevision },
      })
    }
  }

  return freezeSessionTranscriptData({
    pages: nextPages,
    pageParams: [...previous.pageParams],
  })
}

function insertPageMessagesByCreated(
  existing: readonly Message[],
  newcomers: readonly Message[],
): Message[] {
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

function sharePageMessages(
  previous: TranscriptPage,
  messages: readonly Message[],
  part: Record<string, Part[]>,
  liveRevision: number,
): TranscriptPage {
  const messageOrder: string[] = []
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  let orderChanged = messages.length !== previous.messageOrder.length
  let messagesChanged = false
  let partsChanged = false

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (!message?.id) continue
    messageOrder.push(message.id)
    if (previous.messageOrder[index] !== message.id) orderChanged = true

    const prevMessage = previous.messagesByID[message.id]
    // Prefer the previous message object so unchanged rows keep their
    // reference. SSE drafts may rebuild message shells, so identity equality
    // is not enough — a structurally equivalent draft also keeps the prior ref.
    if (prevMessage === message) {
      messagesByID[message.id] = message
    } else if (prevMessage && sameMessageIdentity(prevMessage, message)) {
      messagesByID[message.id] = prevMessage
    } else {
      messagesByID[message.id] = message
      messagesChanged = true
    }

    const nextParts = part[message.id]
    const prevParts = previous.partsByMessageID[message.id]
    if (nextParts === undefined) {
      if (prevParts !== undefined) {
        partsChanged = true
      }
    } else if (prevParts && (prevParts === nextParts || partsArraysEqualByRefOrContent(prevParts, nextParts))) {
      // Keep the previous frozen parts array reference when contents match.
      partsByMessageID[message.id] = prevParts
    } else if (Object.isFrozen(nextParts) && nextParts === prevParts) {
      partsByMessageID[message.id] = nextParts
    } else {
      // If caller already passed the previous frozen array, keep it.
      if (prevParts && nextParts === prevParts) {
        partsByMessageID[message.id] = prevParts
      } else {
        partsByMessageID[message.id] = Object.freeze([...nextParts]) as readonly Part[]
        partsChanged = true
      }
    }
  }

  if (
    !orderChanged
    && !messagesChanged
    && !partsChanged
    && previous.sync.liveRevision === liveRevision
  ) {
    return previous
  }

  // When only liveRevision bumped but all content shared, still reuse prev page
  // if nothing else changed — callers that only need content refs stay stable.
  if (!orderChanged && !messagesChanged && !partsChanged) {
    // Content-identical: return previous page so message/parts refs stay put.
    // liveRevision advances on the page only when content actually changes.
    return previous
  }

  return freezePage({
    kind: previous.kind,
    messageOrder,
    messagesByID,
    partsByMessageID,
    cursor: previous.cursor,
    complete: previous.complete,
    turnCount: previous.turnCount,
    sync: {
      liveRevision,
      confirmedHeadMessageID: confirmedHeadMessageID(messages),
    },
  })
}

function sameMessageIdentity(a: Message, b: Message): boolean {
  if (a === b) return true
  if (a.id !== b.id) return false
  // SSE drafts clone via spread from existing rows; prefer prior ref when the
  // draft is still the same object path (reference equality already handled).
  // For cloned equal fields, keep prior to avoid churn on unrelated messages.
  return a === b
}

/**
 * Whether two part snapshots carry the same payload.
 *
 * Comparing only `text` treats a tool part as unchanged for its whole
 * lifecycle: `pending → running → completed` moves `status`, `input`,
 * `output`, `metadata` and `title`, all of which live under `state`. Callers
 * use this to keep the previous frozen parts array, so a false "equal" here
 * silently drops the update and the row stays stuck on its first frame.
 * The reducer allocates a new object whenever it changes one of these, so
 * reference comparison is enough.
 */
function partPayloadEqual(left: Part, right: Part): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.id !== right.id || left.type !== right.type) return false
  if ((left as { text?: string }).text !== (right as { text?: string }).text) return false
  if ((left as { state?: unknown }).state !== (right as { state?: unknown }).state) return false
  if ((left as { output?: unknown }).output !== (right as { output?: unknown }).output) return false
  if ((left as { metadata?: unknown }).metadata !== (right as { metadata?: unknown }).metadata) return false
  if ((left as { time?: unknown }).time !== (right as { time?: unknown }).time) return false
  // Slim file projections drop `url`; a later exact fill only changes url/slim.
  if ((left as { url?: unknown }).url !== (right as { url?: unknown }).url) return false
  if ((left as { slim?: unknown }).slim !== (right as { slim?: unknown }).slim) return false
  return true
}

function partsArraysEqualByRefOrContent(
  left: readonly Part[],
  right: readonly Part[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (!partPayloadEqual(left[i], right[i])) return false
  }
  return true
}

function sortParts(parts: readonly Part[]): Part[] {
  return parts
    .filter((part) => !!part?.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function extractEventMessageID(event: Event): string | undefined {
  const props = event.properties as {
    messageID?: string
    info?: { id?: string }
    part?: { messageID?: string }
  } | undefined
  if (!props) return undefined
  if (typeof props.messageID === "string") return props.messageID
  if (typeof props.info?.id === "string") return props.info.id
  if (typeof props.part?.messageID === "string") return props.part.messageID
  return undefined
}

function rebuildTranscriptAfterSseDraft(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  draft: TranscriptEventDraft,
  previousBoundary: ReturnType<typeof boundaryFromTranscriptData>,
  liveRevision: number,
  targetMessageIDs: ReadonlySet<string>,
): SessionTranscriptData {
  const nextMessages = draft.message[sessionID] ?? []
  const nextPart = draft.part as Record<string, Part[]>
  const data = rebuildFromReducedState(
    previous ?? emptySessionTranscriptData(),
    sessionID,
    {
      message: draft.message,
      part: nextPart,
      messages: nextMessages,
      boundary: previousBoundary,
    },
    "recovery",
    {
      records: nextMessages.map((info) => ({
        info,
        parts: nextPart[info.id] ?? [],
      })),
      complete: previousBoundary.kind === "exhausted",
      cursor:
        previousBoundary.kind === "has-more"
          ? previousBoundary.cursor
          : undefined,
      turnCount: 0,
    },
    liveRevision,
  )

  // Prefer page-local update: if previous had pages, rebuild via share buckets.
  // Reuse previous message object refs when the draft still holds them.
  if (previous && previous.pages.length > 0) {
    const owned = new Map<string, number>()
    const previousMessagesByID = new Map<string, Message>()
    previous.pages.forEach((page, index) => {
      for (const id of page.messageOrder) {
        if (!owned.has(id)) owned.set(id, index)
        const prevMsg = page.messagesByID[id]
        if (prevMsg) previousMessagesByID.set(id, prevMsg)
      }
    })
    // Prefer previous message refs when draft message is equal by id and
    // was not the target of this event (draft clones arrays, not always objects).
    const resolvedMessages = nextMessages.map((message) => {
      const prev = previousMessagesByID.get(message.id)
      return prev && prev.id === message.id && prev === message ? prev : (prev && message.id === prev.id ? (message === prev ? prev : message) : message)
    })
    // When draft message is a new object for an unchanged row, still prefer prev
    // if event did not target that message id.
    const stableMessages = resolvedMessages.map((message) => {
      const prev = previousMessagesByID.get(message.id)
      if (!prev) return message
      if (targetMessageIDs.has(message.id)) return message
      return prev
    })

    // For parts: keep previous parts array ref when the draft array equals by content.
    // Cast through Part[] for sharePageMessages; refs may be readonly frozen arrays.
    const stablePart: Record<string, Part[]> = {}
    for (const message of stableMessages) {
      const draftParts = nextPart[message.id]
      if (!draftParts) continue
      let prevParts: readonly Part[] | undefined
      for (const page of previous.pages) {
        if (page.partsByMessageID[message.id]) {
          prevParts = page.partsByMessageID[message.id]
          break
        }
      }
      if (prevParts && !targetMessageIDs.has(message.id)) {
        // Always prefer previous frozen ref for non-targeted messages.
        stablePart[message.id] = prevParts as Part[]
      } else if (
        prevParts
        && partsArraysEqualByRefOrContent(prevParts, draftParts)
      ) {
        stablePart[message.id] = prevParts as Part[]
      } else {
        stablePart[message.id] = draftParts
      }
    }

    const buckets: Message[][] = previous.pages.map(() => [])
    const unowned: Message[] = []
    for (const message of stableMessages) {
      const pageIndex = owned.get(message.id)
      if (pageIndex === undefined) unowned.push(message)
      else buckets[pageIndex]!.push(message)
    }
    const pages = previous.pages.map((page, index) => {
      const bucket =
        index === previous.pages.length - 1
          ? [...(buckets[index] ?? []), ...unowned]
          : (buckets[index] ?? [])
      return sharePageMessages(page, bucket, stablePart, liveRevision)
    })
    return freezeSessionTranscriptData({
      pages,
      pageParams: [...previous.pageParams],
    })
  }

  return data
}

function cloneTranscriptSseDraft(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
): {
  draft: TranscriptEventDraft
  previousBoundary: ReturnType<typeof boundaryFromTranscriptData>
} {
  const flat = flattenTranscriptData(previous, sessionID)
  const previousBoundary = boundaryFromTranscriptData(previous)
  const draft: TranscriptEventDraft = {
    message: { ...flat.message, [sessionID]: [...(flat.message[sessionID] ?? [])] },
    part: { ...flat.part },
  }

  // Clone part arrays so applyTranscriptDirectoryEvent can mutate safely.
  for (const [key, parts] of Object.entries(draft.part)) {
    if (parts) draft.part[key] = [...parts]
  }

  return { draft, previousBoundary }
}

function applySseToTranscriptData(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  event: Event,
  liveRevision: number,
): TranscriptMergeResult {
  if (!isTranscriptSseEventType(event.type)) {
    return {
      data: previous,
      result: { applied: false, changed: false },
    }
  }

  const { draft, previousBoundary } = cloneTranscriptSseDraft(previous, sessionID)

  const applyResult = applyTranscriptDirectoryEvent(draft, event)
  const changed = typeof applyResult === "boolean" ? applyResult : applyResult.changed
  if (!changed) {
    return {
      data: previous,
      result: { applied: true, changed: false },
    }
  }

  const eventMessageID = extractEventMessageID(event)
  const targetMessageIDs = new Set<string>()
  if (eventMessageID) targetMessageIDs.add(eventMessageID)

  return {
    data: rebuildTranscriptAfterSseDraft(
      previous,
      sessionID,
      draft,
      previousBoundary,
      liveRevision,
      targetMessageIDs,
    ),
    result: { applied: true, changed: true },
  }
}

function collectPreviousPartsByMessageID(
  previous: SessionTranscriptData | undefined,
): Map<string, readonly Part[]> {
  const map = new Map<string, readonly Part[]>()
  if (!previous) return map
  for (const page of previous.pages) {
    for (const [messageID, parts] of Object.entries(page.partsByMessageID)) {
      if (!map.has(messageID) && parts) map.set(messageID, parts)
    }
  }
  return map
}

function collectPreviousMessagesByID(
  previous: SessionTranscriptData | undefined,
): Map<string, Message> {
  const map = new Map<string, Message>()
  if (!previous) return map
  for (const page of previous.pages) {
    for (const [messageID, message] of Object.entries(page.messagesByID)) {
      if (!map.has(messageID) && message) map.set(messageID, message)
    }
  }
  return map
}

function messageOrderIDs(messages: readonly Message[] | undefined): string[] {
  if (!messages) return []
  return messages.map((message) => message.id).filter((id): id is string => typeof id === "string")
}

/**
 * Batch SSE merge: one flatten/clone, ordered reducer applies, one rebuild.
 * liveRevision counts content-meaningful changes only (matches sequential
 * apply + sharePageMessages collapse of payload-equal churn such as duplicate
 * part.updated that only stamps __dedupeNextDeltaFields).
 */
function applySseEventsToTranscriptData(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  events: readonly Event[],
  startLiveRevision: number,
): TranscriptMergeResult {
  if (events.length === 0) {
    return {
      data: previous,
      result: { applied: false, changed: false },
    }
  }

  const { draft, previousBoundary } = cloneTranscriptSseDraft(previous, sessionID)
  let anyApplied = false
  let meaningfulChangeCount = 0
  let firstMaterialization: TranscriptCommandResult["materialization"]
  const targetMessageIDs = new Set<string>()

  // Last content-committed snapshot (mirrors sequential freeze/share collapse).
  const committedParts = collectPreviousPartsByMessageID(previous)
  const committedMessages = collectPreviousMessagesByID(previous)
  let committedOrder = messageOrderIDs(draft.message[sessionID])

  for (const event of events) {
    if (!isTranscriptSseEventType(event.type)) continue
    anyApplied = true
    const applyResult = applyTranscriptDirectoryEvent(draft, event)
    const changed = typeof applyResult === "boolean" ? applyResult : applyResult.changed
    const materialization = typeof applyResult === "boolean" ? undefined : applyResult.materialization
    if (materialization && !firstMaterialization) {
      firstMaterialization = materialization
    }
    if (!changed) continue

    const eventMessageID = extractEventMessageID(event)
    const nextOrder = messageOrderIDs(draft.message[sessionID])
    const orderChanged =
      nextOrder.length !== committedOrder.length
      || nextOrder.some((id, index) => id !== committedOrder[index])

    let contentChanged = orderChanged
    if (eventMessageID) {
      const draftParts = draft.part[eventMessageID]
      const committed = committedParts.get(eventMessageID)
      if (draftParts && committed && partsArraysEqualByRefOrContent(committed, draftParts)) {
        // Payload-equal churn (e.g. duplicate snapshot only adding dedupe meta):
        // restore committed parts so final freeze matches sequential share.
        draft.part[eventMessageID] = [...committed]
      } else if (draftParts) {
        contentChanged = true
        committedParts.set(eventMessageID, draftParts)
      } else if (committed) {
        contentChanged = true
        committedParts.delete(eventMessageID)
      }

      const draftMessage = draft.message[sessionID]?.find((item) => item.id === eventMessageID)
      const committedMessage = committedMessages.get(eventMessageID)
      if (draftMessage && committedMessage && committedMessage === draftMessage) {
        // same ref
      } else if (draftMessage && committedMessage && sameMessageIdentity(committedMessage, draftMessage)) {
        // Prefer committed message shell when identity-stable.
        const list = draft.message[sessionID]
        if (list) {
          const index = list.findIndex((item) => item.id === eventMessageID)
          if (index >= 0) list[index] = committedMessage
        }
      } else if (draftMessage) {
        contentChanged = true
        committedMessages.set(eventMessageID, draftMessage)
      } else if (committedMessage) {
        contentChanged = true
        committedMessages.delete(eventMessageID)
      }
    } else {
      contentChanged = true
    }

    if (orderChanged) {
      committedOrder = nextOrder
      // Refresh committed message map for order-only admissions.
      for (const message of draft.message[sessionID] ?? []) {
        if (message?.id && !committedMessages.has(message.id)) {
          committedMessages.set(message.id, message)
        }
      }
    }

    if (!contentChanged) continue
    meaningfulChangeCount += 1
    if (eventMessageID) targetMessageIDs.add(eventMessageID)
  }

  if (!anyApplied) {
    return {
      data: previous,
      result: { applied: false, changed: false },
    }
  }

  if (meaningfulChangeCount === 0) {
    return {
      data: previous,
      result: {
        applied: true,
        // Sequential share may collapse payload-equal reducer churn to the
        // previous page; batch reports changed:false when nothing content-new.
        changed: false,
        ...(firstMaterialization ? { materialization: firstMaterialization } : {}),
      },
    }
  }

  const liveRevision = startLiveRevision + meaningfulChangeCount
  return {
    data: rebuildTranscriptAfterSseDraft(
      previous,
      sessionID,
      draft,
      previousBoundary,
      liveRevision,
      targetMessageIDs,
    ),
    result: {
      applied: true,
      changed: true,
      ...(firstMaterialization ? { materialization: firstMaterialization } : {}),
    },
  }
}

function applyOptimisticAdd(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  message: Message,
  parts: readonly Part[],
  liveRevision: number,
): TranscriptMergeResult {
  const base = previous && previous.pages.length > 0
    ? previous
    : freezeSessionTranscriptData({
      pages: [
        pageFromMessages("tail", [], {}, null, false, 0, liveRevision),
      ],
      pageParams: [null],
    })

  const flat = flattenTranscriptData(base, sessionID)
  const messages = flat.message[sessionID] ? [...flat.message[sessionID]] : []
  const existing = messages.findIndex((item) => item.id === message.id)
  if (existing < 0) {
    // New user sends (including queue dispatch) are the latest conversation
    // turn. Inserting by id drops a mid-turn-minted messageID into history
    // and the bubble never appears at the tail.
    messages.push(message)
  }
  const part = { ...flat.part, [message.id]: sortParts(parts) }

  const pages = base.pages.map((page, pageIndex) => {
    const isTail = pageIndex === base.pages.length - 1
    if (!isTail) {
      // Remove optimistic from non-tail if it somehow appears.
      if (!page.messagesByID[message.id]) return page
      const kept = page.messageOrder
        .filter((id) => id !== message.id)
        .map((id) => page.messagesByID[id]!)
        .filter(Boolean)
      return sharePageMessages(page, kept, part, liveRevision)
    }
    const tailMessages = messages.filter((item) => {
      // Tail owns messages not exclusive to earlier pages.
      for (let i = 0; i < base.pages.length - 1; i += 1) {
        if (base.pages[i]?.messagesByID[item.id]) return false
      }
      return true
    })
    return sharePageMessages(page, tailMessages, part, liveRevision)
  })

  return {
    data: freezeSessionTranscriptData({
      pages,
      pageParams: [...base.pageParams],
    }),
    result: { applied: true, changed: true },
  }
}

function applyOptimisticRemove(
  previous: SessionTranscriptData | undefined,
  messageID: string,
  liveRevision: number,
): TranscriptMergeResult {
  if (!previous || previous.pages.length === 0) {
    return { data: previous, result: { applied: true, changed: false } }
  }
  let changed = false
  const pages = previous.pages.map((page) => {
    if (!page.messagesByID[messageID] && !page.partsByMessageID[messageID]) {
      return page
    }
    changed = true
    const messages = page.messageOrder
      .filter((id) => id !== messageID)
      .map((id) => page.messagesByID[id]!)
      .filter(Boolean)
    const part: Record<string, Part[]> = {}
    for (const [id, parts] of Object.entries(page.partsByMessageID)) {
      if (id === messageID) continue
      part[id] = [...parts]
    }
    return sharePageMessages(page, messages, part, liveRevision)
  })
  return {
    data: freezeSessionTranscriptData({
      pages,
      pageParams: [...previous.pageParams],
    }),
    result: { applied: true, changed },
  }
}

/**
 * First-paint local records. Empty canonical becomes a tail whose cursor is
 * the oldest seeded message id, so pagination reads `has-more` — never
 * `exhausted` — and a cold enter goes through the hot path instead of
 * replaying a full authority initial (which would project slim summaries over
 * durable full content on every cold start). A session whose durable cache
 * happens to hold all history self-heals to `exhausted` on the first empty
 * prepend. Existing pages keep their cursor/complete; only message/part
 * bodies update. Unowned snapshots insert by (`time.created`, id) so a late
 * seed cannot append older rows after a newer HTTP tail.
 */
function applyDurableSeed(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  input: Extract<TranscriptMergeInput, { type: "durable-seed" }>,
): TranscriptMergeResult {
  if (input.records.length === 0) {
    return { data: previous, result: { applied: false, changed: false } }
  }

  const flat = flattenTranscriptData(previous, sessionID)
  const materialized = materializeSessionSnapshots(
    { message: flat.message, part: flat.part },
    sessionID,
    input.records.map((record) => ({
      info: record.info,
      parts: record.parts ? [...record.parts] : [],
    })),
    {
      skipPartTypes: input.skipPartTypes,
      merge: input.merge,
    },
  )
  if (!materialized.messagesChanged && !materialized.partsChanged) {
    return {
      data: previous,
      result: {
        applied: true,
        changed: false,
        boundary: boundaryFromTranscriptData(previous),
      },
    }
  }

  const liveRevision = previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0
  const nextPart = materialized.part

  if (!previous || previous.pages.length === 0) {
    // Durable order is (`time.created`, id) ascending, so the first message is
    // the oldest loaded record and a valid `before` cursor for older history.
    const oldestSeededID = materialized.messages[0]?.id
    const seededTurns = materialized.messages.filter((message) => message.role === "user").length
    const tail = pageFromMessages(
      "tail",
      materialized.messages,
      nextPart,
      typeof oldestSeededID === "string" && oldestSeededID.length > 0 ? oldestSeededID : null,
      false,
      seededTurns,
      liveRevision,
    )
    const data = freezeSessionTranscriptData({
      pages: [tail],
      pageParams: [null],
    })
    return {
      data,
      result: {
        applied: true,
        changed: true,
        boundary: boundaryFromTranscriptData(data),
      },
    }
  }

  const owned = new Map<string, number>()
  previous.pages.forEach((prevPage, index) => {
    for (const id of prevPage.messageOrder) {
      if (!owned.has(id)) owned.set(id, index)
    }
  })

  const pageBuckets: Message[][] = previous.pages.map(() => [])
  const unowned: Message[] = []
  for (const message of materialized.messages) {
    const pageIndex = owned.get(message.id)
    if (pageIndex === undefined) unowned.push(message)
    else pageBuckets[pageIndex]!.push(message)
  }

  const nextPages = previous.pages.map((prevPage, index) => {
    const bucket = pageBuckets[index] ?? []
    if (index === previous.pages.length - 1 && unowned.length > 0) {
      return sharePageMessages(
        prevPage,
        insertPageMessagesByCreated(bucket, unowned),
        nextPart,
        liveRevision,
      )
    }
    return sharePageMessages(prevPage, bucket, nextPart, liveRevision)
  })

  const data = freezeSessionTranscriptData({
    pages: nextPages,
    pageParams: [...previous.pageParams],
  })
  return {
    data,
    result: {
      applied: true,
      changed: true,
      boundary: boundaryFromTranscriptData(data),
    },
  }
}

// ---------------------------------------------------------------------------
// Public merge entry
// ---------------------------------------------------------------------------

export function mergeSessionTranscript(
  previous: SessionTranscriptData | undefined,
  sessionID: string,
  input: TranscriptMergeInput,
): TranscriptMergeResult {
  switch (input.type) {
    case "http-page": {
      const liveRevision = input.liveRevision ?? 0
      const flat = flattenTranscriptData(previous, sessionID)
      const reduced = reduceSessionMessagePage(
        flat,
        sessionID,
        {
          ok: true,
          records: input.page.records.map((record) => ({
            info: record.info,
            parts: record.parts ? [...record.parts] : [],
          })),
          cursor: input.page.cursor,
          complete: input.page.complete,
          turnCount: input.page.turnCount,
          requestedTurnLimit: input.page.requestedTurnLimit,
        },
        {
          purpose: input.purpose,
          skipPartTypes: input.skipPartTypes,
          optimistic: input.optimistic
            ? input.optimistic.map((item) => ({
              message: item.message,
              parts: [...item.parts],
            }))
            : undefined,
          capturedRevision: input.capturedLiveRevision,
          liveRevision: input.liveRevision,
        },
      )

      if (!reduced.applied) {
        return {
          data: previous,
          result: {
            applied: false,
            changed: false,
            error: reduced.error,
          },
        }
      }

      const data = rebuildFromReducedState(
        previous,
        sessionID,
        {
          message: reduced.message,
          part: reduced.part,
          messages: reduced.messages,
          boundary: reduced.boundary,
        },
        input.purpose,
        input.page,
        liveRevision,
      )

      return {
        data,
        result: {
          applied: true,
          changed: reduced.changed,
          boundary: reduced.boundary,
          meta: reduced.meta,
          confirmedOptimisticIDs: reduced.confirmedOptimisticIDs,
        },
      }
    }

    case "sse-event": {
      const liveRevision =
        previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0
      return applySseToTranscriptData(
        previous,
        sessionID,
        input.event,
        liveRevision + 1,
      )
    }

    case "sse-event-batch": {
      const liveRevision =
        previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0
      return applySseEventsToTranscriptData(
        previous,
        sessionID,
        input.events,
        liveRevision,
      )
    }

    case "optimistic-add": {
      const liveRevision =
        previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0
      return applyOptimisticAdd(
        previous,
        sessionID,
        input.message,
        input.parts,
        liveRevision,
      )
    }

    case "optimistic-confirm": {
      // Confirm is shadow-only; visible transcript rows stay put.
      return {
        data: previous,
        result: { applied: true, changed: false },
      }
    }

    case "optimistic-remove": {
      const liveRevision =
        previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0
      return applyOptimisticRemove(previous, input.messageID, liveRevision)
    }

    case "durable-seed":
      return applyDurableSeed(previous, sessionID, input)

    case "reset": {
      const cleared: SessionTranscriptData | undefined = undefined
      if (!input.page) {
        const hadData = Boolean(previous && previous.pages.length > 0)
        return {
          data: cleared,
          result: { applied: true, changed: hadData },
        }
      }
      return mergeSessionTranscript(cleared, sessionID, {
        type: "http-page",
        purpose: "initial",
        page: input.page,
        capturedLiveRevision: input.capturedLiveRevision,
        liveRevision: input.liveRevision,
        skipPartTypes: input.skipPartTypes,
      })
    }

    default: {
      const _exhaustive: never = input
      void _exhaustive
      return {
        data: previous,
        result: { applied: false, changed: false },
      }
    }
  }
}

function transportFromTranscriptPage(page: TranscriptPage): TranscriptTransportPage {
  return {
    records: page.messageOrder.map((id) => ({
      info: page.messagesByID[id]!,
      parts: page.partsByMessageID[id] ? [...page.partsByMessageID[id]!] : [],
    })),
    cursor: page.cursor ?? undefined,
    complete: page.complete,
    turnCount: page.turnCount,
  }
}

/**
 * Fold an incoming tail into live InfiniteData with insert-only materialize.
 * A lagging HTTP snapshot must not drop SSE-admitted messages.
 */
function mergeIncomingTail(
  oldData: SessionTranscriptData,
  incoming: TranscriptPage,
  sessionID: string,
  purpose: SessionMessagePagePurpose = "materialize",
): SessionTranscriptData | undefined {
  const merged = mergeSessionTranscript(oldData, sessionID, {
    type: "http-page",
    purpose,
    page: transportFromTranscriptPage(incoming),
    liveRevision: incoming.sync.liveRevision,
  })
  return merged.data
}

/**
 * structuralSharing for InfiniteQuery: when TanStack assembles a raw page
 * chain, re-merge through strategy so live parts and insert-only rules apply.
 */
export function shareSessionTranscriptData(
  oldData: SessionTranscriptData | undefined,
  newData: SessionTranscriptData | undefined,
  sessionID: string,
): SessionTranscriptData | undefined {
  if (!newData) return oldData
  if (!oldData || oldData.pages.length === 0) {
    return freezeSessionTranscriptData(newData)
  }
  if (newData.pages.length === oldData.pages.length) {
    const shared = shareEqualLength(oldData, newData)
    if (shared === oldData) return oldData
    // Same page count but different content. A Query tail refetch must go
    // through insert-only materialize so a lagging snapshot cannot drop a
    // live last turn. Reconcile / recovery already wrote the authoritative
    // conversation order into `newData`; re-merging that page as materialize
    // would append an older continuation window past a newer gap page.
    if (isAuthoritativeSupersetTranscript(oldData, newData)) {
      return shared
    }
    // remove-message / message.removed keep remaining row refs. A lagging
    // Host tail rebuilds those objects, so it still falls through to
    // insert-only materialize and cannot drop live rows.
    if (isAuthoritativeSubsetTranscript(oldData, newData)) {
      return shared
    }
    const incoming = newData.pages[newData.pages.length - 1]!
    return mergeIncomingTail(oldData, incoming, sessionID) ?? shared
  }
  if (newData.pages.length === oldData.pages.length + 1) {
    // Prepend: first page is the new history window.
    const incoming = newData.pages[0]!
    const merged = mergeSessionTranscript(oldData, sessionID, {
      type: "http-page",
      purpose: "prepend",
      page: transportFromTranscriptPage(incoming),
      liveRevision: incoming.sync.liveRevision,
    })
    return merged.data
  }
  if (newData.pages.length === 1 && oldData.pages.length > 1) {
    // Query refetch collapsed InfiniteData to a single tail. Keep live
    // messages the snapshot omitted (including the just-finished turn).
    const incoming = newData.pages[0]!
    return mergeIncomingTail(oldData, incoming, sessionID)
      ?? freezeSessionTranscriptData(newData)
  }
  return freezeSessionTranscriptData(newData)
}

function collectTranscriptMessageIDs(data: SessionTranscriptData): Set<string> {
  const ids = new Set<string>()
  for (const page of data.pages) {
    for (const id of page.messageOrder) ids.add(id)
  }
  return ids
}

/**
 * True when `next` dropped ids but kept every remaining message/part by
 * reference. That is the remove-message / message.removed writer contract —
 * structuralSharing must not re-merge it as a lagging Host tail.
 */
function isAuthoritativeSubsetTranscript(
  previous: SessionTranscriptData,
  next: SessionTranscriptData,
): boolean {
  const previousIDs = collectTranscriptMessageIDs(previous)
  const nextIDs = collectTranscriptMessageIDs(next)
  if (nextIDs.size === 0 || nextIDs.size >= previousIDs.size) return false
  for (const id of nextIDs) {
    if (!previousIDs.has(id)) return false
  }
  const previousFlat = projectFlatFromTranscriptData(previous, "")
  const nextFlat = projectFlatFromTranscriptData(next, "")
  for (const id of nextIDs) {
    if (previousFlat.messagesByID[id] !== nextFlat.messagesByID[id]) return false
    if (previousFlat.partsByMessageID[id] !== nextFlat.partsByMessageID[id]) return false
  }
  return true
}

/**
 * True when `next` already contains every prior id and added rows sit in
 * (`time.created`, id) conversation order. That is the reconcile / recovery
 * writer contract — structuralSharing must not rewrite it as a lagging tail.
 */
function isAuthoritativeSupersetTranscript(
  previous: SessionTranscriptData,
  next: SessionTranscriptData,
): boolean {
  const previousIDs = collectTranscriptMessageIDs(previous)
  if (previousIDs.size === 0) return false
  const nextIDs = collectTranscriptMessageIDs(next)
  for (const id of previousIDs) {
    if (!nextIDs.has(id)) return false
  }
  if (nextIDs.size <= previousIDs.size) return false

  const nextFlat = projectFlatFromTranscriptData(next, "")
  for (let index = 1; index < nextFlat.messageOrder.length; index += 1) {
    const left = nextFlat.messagesByID[nextFlat.messageOrder[index - 1]!]
    const right = nextFlat.messagesByID[nextFlat.messageOrder[index]!]
    if (!left || !right) return false
    if (compareTranscriptSortKey(transcriptSortKeyOf(left), transcriptSortKeyOf(right)) > 0) {
      return false
    }
  }
  return true
}

function shareEqualLength(
  oldData: SessionTranscriptData,
  newData: SessionTranscriptData,
): SessionTranscriptData {
  let pagesChanged = false
  const pages = newData.pages.map((page, index) => {
    const prev = oldData.pages[index]
    if (!prev) {
      pagesChanged = true
      return freezePage(page)
    }
    if (
      prev === page
      || (
        prev.kind === page.kind
        && prev.cursor === page.cursor
        && prev.complete === page.complete
        && prev.turnCount === page.turnCount
        && prev.messageOrder.length === page.messageOrder.length
        && prev.messageOrder.every((id, i) => id === page.messageOrder[i])
        && prev.messageOrder.every((id) => prev.messagesByID[id] === page.messagesByID[id])
        && prev.messageOrder.every((id) => prev.partsByMessageID[id] === page.partsByMessageID[id])
        && prev.sync.liveRevision === page.sync.liveRevision
      )
    ) {
      return prev
    }
    pagesChanged = true
    return freezePage(page)
  })
  if (!pagesChanged && oldData.pageParams.length === newData.pageParams.length) {
    return oldData
  }
  return freezeSessionTranscriptData({
    pages,
    pageParams: [...newData.pageParams],
  })
}

/** Flatten InfiniteData into transcript projection fields. */
export function projectFlatFromTranscriptData(
  data: SessionTranscriptData | undefined,
  _sessionID: string,
): {
  messageOrder: readonly string[]
  messagesByID: Readonly<Record<string, Message>>
  partsByMessageID: Readonly<Record<string, readonly Part[]>>
  boundary: SessionHistoryBoundary
  liveRevision: number
} {
  const messageOrder: string[] = []
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  let liveRevision = 0

  for (const page of data?.pages ?? []) {
    liveRevision = Math.max(liveRevision, page.sync.liveRevision)
    for (const id of page.messageOrder) {
      if (messagesByID[id]) {
        // Prefer later (newer) page version for the same id.
        messagesByID[id] = page.messagesByID[id] ?? messagesByID[id]
        if (page.partsByMessageID[id]) {
          partsByMessageID[id] = page.partsByMessageID[id]!
        }
        continue
      }
      messageOrder.push(id)
      const message = page.messagesByID[id]
      if (message) messagesByID[id] = message
      const parts = page.partsByMessageID[id]
      if (parts) partsByMessageID[id] = parts
    }
  }

  // messageOrder should stay chronological: pages are oldest → newest, and
  // within each page order is chronological. Prefer a stable rebuild:
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const page of data?.pages ?? []) {
    for (const id of page.messageOrder) {
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
    }
  }

  return {
    messageOrder: ordered,
    messagesByID,
    partsByMessageID,
    boundary: boundaryFromTranscriptData(data),
    liveRevision,
  }
}
