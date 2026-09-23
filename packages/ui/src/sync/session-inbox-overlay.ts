/**
 * Unpromoted v2 inbox items live near the composer, not in the transcript.
 * Ticket 07 owns queue/steer/cancel UI; this store is the idle-send seam.
 *
 * Owner-bounded runtime-scope lifecycle:
 * - Visible pending rows live in `bySession`.
 * - Terminal receipts (`cancelled` | `consumed`) are keyed by
 *   transport + generation + session + inbox id so a late HTTP success cannot
 *   resurrect a ghost after SSE cancel/delivered (or authority consume).
 * - Live authority (enqueued SSE) may clear a receipt before remember.
 * - Snapshot authority (GET inbox) carries a request-start mark: a terminal
 *   recorded *after* that mark beats the snapshot and must not be cleared or
 *   overwritten by the stale GET.
 */

import { create } from "zustand"
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
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

/** Terminal lifecycle for one inbox identity inside a runtime scope. */
export type InboxTerminalKind = "cancelled" | "consumed"

export type InboxRuntimeScope = {
  transportIdentity: string
  generation: number
}

export type InboxTerminalReceipt = {
  kind: InboxTerminalKind
  /** Monotonic mark; higher means newer than a snapshot started earlier. */
  mark: number
}

export type InboxAuthorityOptions = {
  /**
   * High-water mark captured at GET/request start. Terminals with
   * `mark > startedMark` were recorded after the request began and win over
   * the stale snapshot (do not clear, do not re-admit).
   * Omit for live SSE authority (always may clear).
   */
  startedMark?: number
}

type SessionInboxOverlayState = {
  bySession: Record<string, SessionInboxOverlayItem[]>
  remember: (item: SessionInboxUser) => boolean
  forget: (sessionID: string, inboxID: string, terminal?: InboxTerminalKind) => void
  forgetSession: (sessionID: string) => void
  forgetPromoted: (sessionID: string, promotedIDs: readonly string[]) => void
  replaceFromAuthority: (
    sessionID: string,
    items: readonly SessionInboxUser[],
    options?: InboxAuthorityOptions,
  ) => void
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

export { toChip }

/** Stable empty snapshots — selectors must never mint a fresh `[]` per read. */
export const EMPTY_INBOX_OVERLAY_ITEMS: SessionInboxOverlayItem[] = []
export const EMPTY_INBOX_CHIPS: SessionInboxChip[] = []

/** Bounded terminal receipts: key = transport|generation|session|inbox. */
const terminalReceipts = new Map<string, InboxTerminalReceipt>()
const TERMINAL_RECEIPT_LIMIT = 512

/** Monotonic clock for terminal vs snapshot ordering. */
let authorityClock = 0

/**
 * Capture the current terminal high-water mark before starting an authority
 * GET. Any terminal recorded after this value beats the eventual snapshot.
 */
export function captureInboxAuthorityMark(): number {
  return authorityClock
}

export function captureInboxRuntimeScope(): InboxRuntimeScope {
  return {
    transportIdentity: getRuntimeTransportIdentity(),
    generation: getRuntimeGeneration(),
  }
}

export function isCurrentInboxRuntimeScope(scope: InboxRuntimeScope): boolean {
  return (
    getRuntimeTransportIdentity() === scope.transportIdentity
    && getRuntimeGeneration() === scope.generation
  )
}

function terminalKey(
  sessionID: string,
  inboxID: string,
  scope?: InboxRuntimeScope,
): string {
  const transport = scope?.transportIdentity ?? getRuntimeTransportIdentity()
  const generation = scope?.generation ?? getRuntimeGeneration()
  return `${transport}\0${generation}\0${sessionID}\0${inboxID}`
}

function pruneTerminalReceipts(current: InboxRuntimeScope = captureInboxRuntimeScope()): void {
  if (terminalReceipts.size === 0) return
  const prefix = `${current.transportIdentity}\0${current.generation}\0`
  for (const key of terminalReceipts.keys()) {
    if (!key.startsWith(prefix)) terminalReceipts.delete(key)
  }
  while (terminalReceipts.size > TERMINAL_RECEIPT_LIMIT) {
    const oldest = terminalReceipts.keys().next().value
    if (oldest === undefined) break
    terminalReceipts.delete(oldest)
  }
}

export function recordInboxTerminal(
  sessionID: string,
  inboxID: string,
  kind: InboxTerminalKind,
  scope?: InboxRuntimeScope,
): void {
  const resolved = scope ?? captureInboxRuntimeScope()
  pruneTerminalReceipts(resolved)
  authorityClock += 1
  terminalReceipts.set(terminalKey(sessionID, inboxID, resolved), {
    kind,
    mark: authorityClock,
  })
}

export function clearInboxTerminal(
  sessionID: string,
  inboxID: string,
  scope?: InboxRuntimeScope,
): void {
  terminalReceipts.delete(terminalKey(sessionID, inboxID, scope))
}

/**
 * Clear a terminal only when the authority snapshot is not older than the
 * receipt. Returns false when a newer terminal must keep ownership.
 */
export function clearInboxTerminalUnlessNewer(
  sessionID: string,
  inboxID: string,
  options?: InboxAuthorityOptions & { scope?: InboxRuntimeScope },
): boolean {
  const scope = options?.scope
  pruneTerminalReceipts(scope ?? captureInboxRuntimeScope())
  const receipt = terminalReceipts.get(terminalKey(sessionID, inboxID, scope))
  if (!receipt) return true
  const startedMark = options?.startedMark
  if (startedMark !== undefined && receipt.mark > startedMark) {
    return false
  }
  terminalReceipts.delete(terminalKey(sessionID, inboxID, scope))
  return true
}

export function getInboxTerminal(
  sessionID: string,
  inboxID: string,
  scope?: InboxRuntimeScope,
): InboxTerminalKind | null {
  pruneTerminalReceipts(scope ?? captureInboxRuntimeScope())
  return terminalReceipts.get(terminalKey(sessionID, inboxID, scope))?.kind ?? null
}

export function getInboxTerminalReceipt(
  sessionID: string,
  inboxID: string,
  scope?: InboxRuntimeScope,
): InboxTerminalReceipt | null {
  pruneTerminalReceipts(scope ?? captureInboxRuntimeScope())
  return terminalReceipts.get(terminalKey(sessionID, inboxID, scope)) ?? null
}

/** Test / runtime-switch seam: drop every terminal receipt. */
export function resetInboxTerminalReceiptsForTests(): void {
  terminalReceipts.clear()
  authorityClock = 0
}

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
    if (getInboxTerminal(item.sessionID, item.id)) {
      // Late HTTP after cancelled/consumed must not resurrect a ghost row.
      return false
    }
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
    return true
  },
  forget(sessionID, inboxID, terminal) {
    if (terminal) recordInboxTerminal(sessionID, inboxID, terminal)
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
    for (const id of promoted) {
      recordInboxTerminal(sessionID, id, "consumed")
    }
    set((state) => {
      const current = state.bySession[sessionID]
      if (!current?.length) return state
      const next = current.filter((entry) => !promoted.has(entry.id))
      if (next.length === current.length) return state
      return { bySession: writeSession(state.bySession, sessionID, next) }
    })
  },
  replaceFromAuthority(sessionID, items, options) {
    const startedMark = options?.startedMark
    const admitted: SessionInboxUser[] = []
    for (const item of items) {
      if (!clearInboxTerminalUnlessNewer(sessionID, item.id, { startedMark })) {
        // Newer terminal owns this id — stale snapshot must not re-admit.
        continue
      }
      admitted.push(item)
    }
    set((state) => {
      const next = admitted.map((item) => ({ ...item, requestID: item.id }))
      return { bySession: writeSession(state.bySession, sessionID, next) }
    })
  },
  updateDelivery(sessionID, inboxID, delivery) {
    set((state) => {
      if (getInboxTerminal(sessionID, inboxID)) return state
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
    return get().bySession[sessionID] ?? EMPTY_INBOX_OVERLAY_ITEMS
  },
}))

/**
 * HTTP / optimistic admission. No-ops when a terminal receipt already owns the
 * identity (cancelled or consumed) so late responses cannot resurrect ghosts.
 */
export function rememberUnpromotedInbox(item: SessionInboxUser): boolean {
  return useSessionInboxOverlayStore.getState().remember(item)
}

/**
 * Authoritative pending (GET inbox / enqueued SSE). Clears any prior terminal
 * for this id so a true server re-admit can surface again — unless a snapshot
 * `startedMark` is older than the terminal (stale GET loses).
 */
export function rememberUnpromotedInboxFromAuthority(
  item: SessionInboxUser,
  options?: InboxAuthorityOptions,
): boolean {
  if (!clearInboxTerminalUnlessNewer(item.sessionID, item.id, options)) {
    return false
  }
  return useSessionInboxOverlayStore.getState().remember(item)
}

export function forgetUnpromotedInbox(
  sessionID: string,
  inboxID: string,
  terminal?: InboxTerminalKind,
): void {
  useSessionInboxOverlayStore.getState().forget(sessionID, inboxID, terminal)
}

export function forgetPromotedInbox(sessionID: string, promotedIDs: readonly string[]): void {
  useSessionInboxOverlayStore.getState().forgetPromoted(sessionID, promotedIDs)
}

export function replaceInboxOverlayFromAuthority(
  sessionID: string,
  items: readonly SessionInboxUser[],
  options?: InboxAuthorityOptions,
): void {
  useSessionInboxOverlayStore.getState().replaceFromAuthority(sessionID, items, options)
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
  if (!sessionID) return EMPTY_INBOX_CHIPS
  return useSessionInboxOverlayStore.getState().list(sessionID).map(toChip)
}
