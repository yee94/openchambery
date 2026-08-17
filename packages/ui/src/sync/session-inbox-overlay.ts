/**
 * Unpromoted v2 inbox items live near the composer, not in the transcript.
 * Ticket 07 owns queue/steer/cancel UI; this store is the idle-send seam.
 */

import { create } from "zustand"
import type { QueuePendingAdmissionItem } from "@/stores/messageQueueStore"
import type { SessionInboxDelivery, SessionInboxUser } from "./session-prompt-api"

export type SessionInboxOverlayItem = SessionInboxUser & {
  requestID: string
}

export type SessionInboxChip = {
  kind: "session-inbox"
  requestID: string
  queueItemID: string
  operationID: string
  messageID: string
  content: string
  createdAt: number
  delivery: SessionInboxDelivery
  attachmentCount: number
}

export type SessionComposerPendingItem = QueuePendingAdmissionItem | SessionInboxChip

type SessionInboxOverlayState = {
  bySession: Record<string, SessionInboxOverlayItem[]>
  remember: (item: SessionInboxUser) => void
  forget: (sessionID: string, inboxID: string) => void
  forgetSession: (sessionID: string) => void
  forgetPromoted: (sessionID: string, promotedIDs: readonly string[]) => void
  replaceFromAuthority: (sessionID: string, items: readonly SessionInboxUser[]) => void
  updateDelivery: (sessionID: string, inboxID: string, delivery: SessionInboxDelivery) => void
  list: (sessionID: string) => SessionInboxOverlayItem[]
}

const toChip = (item: SessionInboxOverlayItem): SessionInboxChip => ({
  kind: "session-inbox",
  requestID: item.requestID,
  queueItemID: item.id,
  operationID: item.id,
  messageID: item.id,
  content: item.payload.text,
  createdAt: item.timeCreated,
  delivery: item.delivery,
  attachmentCount: Array.isArray(item.payload.files) ? item.payload.files.length : 0,
})

const writeSession = (
  bySession: Record<string, SessionInboxOverlayItem[]>,
  sessionID: string,
  next: SessionInboxOverlayItem[],
): Record<string, SessionInboxOverlayItem[]> => {
  const copy = { ...bySession }
  if (next.length === 0) delete copy[sessionID]
  else copy[sessionID] = next
  return copy
}

export const useSessionInboxOverlayStore = create<SessionInboxOverlayState>((set, get) => ({
  bySession: {},
  remember(item) {
    set((state) => {
      const current = state.bySession[item.sessionID] ?? []
      const index = current.findIndex((entry) => entry.id === item.id)
      const nextItem = { ...item, requestID: item.id }
      if (index >= 0) {
        const next = current.slice()
        next[index] = nextItem
        return { bySession: { ...state.bySession, [item.sessionID]: next } }
      }
      return {
        bySession: {
          ...state.bySession,
          [item.sessionID]: [...current, nextItem],
        },
      }
    })
  },
  forget(sessionID, inboxID) {
    set((state) => {
      const current = state.bySession[sessionID]
      if (!current?.length) return state
      const next = current.filter((entry) => entry.id !== inboxID)
      if (next.length === current.length) return state
      return { bySession: writeSession(state.bySession, sessionID, next) }
    })
  },
  forgetSession(sessionID) {
    set((state) => {
      if (!state.bySession[sessionID]) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionID]
      return { bySession }
    })
  },
  forgetPromoted(sessionID, promotedIDs) {
    const promoted = new Set(promotedIDs)
    set((state) => {
      const current = state.bySession[sessionID]
      if (!current?.length) return state
      const next = current.filter((entry) => !promoted.has(entry.id))
      if (next.length === current.length) return state
      return { bySession: writeSession(state.bySession, sessionID, next) }
    })
  },
  replaceFromAuthority(sessionID, items) {
    set((state) => {
      const next = items.map((item) => ({ ...item, requestID: item.id }))
      return { bySession: writeSession(state.bySession, sessionID, next) }
    })
  },
  updateDelivery(sessionID, inboxID, delivery) {
    set((state) => {
      const current = state.bySession[sessionID]
      if (!current?.length) return state
      const index = current.findIndex((entry) => entry.id === inboxID)
      if (index < 0 || current[index]!.delivery === delivery) return state
      const next = current.slice()
      next[index] = { ...current[index]!, delivery }
      return { bySession: { ...state.bySession, [sessionID]: next } }
    })
  },
  list(sessionID) {
    return get().bySession[sessionID] ?? []
  },
}))

export function rememberUnpromotedInbox(item: SessionInboxUser): void {
  useSessionInboxOverlayStore.getState().remember(item)
}

export function forgetUnpromotedInbox(sessionID: string, inboxID: string): void {
  useSessionInboxOverlayStore.getState().forget(sessionID, inboxID)
}

export function forgetPromotedInbox(sessionID: string, promotedIDs: readonly string[]): void {
  useSessionInboxOverlayStore.getState().forgetPromoted(sessionID, promotedIDs)
}

export function replaceInboxOverlayFromAuthority(
  sessionID: string,
  items: readonly SessionInboxUser[],
): void {
  useSessionInboxOverlayStore.getState().replaceFromAuthority(sessionID, items)
}

export function updateInboxOverlayDelivery(
  sessionID: string,
  inboxID: string,
  delivery: SessionInboxDelivery,
): void {
  useSessionInboxOverlayStore.getState().updateDelivery(sessionID, inboxID, delivery)
}

export function isSessionInboxChip(value: unknown): value is SessionInboxChip {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "session-inbox"
}

export function selectInboxOverlayChips(sessionID: string | null | undefined): SessionInboxChip[] {
  if (!sessionID) return []
  return useSessionInboxOverlayStore.getState().list(sessionID).map(toChip)
}
