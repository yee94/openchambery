import { useCallback, useRef, useMemo, useState } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT, type State } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  type OptimisticItem,
} from "./optimistic"
import { dropCachedSessionMessageRecordsSnapshots, materializeSessionFromServer, useDirectoryStore, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import {
  shouldSkipSessionPrefetch,
  getSessionPrefetch,
  clearSessionPrefetch,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus } from "./materialization"
import { loadSessionMessagePage } from "./session-message-loader"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { sessionSyncCoordinator } from "./session-sync-coordinator"
import { loadSessionChildrenOnDemand, mergeSessionChildren } from "./session-children"
import { opencodeClient } from "@/lib/opencode/client"
import { waitForSessionStartupBarrier } from "@/lib/session-startup-barrier"
import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
  getMessageRefetchLimit,
} from "./session-message-policy"
import { fetchHostSessionTurnPageForPurpose } from "./session-turn-page-api"
import { reconcileActiveSessionStatusAfterMessagePull } from "./session-status-reconciliation"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const MAX_SEEN_DIRS = 30
const VSCODE_SESSION_CACHE_LIMIT = 4
// Mobile surfaces keep a slightly larger session cache than VS Code: with the
// previous limit of 4, routine session switching on a phone evicted sessions
// aggressively, and each eviction forced a full re-materialization tail-page
// pull on the next visit. 12 keeps the recency window big enough to cover a
// typical mobile session-switching session without measurably increasing
// resident memory (messages/parts remain the dominant footprint and are
// bounded per session by the tail page size).
const MOBILE_SESSION_CACHE_LIMIT = 12
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Shared across useSync() instances so cache eviction is based on app-level
// session recency, not whichever component happened to call sync first.
const seenByDirectory = new Map<string, Set<string>>()

/** Pagination meta; `limit` is cumulative authored-user **turns**, not messages. */
type SyncMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
  /** Latest cache load generation that established the cursor/complete pair. */
  loadGeneration?: number
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

const isConstrainedSessionRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getEffectiveSessionCacheLimit = () => {
  if (isVSCodeRuntime()) return VSCODE_SESSION_CACHE_LIMIT
  if (isMobileSurfaceRuntime()) return MOBILE_SESSION_CACHE_LIMIT
  return SESSION_CACHE_LIMIT
}
const getDefaultMeta = (): SyncMeta => ({
  limit: getInitialSessionTurnLimit(),
  cursor: undefined,
  complete: false,
  loading: false,
  loadGeneration: 0,
})

/**
 * Merge hook-local pagination meta with prefetch.
 *
 * - Local owns `loading` (in-flight pull in this hook).
 * - The newest cache load generation owns cursor and completion. This keeps a
 *   successful page response authoritative after local state from an older pull.
 * - A same-generation loading patch may borrow a still-valid cursor from the
 *   companion source until its response settles.
 */
export function resolveMergedSessionSyncMeta(
  local: SyncMeta | undefined,
  prefetch: SyncMeta | undefined,
): SyncMeta {
  if (!local && !prefetch) return getDefaultMeta()
  if (!local) return prefetch ?? getDefaultMeta()
  if (!prefetch) return local
  const localGeneration = local.loadGeneration ?? 0
  const prefetchGeneration = prefetch.loadGeneration ?? 0
  if (localGeneration !== prefetchGeneration) {
    const latest = localGeneration > prefetchGeneration ? local : prefetch
    const previous = latest === local ? prefetch : local
    return {
      limit: Math.max(local.limit, prefetch.limit),
      cursor: latest.complete ? undefined : (latest.cursor ?? previous.cursor),
      complete: latest.complete,
      loading: local.loading,
      loadGeneration: latest.loadGeneration,
    }
  }
  // Same-generation partial metadata keeps a cursor-bearing history available.
  const complete = local.complete && prefetch.complete
  const cursor = complete ? undefined : (local.cursor ?? prefetch.cursor)
  return {
    limit: Math.max(local.limit, prefetch.limit),
    cursor,
    complete,
    loading: local.loading,
    loadGeneration: local.loadGeneration,
  }
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

function getPrefetchMeta(directory: string, sessionID: string): SyncMeta | undefined {
  const info = getSessionPrefetch(directory, sessionID)
  if (!info) return undefined
  return {
    limit: info.limit,
    cursor: info.cursor,
    complete: info.complete,
    loading: false,
    loadGeneration: info.loadGeneration,
  }
}

function sortParts(parts: Part[]) {
  return parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
}

function isHeavyConstrainedSessionCache(state: Pick<State, "message" | "part">, sessionID: string): boolean {
  const messages = state.message[sessionID]
  if (!messages || messages.length === 0) return false
  // Message-count heaviness for cache eviction — not product turn limit.
  return messages.length > getMessageRefetchLimit()
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

  // Refs for mutable tracking. Pagination meta also bumps this hook-local
  // revision: ChatContainer derives the mobile load-older affordance through
  // this useSync instance, and a ref-only meta update previously waited for an
  // unrelated scroll render before the button appeared.
  const optimistic = useRef(new Map<string, Map<string, OptimisticItem>>())
  const meta = useRef(new Map<string, SyncMeta>())
  const [metaRevision, setMetaRevision] = useState(0)

  const keyFor = useCallback(
    (sessionID: string, targetDirectory = directory) => `${targetDirectory}\n${sessionID}`,
    [directory],
  )

  const getMetaFor = useCallback(
    (sessionID: string, targetDirectory = directory) => {
      const key = keyFor(sessionID, targetDirectory)
      // Prefer hook-local meta for loading ownership, but never let a local
      // entry that lost its cursor mask a still-valid prefetch cursor.
      // That mismatch shows canLoadEarlier (UI reads prefetch) while loadMore
      // silent-no-ops on `!m.cursor` — the mobile "load older" flash-then-stop.
      return resolveMergedSessionSyncMeta(
        meta.current.get(key),
        getPrefetchMeta(targetDirectory, sessionID),
      )
    },
    [directory, keyFor],
  )

  const setMetaFor = useCallback(
    (sessionID: string, patch: Partial<{ limit: number; cursor: string | undefined; complete: boolean; loading: boolean; loadGeneration: number }>, targetDirectory = directory) => {
      const key = keyFor(sessionID, targetDirectory)
      // Base on merged getMetaFor so loading:true patches keep the live cursor
      // from prefetch when the local map never received a full page settle.
      const current = getMetaFor(sessionID, targetDirectory)
      const next = { ...current, ...patch }
      const previous = meta.current.get(key)
      meta.current.set(key, next)
      if (
        !previous
        || previous.limit !== next.limit
        || previous.cursor !== next.cursor
        || previous.complete !== next.complete
        || previous.loading !== next.loading
        || previous.loadGeneration !== next.loadGeneration
      ) {
        setMetaRevision((revision) => revision + 1)
      }
    },
    [directory, keyFor, getMetaFor],
  )

  // Session cache eviction — two levels of LRU:
  // (1) across directories (max 30), (2) within a directory (SESSION_CACHE_LIMIT).

  // Evict all cached session data for given IDs from a directory's store
  const evict = useCallback(
    (dir: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      const dirStore = childStores.getChild(dir)
      if (!dirStore) return

      const current = dirStore.getState()
      const draft = {
        message: { ...current.message },
        part: { ...current.part },
        session_status: { ...current.session_status },
        session_status_observed_at: { ...current.session_status_observed_at },
        session_diff: { ...current.session_diff },
        todo: { ...current.todo },
        permission: { ...current.permission },
        question: { ...current.question },
      }
      dropSessionCaches(draft, sessionIDs)
      dropCachedSessionMessageRecordsSnapshots(dirStore, sessionIDs)
      dirStore.setState(draft)

      // Clear meta + optimistic + prefetch cache for evicted sessions
      for (const id of sessionIDs) {
        optimistic.current.delete(`${dir}\n${id}`)
        meta.current.delete(`${dir}\n${id}`)
      }
      clearSessionPrefetch(dir, sessionIDs)
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
        const state = targetStore.getState()
        const keep = new Set([sessionID, ...s, ...protectedIds])
        const prefetched = Object.keys(state.message).filter((id) => !keep.has(id))
        evict(targetDirectory, prefetched)

        // One very large inactive session can create memory/GC pressure that
        // makes later small-session switches feel slow. Keep it while active,
        // but do not retain it as a warm cache in constrained shells.
        const afterPrefetchEviction = getConstrainedCacheStateAfterPrefetchEviction({
          prefetched,
          state,
          targetStore,
        })
        const heavyInactive = Object.keys(afterPrefetchEviction.message).filter((id) => {
          if (id === sessionID || protectedIds.has(id)) return false
          return isHeavyConstrainedSessionCache(afterPrefetchEviction, id)
        })
        if (heavyInactive.length > 0) {
          for (const id of heavyInactive) s.delete(id)
          evict(targetDirectory, heavyInactive)
        }
      }
    },
    [childStores, directory, seenFor, evict, store],
  )

  // Optimistic operations
  const getOptimistic = useCallback(
    (sessionID: string, directoryOverride?: string | null): OptimisticItem[] => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      return [...(optimistic.current.get(key)?.values() ?? [])]
    },
    [directory],
  )

  const setOptimistic = useCallback(
    (sessionID: string, item: OptimisticItem, directoryOverride?: string | null) => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      const list = optimistic.current.get(key)
      const sorted: OptimisticItem = { message: item.message, parts: sortParts(item.parts) }
      if (list) {
        list.set(item.message.id, sorted)
      } else {
        optimistic.current.set(key, new Map([[item.message.id, sorted]]))
      }
    },
    [directory],
  )

  const clearOptimistic = useCallback(
    (sessionID: string, messageID?: string, directoryOverride?: string | null) => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      if (!messageID) {
        optimistic.current.delete(key)
        return
      }
      const list = optimistic.current.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.current.delete(key)
    },
    [directory],
  )

  const getOptimisticStore = useCallback(
    (directoryOverride?: string | null) => {
      if (!directoryOverride || directoryOverride === directory) return store
      return childStores.ensureChild(directoryOverride, { bootstrap: false })
    },
    [childStores, directory, store],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; purpose?: "initial" | "prepend"; isStale?: () => boolean; directory?: string }) => {
      const targetDirectory = options?.directory ?? directory
      const targetStore = targetDirectory === directory ? store : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      const m = getMetaFor(sessionID, targetDirectory)
      if (m.loading) {
        return
      }
      const stateBeforePull = targetStore.getState()
      const statusBeforePull = stateBeforePull.session_status?.[sessionID]
      const statusObservedAtBeforePull = stateBeforePull.session_status_observed_at?.[sessionID]
      const runtimeKey = getRuntimeKey()
      // Live events can append messages without growing m.limit. A resync
      // must cover everything already rendered or it can manufacture an
      // "older" cursor for history that is already on screen.
      const storeMessageCount = stateBeforePull.message[sessionID]?.length ?? 0
      const limit = getReactiveSessionMessageRequestLimit({
        before: options?.before,
        recordedLimit: m.limit,
        renderedMessageCount: storeMessageCount,
      })
      setMetaFor(sessionID, { loading: true }, targetDirectory)

      const result = await loadSessionMessagePage({
        purpose: options?.purpose ?? "initial",
        runtimeKey,
        directory: targetDirectory,
        sessionID,
        limit,
        before: options?.before,
        deps: {
          queryPage: async ({ limit: pageLimit, before }) => {
            // Host turn-page for:
            // - tail (no before): initial / recovery / materialize — 2 complete turns
            // - prepend + before: loadMore — surface turn budget + scanLimit
            // Bare `before` without purpose prepend stays on the official SDK path
            // so malformed callers never hit Host aggregation.
            const purpose = options?.purpose ?? "initial"
            const useHostTurnPage =
              !before
              || (purpose === "prepend" && Boolean(before))

            if (useHostTurnPage) {
              const page = await retry(async () =>
                fetchHostSessionTurnPageForPurpose({
                  sessionID,
                  directory: targetDirectory,
                  purpose: purpose === "prepend" ? "prepend" : purpose,
                  ...(before ? { before } : {}),
                }),
              )
              // Strict Host contract: records already validated; complete is authoritative.
              const cursor = page.cursor ?? undefined
              return {
                records: page.records.map((item) => ({
                  info: stripMessageDiffSnapshots(item.info),
                  parts: sortParts(item.parts ?? []),
                })),
                cursor,
                complete: page.complete,
                turnCount: page.turnCount,
              }
            }

            // Bare-before SDK fallback only: pageLimit is still a turn budget
            // for meta; upstream message scan uses a fixed message window.
            const response = await retry(async () => {
              const page = await scopedClient.session.messages({
                sessionID,
                directory: targetDirectory,
                limit: getMessageRefetchLimit(),
                before,
              })
              assertSdkSuccess(page, "session.messages")
              return page
            })
            const items = (response.data ?? []).filter((item: { info?: { id?: string } }) => !!item?.info?.id)
            const cursor = response.response?.headers?.get?.("x-next-cursor") ?? undefined
            return {
              records: items.map((item: { info: Message; parts?: Part[] }) => ({
                info: stripMessageDiffSnapshots(item.info),
                parts: sortParts(item.parts ?? []),
              })),
              cursor,
              complete: !cursor,
              turnCount: pageLimit,
            }
          },
          queryMessage: async ({ messageID }) => {
            const response = await retry(async () => {
              const exact = await scopedClient.session.message({ sessionID, messageID, directory: targetDirectory })
              assertSdkSuccess(exact, "session.message")
              return exact
            })
            const record = response.data
            if (!record?.info?.id) throw new Error("session.message failed: empty response")
            return {
              info: stripMessageDiffSnapshots(record.info),
              parts: sortParts(record.parts ?? []),
            }
          },
          // Pagination meta lives in this hook's ref, not the store, so it is
          // supplied here for the reducer's reference-stability comparison.
          getStoreState: () => {
            const current = targetStore.getState()
            const currentMeta = getMetaFor(sessionID, targetDirectory)
            return {
              message: current.message,
              part: current.part,
              meta: {
                limit: currentMeta.limit,
                cursor: currentMeta.cursor,
                complete: currentMeta.complete,
              },
            }
          },
          commitStore: (reduced) => {
            for (const messageID of reduced.confirmedOptimisticIDs) {
              clearOptimistic(sessionID, messageID, targetDirectory)
            }
            if (!reduced.messagesChanged && !reduced.partsChanged) return
            targetStore.setState({
              ...(reduced.messagesChanged ? { message: reduced.message } : {}),
              ...(reduced.partsChanged ? { part: reduced.part } : {}),
            })
          },
          getOptimistic: () => getOptimistic(sessionID, targetDirectory),
          isStale: options?.isStale,
          skipPartTypes: SKIP_PARTS,
        },
      })

      // The loader owns prefetch meta, load status, and error reporting for
      // skipped/failed pulls; only the hook-local pagination ref needs clearing.
      if (result.status !== "ready") {
        setMetaFor(sessionID, { loading: false }, targetDirectory)
        return
      }

      // The loader settles prefetch with a generation-gated response before it
      // returns. Read that canonical result so an older local request cannot
      // overwrite a newer page's cursor or complete boundary.
      const settledPrefetchMeta = getPrefetchMeta(targetDirectory, sessionID)
      setMetaFor(sessionID, {
        limit: settledPrefetchMeta?.limit ?? result.meta?.limit ?? result.messages.length,
        cursor: settledPrefetchMeta?.cursor ?? result.meta?.cursor,
        complete: settledPrefetchMeta?.complete ?? result.meta?.complete ?? false,
        loading: false,
        loadGeneration: settledPrefetchMeta?.loadGeneration,
      }, targetDirectory)
      await reconcileActiveSessionStatusAfterMessagePull({
        directory: targetDirectory,
        sessionID,
        store: targetStore,
        statusBeforePull,
        statusObservedAtBeforePull,
        hasMessages: result.recordCount > 0,
        isTailPage: !options?.before,
        isStale: options?.isStale,
      })
    },
    [childStores, store, getMetaFor, setMetaFor, getOptimistic, clearOptimistic, directory],
  )

  // Sync a session (load if not cached)
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
          const m = getMetaFor(sessionID, targetDirectory)
          const materialization = getSessionMaterializationStatus(current, sessionID)
          const cached = materialization.hasMessages && materialization.renderable && m.limit > 0
          const cachedReady = cached && hasSessionMessageBoundary(current.message[sessionID], m.complete)
          const prefetchInfo = !force ? getSessionPrefetch(targetDirectory, sessionID) : undefined
          const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found

          // Cache reuse is solely shouldSkipSessionPrefetch (complete/TTL/dirty).
          // Do not short-circuit on cachedReady+hasSession alone — that bypassed
          // dirty marks after live events and left half-finished reasoning/text.
          if (!force && shouldSkipSessionPrefetch({
            hasSession,
            hasMessages: cachedReady,
            info: prefetchInfo,
            pageSize: getInitialSessionTurnLimit(),
          })) return

          // After skip declined: dirty ready + hasSession still loads messages;
          // missing identity + ready messages only needs session.get.
          const shouldLoadMessages = Boolean(force || !cachedReady || hasSession)
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
    [childStores, keyFor, touch, getMetaFor, loadMessages, directory],
  )

  // Load more (pagination). Directory must match the session's workspace —
  // meta/prefetch cursor is keyed by directory, and a missing directory falls
  // through to default meta (no cursor) which would silent-no-op.
  // Cursor resolution uses getMetaFor (local ∪ prefetch) so a local loading
  // patch that never wrote cursor still finds the prefetch page cursor.
  const loadMore = useCallback(
    async (sessionID: string, options?: { directory?: string }) => {
      const targetDirectory = options?.directory ?? directory
      touch(sessionID, targetDirectory)
      let plan = resolveSessionHistoryLoadPlan(getMetaFor(sessionID, targetDirectory))
      // Concurrent pull — caller (timeline) may wait on historyLoading; a
      // second tap while busy remains a quiet no-op.
      if (plan.kind === "busy" || plan.kind === "exhausted") return
      if (plan.kind === "recover-cursor") {
        // Local meta can outlive/lose the cursor while history remains
        // incomplete. Re-materialize the newest turn window; it carries the
        // authoritative cursor for the following prepend request.
        await loadMessages(sessionID, {
          purpose: "initial",
          directory: targetDirectory,
        })
        const recoveredPrefetch = getSessionPrefetch(targetDirectory, sessionID)
        if (recoveredPrefetch?.status === "error") {
          throw new Error(recoveredPrefetch.error || "session history refresh failed")
        }
        plan = resolveSessionHistoryLoadPlan(getMetaFor(sessionID, targetDirectory))
        if (plan.kind === "busy" || plan.kind === "exhausted") return
        if (plan.kind === "recover-cursor") {
          throw new Error("session history cursor unavailable after refresh")
        }
      }
      if (plan.kind !== "prepend") return
      await loadMessages(sessionID, {
        before: plan.before,
        purpose: "prepend",
        directory: targetDirectory,
      })
      // loadMessages swallows transport failures into prefetch status=error so
      // syncSession does not tear down. Re-surface them here so explicit
      // load-earlier (mobile button / scroll) can toast instead of silent stop.
      const prefetch = getSessionPrefetch(targetDirectory, sessionID)
      if (prefetch?.status === "error") {
        throw new Error(prefetch.error || "session turn page failed")
      }
    },
    [directory, touch, getMetaFor, loadMessages],
  )

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

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; directory?: string | null; message: Message; parts: Part[] }) => {
      setOptimistic(input.sessionID, { message: input.message, parts: input.parts }, input.directory)
      const targetStore = getOptimisticStore(input.directory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      // Insert message
      const messages = message[input.sessionID] ? [...message[input.sessionID]] : []
      const result = Binary.search(messages, input.message.id, (m) => m.id)
      if (!result.found) messages.splice(result.index, 0, input.message)
      message[input.sessionID] = messages

      // Insert parts
      part[input.message.id] = sortParts(input.parts)

      targetStore.setState({ message, part })
    },
    [getOptimisticStore, setOptimistic],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      clearOptimistic(input.sessionID, input.messageID, input.directory)
      const targetStore = getOptimisticStore(input.directory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      const messages = message[input.sessionID]
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, input.messageID, (m) => m.id)
        if (result.found) {
          next.splice(result.index, 1)
          message[input.sessionID] = next
        }
      }
      delete part[input.messageID]

      targetStore.setState({ message, part })
    },
    [clearOptimistic, getOptimisticStore],
  )

  const optimisticConfirm = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      clearOptimistic(input.sessionID, input.messageID, input.directory)
    },
    [clearOptimistic],
  )

  /**
   * User-triggered transcript refresh. Drops the prefetch entry so the tail page
   * cannot be skipped as recently fetched, then pulls it from the server.
   * Throws when the pull fails so callers can surface the failure.
   */
  const refreshSessionTranscript = useCallback(
    async (sessionID: string, options?: { directory?: string }) => {
      if (!sessionID) return
      await waitForSessionStartupBarrier()
      const targetDirectory = options?.directory ?? directory
      if (!targetDirectory || targetDirectory === "global") return
      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })

      clearSessionPrefetch(targetDirectory, [sessionID])
      const status = await materializeSessionFromServer(targetDirectory, sessionID, targetStore, {
        reason: "manual-refresh",
      })
      if (status === "error") throw new Error("refresh transcript failed")
    },
    [childStores, directory, store],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadChildren,
      loadMore,
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
    [syncSession, loadChildren, loadMore, hasMore, isLoading, isComplete, refreshSessionTranscript, optimisticAdd, optimisticRemove, optimisticConfirm, metaRevision],
  )
}
