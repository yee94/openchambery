import { useCallback, useRef, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT, type State } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  mergeOptimisticPage,
  type OptimisticItem,
} from "./optimistic"
import { dropCachedSessionMessageRecordsSnapshots, useDirectoryStore, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import {
  shouldSkipSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
  clearSessionPrefetch,
  beginSessionMessageLoad,
  failSessionMessageLoad,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { sessionLoadDebug } from "./session-load-debug"
import { loadSessionMessage, loadSessionMessagePage, recoverAssistantTailBoundary } from "./session-message-loader"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { sessionSyncCoordinator } from "./session-sync-coordinator"
import { loadSessionChildrenOnDemand, mergeSessionChildren } from "./session-children"
import { opencodeClient } from "@/lib/opencode/client"
import { waitForSessionStartupBarrier } from "@/lib/session-startup-barrier"
import { getInitialSessionMessagePageSize } from "./session-message-page-size"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const HISTORY_MESSAGE_PAGE_SIZE = 30
const MAX_SEEN_DIRS = 30
const VSCODE_SESSION_CACHE_LIMIT = 4
const MOBILE_SESSION_CACHE_LIMIT = 4
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Shared across useSync() instances so cache eviction is based on app-level
// session recency, not whichever component happened to call sync first.
const seenByDirectory = new Map<string, Set<string>>()

type SyncMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
}

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
const getDefaultMeta = (): SyncMeta => ({ limit: getInitialSessionMessagePageSize(), cursor: undefined, complete: false, loading: false })

function getPrefetchMeta(directory: string, sessionID: string): SyncMeta | undefined {
  const info = getSessionPrefetch(directory, sessionID)
  if (!info) return undefined
  return {
    limit: info.limit,
    cursor: info.cursor,
    complete: info.complete,
    loading: false,
  }
}

function sortParts(parts: Part[]) {
  return parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
}

function isHeavyConstrainedSessionCache(state: Pick<State, "message" | "part">, sessionID: string): boolean {
  const messages = state.message[sessionID]
  if (!messages || messages.length === 0) return false
  return messages.length > getInitialSessionMessagePageSize()
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

export function getReactiveSessionMessageRequestLimit(input: {
  before?: string
  recordedLimit: number
  renderedMessageCount: number
}): number {
  if (input.before) return HISTORY_MESSAGE_PAGE_SIZE
  return Math.max(getInitialSessionMessagePageSize(), input.recordedLimit, input.renderedMessageCount)
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

  // Refs for mutable tracking (no re-renders)
  const optimistic = useRef(new Map<string, Map<string, OptimisticItem>>())
  const meta = useRef(new Map<string, SyncMeta>())

  const keyFor = useCallback(
    (sessionID: string, targetDirectory = directory) => `${targetDirectory}\n${sessionID}`,
    [directory],
  )

  const getMetaFor = useCallback(
    (sessionID: string, targetDirectory = directory) => {
      const key = keyFor(sessionID, targetDirectory)
      return meta.current.get(key) ?? getPrefetchMeta(targetDirectory, sessionID) ?? getDefaultMeta()
    },
    [directory, keyFor],
  )

  const setMetaFor = useCallback(
    (sessionID: string, patch: Partial<{ limit: number; cursor: string | undefined; complete: boolean; loading: boolean }>, targetDirectory = directory) => {
      const key = keyFor(sessionID, targetDirectory)
      const current = meta.current.get(key) ?? getPrefetchMeta(targetDirectory, sessionID) ?? getDefaultMeta()
      meta.current.set(key, { ...current, ...patch })
    },
    [directory, keyFor],
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

  // Fetch messages from API
  const fetchMessages = useCallback(
    async (sessionID: string, limit: number, before?: string, runtimeKey = getRuntimeKey(), targetDirectory = directory) => {
      const startedAt = performance.now()
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      sessionLoadDebug("reactive-request-start", { sessionID, directory: targetDirectory, limit, before: before ?? null })
      const result = await loadSessionMessagePage({
        runtimeKey,
        directory: targetDirectory,
        sessionID,
        limit,
        before,
        request: () => retry(async () => {
          const response = await scopedClient.session.messages({ sessionID, directory: targetDirectory, limit, before })
          assertSdkSuccess(response, "session.messages")
          return response
        }),
      })
      const items = (result.data ?? []).filter((x: { info?: { id?: string } }) => !!x?.info?.id)
      const session = items
        .map((x: { info: Message }) => stripMessageDiffSnapshots(x.info))
        .sort((a: Message, b: Message) => cmp(a.id, b.id))
      const part = items.map((x: { info: { id: string }; parts: Part[] }) => ({
        id: x.info.id,
        part: sortParts(x.parts),
      }))
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      sessionLoadDebug("reactive-request-response", {
        sessionID,
        directory: targetDirectory,
        limit,
        before: before ?? null,
        records: session.length,
        hasCursor: Boolean(cursor),
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      })
      return { session, part, cursor, complete: !cursor }
    },
    [directory],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; mode?: "replace" | "prepend"; isStale?: () => boolean; directory?: string }) => {
      const targetDirectory = options?.directory ?? directory
      const targetStore = targetDirectory === directory ? store : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      const m = getMetaFor(sessionID, targetDirectory)
      if (m.loading) {
        sessionLoadDebug("reactive-load-deduped", { sessionID, directory: targetDirectory, before: options?.before ?? null })
        return
      }
      const runtimeKey = getRuntimeKey()
      // Live events can append messages without growing m.limit. A resync
      // must cover everything already rendered or it can manufacture an
      // "older" cursor for history that is already on screen.
      const storeMessageCount = targetStore.getState().message[sessionID]?.length ?? 0
      const limit = getReactiveSessionMessageRequestLimit({
        before: options?.before,
        recordedLimit: m.limit,
        renderedMessageCount: storeMessageCount,
      })
      setMetaFor(sessionID, { loading: true }, targetDirectory)
      beginSessionMessageLoad(targetDirectory, sessionID, limit, runtimeKey)
      const startedAt = performance.now()

      try {
        // Commit a fetched page to the store: merge optimistic items, run
        // materialization, and write the result so the UI can render it.
        // Returns the committed meta so the caller can update pagination
        // state once at the end. The store write happens here (per page) so
        // the hydrating skeleton disappears after the first fetch instead of
        // waiting for the full expansion sequence.
        const commitMessagesToStore = (
          page: Awaited<ReturnType<typeof fetchMessages>>,
          mode: "replace" | "prepend" | undefined,
          isStale?: () => boolean,
        ) => {
          if (isStale?.()) {
            return { messages: [], cursor: page.cursor, complete: page.complete }
          }

          const items = getOptimistic(sessionID, targetDirectory)
          const merged = mergeOptimisticPage(page, items)
          for (const messageID of merged.confirmed) {
            clearOptimistic(sessionID, messageID, targetDirectory)
          }

          const current = targetStore.getState()
          const materialized = materializeSessionSnapshots(
            current,
            sessionID,
            merged.session.map((info) => ({
              info,
              parts: merged.part.find((item) => item.id === info.id)?.part ?? [],
            })),
            { skipPartTypes: SKIP_PARTS, mode: mode === "prepend" ? "prepend" : "merge" },
          )

          // materializeSessionSnapshots is synchronous today, so this check
          // is defense-in-depth: it guards the store write if materialization
          // ever becomes async or yields between the check above and setState.
          if (isStale?.()) {
            return { messages: [], cursor: merged.cursor, complete: merged.complete }
          }

          if (materialized.messagesChanged || materialized.partsChanged) {
            targetStore.setState({
              ...(materialized.messagesChanged ? { message: materialized.message } : {}),
              ...(materialized.partsChanged ? { part: materialized.part } : {}),
            })
          }
          return { messages: materialized.messages, cursor: merged.cursor, complete: merged.complete }
        }

        const page = await fetchMessages(sessionID, limit, options?.before, runtimeKey, targetDirectory)
        const recovered = options?.before || page.complete
          ? page
          : await recoverAssistantTailBoundary({
              records: page.session.map((info) => ({
                info,
                parts: page.part.find((item) => item.id === info.id)?.part ?? [],
              })),
              complete: page.complete,
              requestMessage: async (messageID) => {
                const response = await loadSessionMessage({
                  runtimeKey,
                  directory: targetDirectory,
                  sessionID,
                  messageID,
                  request: async () => {
                    const result = await scopedClient.session.message({ sessionID, messageID, directory: targetDirectory })
                    assertSdkSuccess(result, "session.message")
                    return result
                  },
                })
                const record = response.data
                if (!record?.info?.id) throw new Error("session.message failed: empty response")
                return { info: stripMessageDiffSnapshots(record.info), parts: sortParts(record.parts ?? []) }
              },
            })
        const resolvedPage = "records" in recovered
          ? {
              session: recovered.records.map((record) => record.info),
              part: recovered.records.map((record) => ({ id: record.info.id, part: record.parts })),
              cursor: page.cursor,
              complete: page.complete,
            }
          : recovered
        const committed = commitMessagesToStore(resolvedPage, options?.mode, options?.isStale)

        if (options?.isStale?.()) {
          setMetaFor(sessionID, { loading: false }, targetDirectory)
          setSessionPrefetch({
            directory: targetDirectory,
            sessionID,
            runtimeKey,
            limit: resolvedPage.session.length,
            cursor: resolvedPage.cursor,
            complete: resolvedPage.complete,
          })
          return
        }

        setMetaFor(sessionID, {
          limit: committed.messages.length,
          cursor: committed.cursor,
          complete: committed.complete,
          loading: false,
        }, targetDirectory)
        sessionLoadDebug("reactive-committed", {
          sessionID,
          directory: targetDirectory,
          messages: committed.messages.length,
          mode: options?.mode ?? "replace",
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        })
        setSessionPrefetch({
          directory: targetDirectory,
          sessionID,
          runtimeKey,
          limit: committed.messages.length,
          cursor: committed.cursor,
          complete: committed.complete,
        })
      } catch (error) {
        sessionLoadDebug("reactive-error", {
          sessionID,
          directory: targetDirectory,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          error: error instanceof Error ? error.message : String(error),
        })
        setMetaFor(sessionID, { loading: false }, targetDirectory)
        failSessionMessageLoad(targetDirectory, sessionID, formatSdkError(error), runtimeKey)
      }
    },
    [childStores, store, fetchMessages, getMetaFor, setMetaFor, getOptimistic, clearOptimistic, directory],
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
          if (cachedReady && hasSession && !force) return

          // Skip if recently fetched (TTL)
          if (!force && shouldSkipSessionPrefetch({
            hasSession,
            hasMessages: cachedReady,
            info: prefetchInfo,
            pageSize: getInitialSessionMessagePageSize(),
          })) return

          const shouldLoadMessages = Boolean(!cachedReady || force)
          const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
          sessionLoadDebug("reactive-sync-decision", {
            sessionID,
            directory: targetDirectory,
            cached,
            cachedReady,
            hasSession,
            shouldLoadMessages,
            shouldFetchSession,
            force: Boolean(force),
          })
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

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string) => {
      touch(sessionID)
      const m = getMetaFor(sessionID)
      if (m.loading || m.complete || !m.cursor) return
      await loadMessages(sessionID, { before: m.cursor, mode: "prepend" })
    },
    [touch, getMetaFor, loadMessages],
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
    (sessionID: string) => {
      const m = getMetaFor(sessionID)
      return !m.complete && !!m.cursor
    },
    [getMetaFor],
  )

  const isLoading = useCallback(
    (sessionID: string) => getMetaFor(sessionID).loading,
    [getMetaFor],
  )

  // True only when a fetch has positively confirmed the history is fully
  // loaded (no next cursor). Distinct from !hasMore(), which is also true for
  // sessions whose meta simply hasn't been populated yet.
  const isComplete = useCallback(
    (sessionID: string) => getMetaFor(sessionID).complete,
    [getMetaFor],
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

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadChildren,
      loadMore,
      hasMore,
      isLoading,
      isComplete,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, loadChildren, loadMore, hasMore, isLoading, isComplete, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}
