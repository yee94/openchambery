import { useCallback, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import type { State } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import { dropCachedSessionMessageRecordsSnapshots, useDirectoryStore, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import {
  applyTranscriptCommand,
  fetchTranscriptPreviousPage,
  ensureTranscriptInitial,
  getTranscriptRepository,
  purgeTranscriptSession,
  refreshTranscriptFromAuthority,
  transcriptScope,
} from "./transcript-repository-runtime"
import { stripSessionDiffSnapshots } from "./sanitize"
import {
  getEffectiveSessionCacheLimit,
  isConstrainedSessionRuntime,
} from "./session-cache-limits"
import type { SessionHistoryBoundary } from "./types"
import { sessionSyncCoordinator } from "./session-sync-coordinator"
import { loadSessionChildrenOnDemand, mergeSessionChildren } from "./session-children"
import { opencodeClient } from "@/lib/opencode/client"
import { waitForSessionStartupBarrier } from "@/lib/session-startup-barrier"
import { getRuntimeKey } from "@/lib/runtime-switch"
import {
  SESSION_AUTHORITY_REVALIDATE_WINDOW_MS,
  isSessionAuthorityRevalidateFresh,
} from "./session-authority-revalidate"

export { SESSION_AUTHORITY_REVALIDATE_WINDOW_MS }
import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
  getMessageRefetchLimit,
} from "./session-message-policy"
import { reconcileActiveSessionStatusAfterMessagePull } from "./session-status-reconciliation"
import { seedSessionTodosFromHydratedTranscript } from "./session-todo-projection"

const MAX_SEEN_DIRS = 30

/** User refresh must not fight an in-flight SSE turn. */
export function isUserTranscriptRefreshBlocked(
  statusType: string | undefined | null,
): boolean {
  return statusType === "busy" || statusType === "retry"
}

// Shared across useSync() instances so cache eviction is based on app-level
// session recency, not whichever component happened to call sync first.
const seenByDirectory = new Map<string, Set<string>>()

/**
 * Thin read-model over the child-store history boundary; `limit` is cumulative
 * authored-user **turns**, not messages. Every field except `loading` comes
 * from the boundary — there is no hook-local pagination fact.
 */
type SyncMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
}

/**
 * Adapt a repository history boundary (+ request loading flag) into the flat
 * SyncMeta read shape. Cursor/complete/limit always come from the boundary.
 */
export function syncMetaFromBoundary(
  boundary: SessionHistoryBoundary,
  loading = false,
): SyncMeta {
  return {
    limit: boundary.loadedTurns,
    cursor: boundary.kind === "has-more" ? boundary.cursor : undefined,
    complete: boundary.kind === "exhausted",
    loading,
  }
}

export type SessionHistoryLoadPlan =
  | { kind: "busy" }
  | { kind: "exhausted" }
  | { kind: "recover-cursor" }
  | { kind: "prepend"; before: string }

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): void {
  if (!result.error) return
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

/**
 * Plan explicit history pagination from the latest merged meta.
 *
 * Incomplete history without a cursor is recoverable: refresh the authoritative
 * tail once, then prepend from its cursor. The prior direct return/throw made
 * the mobile button look broken whenever a stale local meta entry lost cursor.
 */
export function resolveSessionHistoryLoadPlan(
  meta: Pick<SyncMeta, "cursor" | "complete" | "loading">,
): SessionHistoryLoadPlan {
  if (meta.loading) return { kind: "busy" }
  if (meta.complete) return { kind: "exhausted" }
  if (!meta.cursor) return { kind: "recover-cursor" }
  return { kind: "prepend", before: meta.cursor }
}

function isHeavyConstrainedSessionCache(directory: string, sessionID: string): boolean {
  const repository = getTranscriptRepository()
  if (!repository) return false
  const data = repository.getTranscript(transcriptScope(directory, sessionID))
  if (data.messageOrder.length === 0) return false
  // Message-count heaviness for cache eviction — not product turn limit.
  return data.messageOrder.length > getMessageRefetchLimit()
}

function isUserMessage(message: Message): boolean {
  const info = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof info.clientRole === "string" ? info.clientRole : info.role
  return role === "user"
}

export function hasUserMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some(isUserMessage))
}

export function hasSessionMessageBoundary(messages: Message[] | undefined, complete: boolean): boolean {
  return complete || hasUserMessage(messages)
}

export function shouldFetchSessionForRenderableSync(input: {
  hasSession: boolean
  shouldLoadMessages: boolean
  force?: boolean
}): boolean {
  return Boolean(input.force) || !input.hasSession || input.shouldLoadMessages
}

/**
 * Product turn budget for a reactive pull.
 * `recordedLimit` is cumulative turns already loaded; message counts are ignored.
 */
export function getReactiveSessionMessageRequestLimit(input: {
  before?: string
  recordedLimit: number
  /** @deprecated Ignored — product limit is turns, not messages. */
  renderedMessageCount?: number
}): number {
  if (input.before) return getHistorySessionTurnLimit()
  return Math.max(getInitialSessionTurnLimit(), input.recordedLimit)
}

export function getConstrainedCacheStateAfterPrefetchEviction<T>(input: {
  prefetched: string[]
  state: T
  targetStore: { getState: () => T }
}): T {
  return input.prefetched.length > 0 ? input.targetStore.getState() : input.state
}

export function commitSessionIdentity(
  store: ReturnType<typeof useDirectoryStore>,
  sessionID: string,
  session: State["session"][number],
): void {
  const current = store.getState()
  const sessions = [...current.session]
  const index = Binary.search(sessions, sessionID, (item) => item.id)
  if (index.found) {
    sessions[index.index] = session
  } else {
    sessions.splice(index.index, 0, session)
  }
  store.setState({ session: sessions })
}

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// Message loading, pagination, optimistic updates
// ---------------------------------------------------------------------------

export function useSync() {
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()

  // Ticket 09: pagination + request lifecycle live in Query repository.
  // No loadingRef / prefetch / optimistic shadow maps on the production path.
  const keyFor = useCallback(
    (sessionID: string, targetDirectory = directory) => `${targetDirectory}\n${sessionID}`,
    [directory],
  )

  // Thin compatibility adapter from repository pagination + request state.
  const getMetaFor = useCallback(
    (sessionID: string, targetDirectory = directory): SyncMeta => {
      const repository = getTranscriptRepository()
      if (!repository || !sessionID) {
        return syncMetaFromBoundary({ kind: "unknown", loadedTurns: 0 }, false)
      }
      const scope = transcriptScope(targetDirectory, sessionID)
      const pagination = repository.getPagination(scope)
      const request = repository.getRequestState?.(scope)
      return syncMetaFromBoundary(pagination.boundary, request?.status === "loading")
    },
    [directory],
  )

  // Session cache eviction — two levels of LRU:
  // (1) across directories (max 30), (2) within a directory (platform capacity).

  // Evict non-transcript session caches from the directory store and purge
  // Query transcript families (Ticket 09 domain boundary).
  const evict = useCallback(
    (dir: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      const dirStore = childStores.getChild(dir)
      if (!dirStore) return

      const current = dirStore.getState()
      const draft = {
        session_status: { ...current.session_status },
        session_status_observed_at: { ...current.session_status_observed_at },
        session_error_at: { ...current.session_error_at },
        session_diff: { ...current.session_diff },
        todo: { ...current.todo },
        permission: { ...current.permission },
        question: { ...current.question },
      }
      // dropSessionCaches clears non-transcript domains; transcript purge is Query.
      dropSessionCaches(draft as Parameters<typeof dropSessionCaches>[0], sessionIDs)
      dropCachedSessionMessageRecordsSnapshots(dirStore, sessionIDs)
      dirStore.setState(draft)

      for (const id of sessionIDs) {
        purgeTranscriptSession(dir, id)
      }
    },
    [childStores],
  )

  // Get or create the seen-set for a directory. LRU reorder on access.
  // When seen directories exceed MAX_SEEN_DIRS, evict the oldest directory's caches.
  // LRU reorder on access. Evicts oldest directory when exceeding MAX_SEEN_DIRS.
  const seenFor = useCallback((targetDirectory = directory) => {
    const existing = seenByDirectory.get(targetDirectory)
    if (existing) {
      // LRU reorder: delete + re-insert moves to end (most recent)
      seenByDirectory.delete(targetDirectory)
      seenByDirectory.set(targetDirectory, existing)
      return existing
    }
    const created = new Set<string>()
    seenByDirectory.set(targetDirectory, created)

    // Evict oldest directories if over limit
    while (seenByDirectory.size > MAX_SEEN_DIRS) {
      const first = seenByDirectory.keys().next().value
      if (!first) break
      const staleSessionIds = [...(seenByDirectory.get(first) ?? [])]
      seenByDirectory.delete(first)
      evict(first, staleSessionIds)
    }

    return created
  }, [directory, evict])

  // Touch a session — triggers both directory-level and session-level eviction
  const touch = useCallback(
    (sessionID: string, targetDirectory = directory) => {
      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const s = seenFor(targetDirectory)
      const protectedIds = getProtectedSessionCacheIds(targetStore.getState())
      const cacheLimit = getEffectiveSessionCacheLimit()
      const stale = pickSessionCacheEvictions({
        seen: s,
        keep: sessionID,
        limit: cacheLimit,
        preserve: protectedIds,
      })
      evict(targetDirectory, stale)

      if (isConstrainedSessionRuntime()) {
        // Ticket 09: heavy inactive detection from Query inventory / seen set.
        const keep = new Set([sessionID, ...s, ...protectedIds])
        const repository = getTranscriptRepository() as
          | (ReturnType<typeof getTranscriptRepository> & {
            getCacheBudget?: () => {
              listCanonical: (filter?: { directory?: string }) => Array<{
                scope: { sessionID: string }
              }>
            }
          })
          | null
        const inventory = repository?.getCacheBudget?.().listCanonical({ directory: targetDirectory })
          ?? []
        const inventoryIds = inventory.map((entry) => entry.scope.sessionID)
        const candidates = inventoryIds.length > 0 ? inventoryIds : Array.from(s)
        const heavyInactive = candidates.filter((id) => {
          if (id === sessionID || keep.has(id)) return false
          return isHeavyConstrainedSessionCache(targetDirectory, id)
        })
        if (heavyInactive.length > 0) {
          for (const id of heavyInactive) s.delete(id)
          evict(targetDirectory, heavyInactive)
        }
      }
    },
    [childStores, directory, seenFor, evict, store],
  )

  // Ticket 09: loadMessages is ensure-tail / fetch-previous via Query only.
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; purpose?: "initial" | "prepend"; isStale?: () => boolean; directory?: string }) => {
      const targetDirectory = options?.directory ?? directory
      if (!sessionID || !targetDirectory || targetDirectory === "global") return
      const targetStore = targetDirectory === directory ? store : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const stateBeforePull = targetStore.getState()
      const statusBeforePull = stateBeforePull.session_status?.[sessionID]
      const statusObservedAtBeforePull = stateBeforePull.session_status_observed_at?.[sessionID]

      try {
        if (options?.purpose === "prepend" || options?.before) {
          await fetchTranscriptPreviousPage(targetDirectory, sessionID)
        } else {
          await ensureTranscriptInitial(targetDirectory, sessionID)
        }
      } catch {
        return
      }
      if (options?.isStale?.()) return

      const repository = getTranscriptRepository()
      const transcript = repository?.getTranscript(transcriptScope(targetDirectory, sessionID))
      seedSessionTodosFromHydratedTranscript({
        directory: targetDirectory,
        sessionID,
        store: targetStore,
        transcript,
        isStale: options?.isStale,
      })
      await reconcileActiveSessionStatusAfterMessagePull({
        directory: targetDirectory,
        sessionID,
        store: targetStore,
        statusBeforePull,
        statusObservedAtBeforePull,
        hasMessages: (transcript?.messageOrder.length ?? 0) > 0,
        isTailPage: !options?.before,
        isStale: options?.isStale,
      })
    },
    [childStores, store, directory],
  )

  // Sync a session (load if not cached) — Ticket 09: transcript via Query ensure.
  const syncSession = useCallback(
    async (sessionID: string, options?: boolean | { force?: boolean; directory?: string }) => {
      await waitForSessionStartupBarrier()
      const force = typeof options === "boolean" ? options : options?.force
      const targetDirectory = typeof options === "object" ? options.directory ?? directory : directory
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      touch(sessionID, targetDirectory)
      const key = keyFor(sessionID, targetDirectory)
      return sessionSyncCoordinator.run({
        scope: targetStore,
        key,
        request: async (isStale) => {
          const current = targetStore.getState()
          const repository = getTranscriptRepository()
          const scope = transcriptScope(targetDirectory, sessionID)
          const hasTranscript = repository?.hasSession?.(scope)
            ?? ((repository?.getTranscript(scope).messageOrder.length ?? 0) > 0)
          const pagination = repository?.getPagination(scope)
          const boundary = pagination?.boundary ?? { kind: "unknown" as const, loadedTurns: 0 }
          const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
          const request = repository?.getRequestState?.(scope)
          // Reuse a resolved transcript with a known boundary unless forced,
          // dirty/error, or the enter-and-sync window has elapsed.
          if (
            !force
            && hasTranscript
            && boundary.kind !== "unknown"
            && request?.status !== "error"
            && hasSession
            && isSessionAuthorityRevalidateFresh(targetDirectory, sessionID)
          ) {
            seedSessionTodosFromHydratedTranscript({
              directory: targetDirectory,
              sessionID,
              store: targetStore,
              isStale,
            })
            return
          }

          const shouldLoadMessages = Boolean(force || !hasTranscript || hasSession)
          const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
          await Promise.all([
            shouldFetchSession
              ? (async () => {
                  try {
                    const result = await retry(async () => {
                      const response = await scopedClient.session.get({ sessionID, directory: targetDirectory })
                      assertSdkSuccess(response, "session.get")
                      return response
                    })
                    if (result.data && !isStale()) {
                      const nextSession = stripSessionDiffSnapshots(result.data)
                      if (!isStale()) {
                        commitSessionIdentity(targetStore, sessionID, nextSession)
                      }
                    }
                  } catch (e) {
                    console.error("[sync] failed to fetch session", sessionID, e)
                  }
                })()
              : Promise.resolve(),
            shouldLoadMessages ? loadMessages(sessionID, { isStale, directory: targetDirectory }) : Promise.resolve(),
          ])
        },
      })
    },
    [childStores, keyFor, touch, loadMessages, directory],
  )

  // Ticket 09 batch 2: loadMore facade removed — Chat/Context call
  // fetchTranscriptPreviousPage / ensureTranscriptInitial directly.

  const loadChildren = useCallback(
    async (sessionID: string, directoryOverride?: string | null) => {
      const targetDirectory = directoryOverride || directory
      if (!sessionID || !targetDirectory) return
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      const incoming = await loadSessionChildrenOnDemand({
        runtimeKey: getRuntimeKey(),
        directory: targetDirectory,
        sessionID,
        request: async () => {
          const response = await scopedClient.session.children({ sessionID, directory: targetDirectory })
          assertSdkSuccess(response, "session.children")
          return (response.data ?? []) as import('@opencode-ai/sdk/v2').Session[]
        },
      })
      targetStore.setState((state) => {
        const sessions = mergeSessionChildren(state.session, incoming, sessionID)
        if (sessions === state.session) return state
        return { session: sessions, limit: Math.max(state.limit, sessions.length) }
      })
    },
    [childStores, directory],
  )

  const hasMore = useCallback(
    (sessionID: string, options?: { directory?: string }) => {
      const m = getMetaFor(sessionID, options?.directory ?? directory)
      return !m.complete && !!m.cursor
    },
    [directory, getMetaFor],
  )

  const isLoading = useCallback(
    (sessionID: string, options?: { directory?: string }) =>
      getMetaFor(sessionID, options?.directory ?? directory).loading,
    [directory, getMetaFor],
  )

  // True only when a fetch has positively confirmed the history is fully
  // loaded (no next cursor). Distinct from !hasMore(), which is also true for
  // sessions whose meta simply hasn't been populated yet.
  const isComplete = useCallback(
    (sessionID: string, options?: { directory?: string }) =>
      getMetaFor(sessionID, options?.directory ?? directory).complete,
    [directory, getMetaFor],
  )

  // Optimistic commands — Ticket 09: Query repository only (no shadow map).
  const optimisticAdd = useCallback(
    (input: { sessionID: string; directory?: string | null; message: Message; parts: Part[] }) => {
      const targetDirectory = input.directory || directory
      applyTranscriptCommand(transcriptScope(targetDirectory, input.sessionID), {
        type: "optimistic-add",
        message: input.message,
        parts: input.parts,
      })
    },
    [directory],
  )

  const optimisticRemove = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      const targetDirectory = input.directory || directory
      applyTranscriptCommand(transcriptScope(targetDirectory, input.sessionID), {
        type: "optimistic-remove",
        messageID: input.messageID,
      })
    },
    [directory],
  )

  const optimisticConfirm = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      const targetDirectory = input.directory || directory
      applyTranscriptCommand(transcriptScope(targetDirectory, input.sessionID), {
        type: "optimistic-confirm",
        messageID: input.messageID,
      })
    },
    [directory],
  )

  /**
   * User-triggered transcript refresh — fetch first, reconcile the tail on success.
   * Failure keeps the prior transcript. Busy/retry refuses so SSE keeps the live turn.
   */
  const refreshSessionTranscript = useCallback(
    async (sessionID: string, options?: { directory?: string }) => {
      if (!sessionID) return
      await waitForSessionStartupBarrier()
      const targetDirectory = options?.directory ?? directory
      if (!targetDirectory || targetDirectory === "global") return
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      const liveType = targetStore.getState().session_status?.[sessionID]?.type
      if (isUserTranscriptRefreshBlocked(liveType)) {
        throw new Error("refresh transcript busy")
      }
      try {
        await refreshTranscriptFromAuthority(targetDirectory, sessionID)
        seedSessionTodosFromHydratedTranscript({
          directory: targetDirectory,
          sessionID,
          store: targetStore,
        })
      } catch (error) {
        if (error instanceof Error && error.message === "refresh transcript busy") {
          throw error
        }
        throw new Error("refresh transcript failed")
      }
    },
    [childStores, directory],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadChildren,
      hasMore,
      isLoading,
      isComplete,
      refreshSessionTranscript,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, loadChildren, hasMore, isLoading, isComplete, refreshSessionTranscript, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}
