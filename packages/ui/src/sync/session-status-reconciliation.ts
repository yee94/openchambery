import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/react-query"
import type { StoreApi } from "zustand"

import type { SessionActiveResult } from "@/lib/opencode/client"
import {
  fetchDirectorySessionStatusSnapshot,
  type DirectorySessionStatusSnapshot,
  type DirectorySessionStatusSnapshotLoader,
  type DirectorySessionStatusSnapshotObservation,
  type SessionStatusRuntimeProbe,
} from "@/queries/sessionStatusQueries"
import {
  fetchSessionActiveSnapshot,
  type SessionActiveRuntimeProbe,
  type SessionActiveSnapshotLoader,
} from "@/queries/sessionActiveQueries"
import type { DirectoryStore } from "./child-store"

type SessionStatusResyncOptions = {
  isStale?: () => boolean
  loadSnapshot?: DirectorySessionStatusSnapshotLoader
  loadActive?: SessionActiveSnapshotLoader
  now?: () => number
  queryClient?: Pick<QueryClient, "fetchQuery">
  runtimeProbe?: SessionStatusRuntimeProbe & SessionActiveRuntimeProbe
  transport?: string
  /** Skip the process-global active probe (e.g. tests that only exercise legacy). */
  skipActive?: boolean
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

/**
 * Fuse process-global `v2.session.active` membership with a directory-scoped
 * legacy `/session/status` map.
 *
 * Scope: only directory-local IDs are written — the union of
 * `candidateSessionIds` and this directory's legacy status keys. Pure
 * membership IDs from other directories are never copied into this store.
 *
 * Rules (P0):
 * - active running + legacy retry → retry (preserve retry metadata)
 * - active running + busy / absent → busy
 * - active success + absent from membership → idle
 * - active unknown / unsupported → use legacy only
 * - both failed → preserve (caller must not apply)
 */
export function fuseActiveWithLegacyStatus(
  active: SessionActiveResult | null | undefined,
  legacy: DirectorySessionStatusSnapshot | null | undefined,
  candidateSessionIds: string[],
): {
  snapshot: DirectorySessionStatusSnapshot | null
  source: "fused" | "legacy" | "none"
} {
  if (!active || active.state === "unsupported" || active.state === "unknown") {
    if (!legacy) return { snapshot: null, source: "none" }
    return { snapshot: legacy, source: "legacy" }
  }

  // active.state === "supported"
  // Directory-local scope only: candidates + this directory's legacy keys.
  // Global membership is consulted for running/idle decisions but foreign IDs
  // must never appear in the fused snapshot for this child store.
  const membership = active.membership
  const legacyMap = legacy ?? {}
  const ids = new Set([
    ...candidateSessionIds,
    ...Object.keys(legacyMap),
  ])

  if (ids.size === 0) {
    // No directory-local IDs to apply (e.g. empty candidates, failed legacy,
    // and active membership only listing other-directory sessions).
    return { snapshot: null, source: "none" }
  }

  const fused: DirectorySessionStatusSnapshot = {}
  for (const sessionId of ids) {
    const isRunning = Object.prototype.hasOwnProperty.call(membership, sessionId)
    const legacyStatus = toSessionStatus(legacyMap[sessionId])

    if (isRunning) {
      if (legacyStatus?.type === "retry") {
        fused[sessionId] = legacyStatus
      } else {
        fused[sessionId] = { type: "busy" }
      }
      continue
    }

    // Authoritatively idle when active snapshot succeeds and session is absent.
    // Do not copy a stale legacy busy for sessions outside the active set.
    if (legacyStatus?.type === "retry") {
      // Retry without active membership is still not running — idle wins.
      fused[sessionId] = { type: "idle" }
    } else if (legacyStatus?.type === "busy") {
      fused[sessionId] = { type: "idle" }
    } else if (legacyStatus?.type === "idle") {
      fused[sessionId] = { type: "idle" }
    } else {
      // Candidate with no legacy entry → idle
      fused[sessionId] = { type: "idle" }
    }
  }

  return { snapshot: fused, source: "fused" }
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
      // Unknown session IDs must not invent child-store keys without a known
      // candidate or snapshot membership — callers pass the union apply set.
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

  const transport = options.transport
  const runtimeProbe = options.runtimeProbe
  const queryClient = options.queryClient
  const now = options.now

  // Capture observation times before either request so SSE that lands during
  // the in-flight window keeps precedence via session_status_observed_at.
  let legacyObservation: DirectorySessionStatusSnapshotObservation | null = null
  let activeResult: SessionActiveResult | null = null
  let activeRequestedAt: number | undefined

  const legacyPromise = (async () => {
    try {
      return await fetchDirectorySessionStatusSnapshot(directory, {
        client: queryClient,
        loadSnapshot: options.loadSnapshot,
        now,
        runtimeProbe,
        transport,
      })
    } catch {
      return null
    }
  })()

  const activePromise = options.skipActive
    ? Promise.resolve(null)
    : (async () => {
      try {
        return await fetchSessionActiveSnapshot({
          client: queryClient,
          loadActive: options.loadActive,
          now,
          runtimeProbe,
          transport,
        })
      } catch {
        return null
      }
    })()

  const [legacy, active] = await Promise.all([legacyPromise, activePromise])
  legacyObservation = legacy
  if (active) {
    activeResult = active.result
    activeRequestedAt = active.requestedAt
  }

  if (options.isStale?.()) return null

  const legacySnapshot = legacyObservation?.snapshot ?? null

  // Both paths unusable → preserve prior status (do not advance snapshot_at).
  // Active supported with a failed legacy load still fuses (empty legacy map).
  const activeUsable = activeResult?.state === "supported"
  const legacyUsable = legacySnapshot !== null
  if (!legacyUsable && !activeUsable) {
    return null
  }

  const { snapshot: fused, source } = fuseActiveWithLegacyStatus(
    activeResult,
    legacySnapshot,
    candidateSessionIds,
  )

  if (!fused || source === "none") {
    return null
  }

  // Authority boundary: prefer the earlier request-start so SSE that arrived
  // after either request started still wins when observed_at is newer.
  const timestamps = [
    legacyObservation?.requestedAt,
    activeRequestedAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (timestamps.length === 0) {
    return null
  }
  const requestedAt = Math.min(...timestamps)

  const applyIds = collectSessionStatusSnapshotApplyIds(candidateSessionIds, fused)
  // No directory-local IDs → preserve prior status; do not advance snapshot_at.
  // (e.g. empty candidates + failed legacy + active only listing foreign IDs)
  if (applyIds.length === 0) {
    return null
  }
  // Only advance snapshot_at on a successful authoritative boundary.
  store.setState({ session_status_snapshot_at: requestedAt })
  applySessionStatusSnapshot(store, fused, applyIds, requestedAt)
  return fused
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
  loadActive,
  now,
  queryClient,
  runtimeProbe,
  transport,
  skipActive,
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
    loadActive,
    now,
    queryClient,
    runtimeProbe,
    transport,
    skipActive,
  })
}
