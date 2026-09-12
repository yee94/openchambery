/**
 * Pure contact-transcript merge for latest-window refresh + older pagination.
 * Server pages newest-first keyset; each page.messages is ascending by ordinal.
 * Ordinal holes from tool wipe are legal — gap is window non-overlap, not dense ordinals.
 *
 * Authoritative same-generation latest replaces its coverage:
 * complete page = full set; partial page = first keyset through the latest end.
 * Stale lower-revision latest preserves existing rows.
 *
 * Gap state splits two identities (no multi-layer queue):
 * - gapRequestIDs: which fill session may advance gapCursor (updated on full slide).
 * - gapTargetIDs: earliest unfinished bridge targets; full slide keeps them until hit/complete.
 */
import type { AssistantContactMessage, AssistantContactPage, AssistantDTO, AssistantReadPosition } from './assistantDTO'

/**
 * Contact keyset order matching server SQLite BINARY:
 * (ordinal ASC, message_id ASC) via JS relational `<`/`>` (not localeCompare).
 */
export const compareContactMessageKeyset = (
  left: { ordinal: number; messageID: string },
  right: { ordinal: number; messageID: string },
): number => {
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
  if (left.messageID < right.messageID) return -1
  if (left.messageID > right.messageID) return 1
  return 0
}

/** True when a part is user-visible (file/card or non-empty non-settle text). */
export const isContactVisiblePart = (part: { type: string; text?: string }): boolean => {
  if (part.type === 'file' || part.type === 'card') return true
  if (part.type !== 'text') return false
  const trimmed = typeof part.text === 'string' ? part.text.trim() : ''
  return Boolean(trimmed) && !trimmed.startsWith('oc.settle.')
}

export const getLoadedAssistantReadPosition = (
  assistant: Pick<AssistantDTO, 'id' | 'unreadCount' | 'readTip' | 'readWatermark'>,
  page: Pick<AssistantContactPage, 'generation' | 'messages'> | undefined,
): AssistantReadPosition | null => {
  if (!page || !assistant.readTip || !((assistant.unreadCount ?? 0) > 0)) return null
  const tip = assistant.readTip
  if (page.generation !== tip.generation) return null
  // The loaded row owns the reported cursor even when the catalog has a newer tip.
  let message: AssistantContactMessage | undefined
  for (let index = page.messages.length - 1; index >= 0; index -= 1) {
    const row = page.messages[index]
    if (row.assistantID === assistant.id && (row.status === 'complete' || row.status === 'error')
      && row.parts.some(isContactVisiblePart)) {
      message = row
      break
    }
  }
  if (!message) return null
  const watermark = assistant.readWatermark
  if (watermark) {
    if (watermark.generation > page.generation) return null
    if (
      watermark.generation === page.generation
      && compareContactMessageKeyset(
        { ordinal: watermark.ordinal, messageID: watermark.messageID },
        { ordinal: message.ordinal, messageID: message.messageID },
      ) >= 0
    ) return null
  }
  return { generation: page.generation, ordinal: message.ordinal, messageID: message.messageID }
}

export const CONTACT_MESSAGES_PAGE_DEFAULT = 20
export const CONTACT_GAP_FILL_MAX_PAGES = 5

export type ContactMessagesView = {
  messages: AssistantContactMessage[]
  /** -1 = uninitialized empty; 0+ = server generation. */
  generation: number
  revision: number
  olderCursor: string | null
  olderComplete: boolean
  hasMessageGap: boolean
  gapCursor: string | null
  /**
   * Request identity for the active fill session (previous live window at last full slide).
   * Only gap responses captured with this identity may advance gapCursor.
   */
  gapRequestIDs: readonly string[] | null
  /**
   * Earliest unfinished targets to bridge back to. Full slides keep these until a fill page
   * intersects them or the server reports complete.
   */
  gapTargetIDs: readonly string[] | null
  /** Last applied latest-window IDs (for overlap detection). */
  liveWindowIDs: readonly string[]
}

export const emptyContactMessagesView = (): ContactMessagesView => ({
  messages: [],
  generation: -1,
  revision: 0,
  olderCursor: null,
  olderComplete: true,
  hasMessageGap: false,
  gapCursor: null,
  gapRequestIDs: null,
  gapTargetIDs: null,
  liveWindowIDs: [],
})

export const isContactMessagesInitialized = (view: ContactMessagesView | null | undefined): boolean => (
  Boolean(view && view.generation >= 0)
)

const byOrdinal = (left: AssistantContactMessage, right: AssistantContactMessage) => (
  compareContactMessageKeyset(
    { ordinal: left.ordinal, messageID: left.messageID },
    { ordinal: right.ordinal, messageID: right.messageID },
  )
)

export const mergeContactMessagesById = (
  existing: readonly AssistantContactMessage[],
  incoming: readonly AssistantContactMessage[],
  preferred: 'incoming' | 'existing' = 'incoming',
): AssistantContactMessage[] => {
  const map = new Map<string, AssistantContactMessage>()
  for (const message of existing) map.set(message.messageID, message)
  for (const message of incoming) {
    if (preferred === 'incoming' || !map.has(message.messageID)) {
      map.set(message.messageID, message)
    }
  }
  return [...map.values()].sort(byOrdinal)
}

const minOrdinal = (messages: readonly AssistantContactMessage[]) => {
  let min = Number.POSITIVE_INFINITY
  for (const message of messages) {
    if (message.ordinal < min) min = message.ordinal
  }
  return Number.isFinite(min) ? min : null
}

const idsOf = (messages: readonly AssistantContactMessage[]) => messages.map((message) => message.messageID)

const intersects = (left: readonly string[], right: ReadonlySet<string>) => {
  for (const id of left) {
    if (right.has(id)) return true
  }
  return false
}

const toIdSet = (ids: readonly string[]) => new Set(ids)

const sameIDList = (left: readonly string[] | null | undefined, right: readonly string[] | null | undefined) => {
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
}

const clearGap = <T extends Partial<ContactMessagesView>>(base: T) => ({
  ...base,
  hasMessageGap: false as const,
  gapCursor: null,
  gapRequestIDs: null,
  gapTargetIDs: null,
})

const messageKeyset = (message: AssistantContactMessage) => ({
  ordinal: message.ordinal,
  messageID: message.messageID,
})

/**
 * Authoritative same-generation latest coverage (after revision fence).
 * complete: page is the full server set.
 * partial: replace from the page's first keyset through the latest end, retaining older history.
 */
const replaceLatestCoverage = (
  previousMessages: readonly AssistantContactMessage[],
  latest: readonly AssistantContactMessage[],
  complete: boolean,
): AssistantContactMessage[] => {
  if (complete) return [...latest]
  if (latest.length === 0) return [...previousMessages]
  const pageFirst = latest[0]!
  const older = previousMessages.filter(
    (message) => compareContactMessageKeyset(messageKeyset(message), messageKeyset(pageFirst)) < 0,
  )
  return [...older, ...latest]
}

/**
 * Apply a latest-window page (no before).
 * After generation/revision fencing, an authoritative page replaces its coverage range
 * (complete = full set; partial = first keyset through latest end) so same-generation server deletes win.
 * Stale lower-revision pages never delete: same-id keeps existing, unique ids still merge.
 * Optimistic/streaming overlays remain owned by the contact surface, outside this server cache.
 * Gap = no ID overlap with the previous live window while server still has older cursor.
 * Closed only by gap-fill overlap with gapTargetIDs or server complete — not by ordinal density.
 */
export const applyContactLatestPage = (
  previous: ContactMessagesView | null | undefined,
  page: AssistantContactPage,
): ContactMessagesView => {
  const prev = previous ?? emptyContactMessagesView()
  const initialized = isContactMessagesInitialized(prev)
  const latest = [...page.messages].sort(byOrdinal)
  const liveWindowIDs = idsOf(latest)

  // Generation fencing does not depend on message length (empty reset is valid).
  if (initialized && page.generation < prev.generation) {
    return prev
  }
  if (initialized && page.generation > prev.generation) {
    return {
      messages: latest,
      generation: page.generation,
      revision: page.revision,
      olderCursor: page.nextCursor,
      olderComplete: page.complete,
      hasMessageGap: false,
      gapCursor: null,
      gapRequestIDs: null,
      gapTargetIDs: null,
      liveWindowIDs,
    }
  }
  if (!initialized) {
    return {
      messages: latest,
      generation: page.generation,
      revision: page.revision,
      olderCursor: page.complete ? null : page.nextCursor,
      olderComplete: page.complete,
      hasMessageGap: false,
      gapCursor: null,
      gapRequestIDs: null,
      gapTargetIDs: null,
      liveWindowIDs,
    }
  }

  // Same generation.
  const revision = Math.max(prev.revision, page.revision)
  const authoritative = page.revision >= prev.revision

  if (latest.length === 0) {
    if (authoritative && page.complete) {
      return {
        messages: [],
        generation: page.generation,
        revision,
        olderCursor: null,
        olderComplete: true,
        hasMessageGap: false,
        gapCursor: null,
        gapRequestIDs: null,
        gapTargetIDs: null,
        liveWindowIDs: [],
      }
    }
    return {
      ...prev,
      generation: page.generation,
      revision,
      olderCursor: prev.olderCursor ?? page.nextCursor,
      olderComplete: prev.olderComplete && page.complete,
      liveWindowIDs: [],
      hasMessageGap: prev.hasMessageGap,
      gapCursor: prev.hasMessageGap ? (page.nextCursor ?? prev.gapCursor) : null,
      gapRequestIDs: prev.hasMessageGap ? prev.gapRequestIDs : null,
      gapTargetIDs: prev.hasMessageGap ? prev.gapTargetIDs : null,
    }
  }

  let merged: AssistantContactMessage[]
  if (authoritative) {
    merged = replaceLatestCoverage(prev.messages, latest, page.complete)
  } else {
    // Stale: retain existing same-id content; still absorb unique ids from the late page.
    const windowMin = minOrdinal(latest)!
    const belowWindow = prev.messages.filter((message) => message.ordinal < windowMin)
    const prevInWindow = prev.messages.filter((message) => message.ordinal >= windowMin)
    const windowMerged = mergeContactMessagesById(prevInWindow, latest, 'existing')
    merged = mergeContactMessagesById(belowWindow, windowMerged, 'incoming')
  }

  const prevLive = prev.liveWindowIDs
  const liveSet = toIdSet(liveWindowIDs)
  const overlappedPreviousLive = prevLive.length > 0 && intersects(prevLive, liveSet)

  let hasMessageGap = prev.hasMessageGap
  let gapCursor = prev.gapCursor
  let gapRequestIDs = prev.gapRequestIDs
  let gapTargetIDs = prev.gapTargetIDs

  if (!overlappedPreviousLive && prevLive.length > 0 && page.nextCursor) {
    // Full slide: new request identity + cursor under new latest; keep unfinished earliest targets.
    hasMessageGap = true
    gapCursor = page.nextCursor
    const request = prevLive.filter((id) => !liveSet.has(id))
    gapRequestIDs = request.length > 0 ? request : [...prevLive]
    if (prev.hasMessageGap && prev.gapTargetIDs && prev.gapTargetIDs.length > 0) {
      gapTargetIDs = prev.gapTargetIDs
    } else {
      gapTargetIDs = gapRequestIDs
    }
  } else if (prev.hasMessageGap) {
    // Same / overlapping latest: keep resume cursor, request identity, and targets.
    hasMessageGap = true
    gapCursor = prev.gapCursor
    gapRequestIDs = prev.gapRequestIDs
    gapTargetIDs = prev.gapTargetIDs
  } else {
    hasMessageGap = false
    gapCursor = null
    gapRequestIDs = null
    gapTargetIDs = null
  }

  return {
    messages: merged,
    generation: page.generation,
    revision,
    olderCursor: prev.liveWindowIDs.length === 0 && prev.messages.length === 0
      ? (page.complete ? null : page.nextCursor)
      : prev.olderCursor,
    olderComplete: !initialized || (prev.liveWindowIDs.length === 0 && prev.messages.length === 0)
      ? page.complete
      : prev.olderComplete,
    hasMessageGap,
    gapCursor: hasMessageGap ? gapCursor : null,
    gapRequestIDs: hasMessageGap ? gapRequestIDs : null,
    gapTargetIDs: hasMessageGap ? gapTargetIDs : null,
    liveWindowIDs,
  }
}

export const applyContactOlderPage = (
  previous: ContactMessagesView,
  page: AssistantContactPage,
): ContactMessagesView => {
  if (!isContactMessagesInitialized(previous)) return previous
  if (page.generation !== previous.generation) return previous
  const preferred = page.revision >= previous.revision ? 'incoming' as const : 'existing' as const
  const merged = mergeContactMessagesById(previous.messages, page.messages, preferred)
  return {
    ...previous,
    messages: merged,
    revision: Math.max(previous.revision, page.revision),
    olderCursor: page.complete ? null : page.nextCursor,
    olderComplete: page.complete,
  }
}

/**
 * @param gapSession Request identity (+ optional cursor) captured when the gap HTTP request started.
 * Messages always merge; cursor advance only if request identity still matches the view.
 * Close only on gapTargetIDs overlap (earliest unfinished) or server complete.
 */
export const applyContactGapPage = (
  previous: ContactMessagesView,
  page: AssistantContactPage,
  gapSession?: { requestIDs: readonly string[]; cursor?: string | null },
): ContactMessagesView => {
  if (!isContactMessagesInitialized(previous)) return previous
  if (page.generation !== previous.generation) return previous
  const preferred = page.revision >= previous.revision ? 'incoming' as const : 'existing' as const
  const merged = mergeContactMessagesById(previous.messages, page.messages, preferred)
  const revision = Math.max(previous.revision, page.revision)

  const sessionRequest = gapSession?.requestIDs ?? previous.gapRequestIDs
  const identityMatches = Boolean(
    previous.hasMessageGap
    && sessionRequest
    && previous.gapRequestIDs
    && sameIDList(sessionRequest, previous.gapRequestIDs),
  )

  if (!identityMatches) {
    // Stale gap response for a replaced request identity — merge only.
    return {
      ...previous,
      messages: merged,
      revision,
    }
  }

  const incomingIds = idsOf(page.messages)
  const targets = previous.gapTargetIDs ?? []
  const targetSet = toIdSet(targets)
  const hitEarliest = targets.length > 0 && intersects(incomingIds, targetSet)
  const closed = hitEarliest || page.complete || !page.nextCursor

  if (closed) {
    return clearGap({
      ...previous,
      messages: merged,
      revision,
    })
  }

  return {
    ...previous,
    messages: merged,
    revision,
    hasMessageGap: true,
    gapCursor: page.nextCursor ?? previous.gapCursor,
    gapRequestIDs: previous.gapRequestIDs,
    gapTargetIDs: previous.gapTargetIDs,
  }
}
