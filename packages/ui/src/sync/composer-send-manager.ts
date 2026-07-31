import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import type { DraftComposerDocument, DraftMention } from "@/sync/input-draft-types"
import type { QueuePendingAdmissionItem } from "@/stores/messageQueueStore"
import { ascendingId } from "@/sync/message-id"
import { createUuid } from "@/lib/uuid"

export type ComposerSendFlightKind = "send" | "queue"

export type ComposerSendConfig = {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
}

export type ComposerSendEstablishingFollowUp = QueuePendingAdmissionItem & {
  draftID: string
  sendConfig: ComposerSendConfig
  attachments: AttachedFile[]
  composerMentions?: DraftMention[]
}

export type ComposerSendEstablishingState = {
  draftID: string
  primaryMessageID: string
  pending: ComposerSendEstablishingFollowUp[]
}

export type ComposerSendAdmissionIdentity = {
  requestID: string
  queueItemID: string
  operationID: string
  messageID: string
}

export type ComposerSendEnqueueFollowUpInput = {
  draftID: string
  content: string
  sendConfig: ComposerSendConfig
  attachments?: readonly AttachedFile[]
  composerDocument?: DraftComposerDocument
  composerMentions?: DraftMention[]
  createdAt?: number
  identity?: ComposerSendAdmissionIdentity
}

type ComposerSendState = {
  /** Per-surface flight so primary and secondary composers do not block each other. */
  flights: Record<string, ComposerSendFlightKind>
  establishing: ComposerSendEstablishingState | null
}

type ComposerSendActions = {
  beginFlight: (scopeKey: string, kind?: ComposerSendFlightKind) => boolean
  endFlight: (scopeKey: string) => void
  isInFlight: (scopeKey: string) => boolean

  beginEstablishing: (input: { draftID: string; primaryMessageID: string }) => boolean
  /** Exact-draft check: a missing draft ID never matches an establishing send. */
  isEstablishing: (draftID: string | null | undefined) => boolean
  getEstablishing: () => ComposerSendEstablishingState | null

  enqueueEstablishingFollowUp: (
    input: ComposerSendEnqueueFollowUpInput,
  ) => ComposerSendEstablishingFollowUp | null

  removeEstablishingFollowUp: (requestID: string) => ComposerSendEstablishingFollowUp | null
  takeEstablishingPending: (draftID: string) => ComposerSendEstablishingFollowUp[]
  clearEstablishing: (draftID?: string | null) => ComposerSendEstablishingFollowUp[]
  shouldBlockNewSessionDraftOpen: () => boolean
}

export type ComposerSendStore = ComposerSendState & ComposerSendActions

/**
 * Single derived send phase for one composer surface. Consumers read this
 * instead of recombining flight / establishing booleans at each call site.
 */
export type ComposerSendPhase = {
  flightKind: ComposerSendFlightKind | null
  inFlight: boolean
  /**
   * New-session create+prompt owns this draft. Later submits stage follow-up
   * chips, so composer input and Send stay available despite the held flight.
   */
  establishing: boolean
}

const EMPTY_PENDING: readonly QueuePendingAdmissionItem[] = []

const createAdmissionIdentity = (): ComposerSendAdmissionIdentity => ({
  requestID: createUuid(),
  queueItemID: createUuid(),
  operationID: createUuid(),
  messageID: ascendingId("msg"),
})

const toDisplayPending = (
  item: ComposerSendEstablishingFollowUp,
): QueuePendingAdmissionItem => ({
  kind: "pending-admission",
  requestID: item.requestID,
  queueItemID: item.queueItemID,
  operationID: item.operationID,
  messageID: item.messageID,
  content: item.content,
  createdAt: item.createdAt,
  phase: "admitting",
  attachmentCount: item.attachmentCount,
  ...(item.composerDocument ? { composerDocument: item.composerDocument } : {}),
  ...(item.composerMentions ? { composerMentions: item.composerMentions } : {}),
})

export const selectEstablishingPendingDisplayItems = (
  state: Pick<ComposerSendState, "establishing">,
  draftID?: string | null,
): readonly QueuePendingAdmissionItem[] => {
  const establishing = state.establishing
  if (!establishing) return EMPTY_PENDING
  if (draftID && establishing.draftID !== draftID) return EMPTY_PENDING
  return establishing.pending.map(toDisplayPending)
}

/**
 * Render-phase selector factories. Each returns a primitive so subscribers
 * re-render only when their own surface's send state changes.
 */
export const selectComposerFlightKind = (
  scopeKey: string,
) => (state: Pick<ComposerSendState, "flights">): ComposerSendFlightKind | null => (
  state.flights[scopeKey] ?? null
)

export const selectIsEstablishingDraft = (
  draftID: string | null,
) => (state: Pick<ComposerSendState, "establishing">): boolean => (
  Boolean(draftID) && state.establishing?.draftID === draftID
)

export const selectEstablishingPendingItems = (
  draftID: string | null,
) => (state: Pick<ComposerSendState, "establishing">): readonly QueuePendingAdmissionItem[] => (
  selectEstablishingPendingDisplayItems(state, draftID)
)

export const composerSendPhase = (
  flightKind: ComposerSendFlightKind | null,
  establishing: boolean,
): ComposerSendPhase => ({
  flightKind,
  inFlight: flightKind !== null,
  establishing,
})

export const useComposerSendStore = create<ComposerSendStore>()((set, get) => ({
  flights: {},
  establishing: null,

  beginFlight: (scopeKey, kind = "send") => {
    const key = scopeKey.trim()
    if (!key || get().flights[key]) return false
    set((state) => ({ flights: { ...state.flights, [key]: kind } }))
    return true
  },

  endFlight: (scopeKey) => {
    const key = scopeKey.trim()
    if (!key || !get().flights[key]) return
    set((state) => {
      if (!state.flights[key]) return state
      const flights = { ...state.flights }
      delete flights[key]
      return { flights }
    })
  },

  isInFlight: (scopeKey) => Boolean(get().flights[scopeKey.trim()]),

  beginEstablishing: ({ draftID, primaryMessageID }) => {
    const trimmedDraftID = draftID.trim()
    const trimmedMessageID = primaryMessageID.trim()
    if (!trimmedDraftID || !trimmedMessageID) return false
    const current = get().establishing
    if (current) {
      return current.draftID === trimmedDraftID && current.primaryMessageID === trimmedMessageID
    }
    set({
      establishing: {
        draftID: trimmedDraftID,
        primaryMessageID: trimmedMessageID,
        pending: [],
      },
    })
    return true
  },

  isEstablishing: (draftID) => {
    if (!draftID) return false
    return get().establishing?.draftID === draftID
  },

  getEstablishing: () => get().establishing,

  enqueueEstablishingFollowUp: (input) => {
    const establishing = get().establishing
    if (!establishing || establishing.draftID !== input.draftID) return null
    if (!input.sendConfig.providerID || !input.sendConfig.modelID) return null
    const content = input.content
    if (!content.trim() && (input.attachments?.length ?? 0) === 0) return null

    const identity = input.identity ?? createAdmissionIdentity()
    const attachments = [...(input.attachments ?? [])]
    const item: ComposerSendEstablishingFollowUp = {
      kind: "pending-admission",
      requestID: identity.requestID,
      queueItemID: identity.queueItemID,
      operationID: identity.operationID,
      messageID: identity.messageID || ascendingId("msg"),
      content,
      createdAt: input.createdAt ?? Date.now(),
      phase: "admitting",
      attachmentCount: attachments.length,
      ...(input.composerDocument ? { composerDocument: input.composerDocument } : {}),
      ...(input.composerMentions ? { composerMentions: input.composerMentions } : {}),
      draftID: input.draftID,
      sendConfig: {
        providerID: input.sendConfig.providerID,
        modelID: input.sendConfig.modelID,
        ...(input.sendConfig.agent ? { agent: input.sendConfig.agent } : {}),
        ...(input.sendConfig.variant ? { variant: input.sendConfig.variant } : {}),
      },
      attachments,
    }

    set({
      establishing: {
        ...establishing,
        pending: [...establishing.pending, item],
      },
    })
    return item
  },

  removeEstablishingFollowUp: (requestID) => {
    const establishing = get().establishing
    if (!establishing) return null
    const index = establishing.pending.findIndex((item) => item.requestID === requestID)
    if (index < 0) return null
    const removed = establishing.pending[index]
    set({
      establishing: {
        ...establishing,
        pending: [
          ...establishing.pending.slice(0, index),
          ...establishing.pending.slice(index + 1),
        ],
      },
    })
    return removed ?? null
  },

  takeEstablishingPending: (draftID) => {
    const establishing = get().establishing
    if (!establishing || establishing.draftID !== draftID) return []
    const pending = establishing.pending
    set({ establishing: null })
    return pending
  },

  clearEstablishing: (draftID) => {
    const establishing = get().establishing
    if (!establishing) return []
    if (draftID != null && draftID !== "" && establishing.draftID !== draftID) return []
    const pending = establishing.pending
    set({ establishing: null })
    return pending
  },

  shouldBlockNewSessionDraftOpen: () => get().establishing !== null,
}))

export const resetComposerSendStoreForTests = (): void => {
  useComposerSendStore.setState({
    flights: {},
    establishing: null,
  })
}

export const createComposerSendAdmissionIdentity = (): ComposerSendAdmissionIdentity => (
  createAdmissionIdentity()
)