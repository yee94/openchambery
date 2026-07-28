import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/react-query"
import type { StoreApi } from "zustand"

import {
  fetchDirectorySessionStatusSnapshot,
  type DirectorySessionStatusSnapshot,
  type DirectorySessionStatusSnapshotLoader,
  type DirectorySessionStatusSnapshotObservation,
  type SessionStatusRuntimeProbe,
} from "@/queries/sessionStatusQueries"
import type { DirectoryStore } from "./child-store"

type SessionStatusResyncOptions = {
  isStale?: () => boolean
  loadSnapshot?: DirectorySessionStatusSnapshotLoader
  now?: () => number
  queryClient?: Pick<QueryClient, "fetchQuery">
  runtimeProbe?: SessionStatusRuntimeProbe
  transport?: string
}

type MessagePullStatusReconciliationInput = SessionStatusResyncOptions & {
  directory: string
  sessionID: string
  store: StoreApi<DirectoryStore>
  statusBeforePull: SessionStatus | undefined
  statusObservedAtBeforePull: number | undefined
  hasMessages: boolean
  isTailPage?: boolean
}

function toSessionStatus(
  status: DirectorySessionStatusSnapshot[string] | undefined,
): SessionStatus | undefined {
  if (!status) return undefined
  if (status.type === "idle" || status.type === "busy") {
    return { type: status.type }
  }
  if (
    status.type === "retry"
    && typeof status.attempt === "number"
    && typeof status.message === "string"
    && typeof status.next === "number"
  ) {
    return {
      type: "retry",
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    }
  }
  return undefined
}

function haveEquivalentStatuses(
  left: SessionStatus | undefined,
  right: SessionStatus,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// The directory-scoped snapshot lists active sessions. An absent candidate is
// therefore authoritatively idle for this snapshot boundary.
export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  observedAt?: number,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextObservedAt: Record<string, number> | undefined
    const draft = () => (next ??= { ...current })
    const observedDraft = () => (nextObservedAt ??= { ...state.session_status_observed_at })
    const confirmObservedAt = (sessionId: string) => {
      if (observedAt === undefined || state.session_status_observed_at[sessionId] === observedAt) return
      observedDraft()[sessionId] = observedAt
      changed = true
    }

    for (const sessionId of candidateSessionIds) {
      if (observedAt !== undefined && (state.session_status_observed_at[sessionId] ?? -Infinity) >= observedAt) {
        continue
      }
      const incoming = toSessionStatus(snapshot[sessionId])

      if (incoming && incoming.type !== "idle") {
        if (!haveEquivalentStatuses(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        confirmObservedAt(sessionId)
        continue
      }

      const existing = current[sessionId]
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
      confirmObservedAt(sessionId)
    }

    if (!next && !nextObservedAt) return state
    return {
      ...(next ? { session_status: next } : {}),
      ...(nextObservedAt ? { session_status_observed_at: nextObservedAt } : {}),
    }
  })

  return changed
}

export function collectSessionStatusSnapshotApplyIds(
  localCandidateSessionIds: string[],
  snapshot: DirectorySessionStatusSnapshot,
): string[] {
  return Array.from(new Set([
    ...localCandidateSessionIds,
    ...Object.keys(snapshot),
  ]))
}

export async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  options: SessionStatusResyncOptions = {},
): Promise<DirectorySessionStatusSnapshot | null> {
  if (options.isStale?.()) return null

  let observation: DirectorySessionStatusSnapshotObservation
  try {
    observation = await fetchDirectorySessionStatusSnapshot(directory, {
      client: options.queryClient,
      loadSnapshot: options.loadSnapshot,
      now: options.now,
      runtimeProbe: options.runtimeProbe,
      transport: options.transport,
    })
  } catch {
    return null
  }

  if (options.isStale?.()) return null

  const { snapshot, requestedAt } = observation
  const applyIds = collectSessionStatusSnapshotApplyIds(candidateSessionIds, snapshot)
  store.setState({ session_status_snapshot_at: requestedAt })
  applySessionStatusSnapshot(store, snapshot, applyIds, requestedAt)
  return snapshot
}

export async function reconcileActiveSessionStatusAfterMessagePull({
  directory,
  sessionID,
  store,
  statusBeforePull,
  statusObservedAtBeforePull,
  hasMessages,
  isTailPage = true,
  isStale,
  loadSnapshot,
  now,
  queryClient,
  runtimeProbe,
  transport,
}: MessagePullStatusReconciliationInput): Promise<DirectorySessionStatusSnapshot | null> {
  if (!isTailPage || !hasMessages || !statusBeforePull || statusBeforePull.type === "idle" || isStale?.()) {
    return null
  }

  // A live status transition during the message pull already supplied newer
  // authority. Reconcile only the exact active snapshot that began the pull.
  const current = store.getState()
  if (
    current.session_status?.[sessionID] !== statusBeforePull
    || current.session_status_observed_at?.[sessionID] !== statusObservedAtBeforePull
  ) {
    return null
  }

  return resyncDirectorySessionStatuses(directory, store, [sessionID], {
    isStale,
    loadSnapshot,
    now,
    queryClient,
    runtimeProbe,
    transport,
  })
}
