import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import type {
  LoadSessionMessagePageAppInput,
  LoadSessionMessagePageResult,
} from "../session-message-loader"
import type { ReduceSessionMessagePageResult } from "../session-message-reducer"
import { resolveSessionMergeStrategy } from "../session-merge-strategy"

// ---------------------------------------------------------------------------
// Mocks — loader is the seam under test; SDK / status stay out of the way.
//
// bun's mock.module is process-global and mutates the module record in place.
// mock.restore() does NOT put the original export functions back, so after this
// suite we re-install the pristine loader snapshot so sibling suites (e.g.
// session-message-loader.test.ts) keep the real implementation.
// ---------------------------------------------------------------------------

type LoaderBehavior = "ready" | "error" | "skipped"

const loadCalls: LoadSessionMessagePageAppInput[] = []
let loaderBehavior: LoaderBehavior = "ready"
let loaderMessages: Message[] = []
let loaderParts: Record<string, Part[]> = {}

// Snapshot real exports BEFORE any mock.module so teardown can reinstall them.
const realSessionMessageLoader = { ...(await import("../session-message-loader")) }
const pristineSessionMessageLoader = {
  MAX_ASSISTANT_TAIL_PARENT_LOADS: realSessionMessageLoader.MAX_ASSISTANT_TAIL_PARENT_LOADS,
  findMissingAssistantParentUserIDs: realSessionMessageLoader.findMissingAssistantParentUserIDs,
  loadSessionMessage: realSessionMessageLoader.loadSessionMessage,
  loadSessionMessagePage: realSessionMessageLoader.loadSessionMessagePage,
  loadSessionMessagePageTransport: realSessionMessageLoader.loadSessionMessagePageTransport,
  recoverAssistantTailBoundary: realSessionMessageLoader.recoverAssistantTailBoundary,
  resolveSessionMessagePageLimit: realSessionMessageLoader.resolveSessionMessagePageLimit,
}

const sessionGetCalls: string[] = []
const messagesSdkCalls: Array<{ sessionID: string; limit?: number }> = []
let sessionGetData: Session | null = {
  id: "ses_viewed",
  title: "viewed",
  time: { created: 1, updated: 1 },
} as Session
/** Lets a test simulate live SSE landing while `session.get` is in flight. */
let onSessionGet: (() => void) | null = null

/** Per-test queue of `/session/status` snapshots for reconnect status resync. */
type StatusSnapshot = Record<string, { type: "busy" | "idle" | "retry" }>
type StatusSnapshotEntry = {
  snapshot: StatusSnapshot
  /** Delay before resolving so a later snapshot's request-start is after the first. */
  delayMs?: number
}
const statusSnapshotQueue: StatusSnapshotEntry[] = []
const statusSnapshotCalls: Array<{ directory: string; startedAt: number }> = []

function installModuleMocks() {
  // Runtime surface mocks (complete exports) so importing sync-context / useDirectoryStore
  // never touches a bare `window` in Node test runners.
  mock.module("@/lib/runtimeSurface", () => ({
    isMobileSurfaceRuntime: () => false,
  }))

  mock.module("@/lib/desktop", () => ({
    isVSCodeRuntime: () => false,
    getDesktopHomeDirectory: async () => null,
  }))

  mock.module("@/lib/relay/runtime-tunnel", () => ({
    isRelayModeActive: () => false,
    getActiveRelayTunnel: () => null,
    activateRelayTunnel: () => null,
    adoptRelayTunnel: () => {},
    deactivateRelayTunnel: () => {},
  }))

  // Full sync-refs surface: sibling suites (e.g. session-actions.test.ts) install
  // an incomplete mock.module("./sync-refs"). bun keys that sticky mock by the
  // extensionless file URL (file://…/sync-refs); only re-mocking that key replaces it.
  const syncRefsExports = {
    setSyncRefs: () => undefined,
    registerSessionDirectory: () => undefined,
    getSyncChildStores: () => {
      throw new Error("ChildStoreManager not initialized in reconnect-loader test")
    },
    getDirectoryState: () => undefined,
    getSyncConfig: () => undefined,
    subscribeToSyncConfigChanges: () => () => undefined,
    emitSyncConfigChanged: () => undefined,
    getSyncSessions: () => [],
    getAllSyncSessions: () => [],
    getAllSyncSessionMap: () => new Map(),
    resolveMaterializedSessionDirectory: () => undefined,
    getSyncMessages: () => [],
    getSyncSessionMaterializationStatus: () => ({
      hasMessages: false,
      renderable: false,
      missingPartMessageIDs: [] as string[],
    }),
    getSyncParts: () => [],
    getSyncSessionStatus: () => undefined,
  }
  mock.module(new URL("../sync-refs", import.meta.url).href, () => syncRefsExports)
  mock.module("../sync-refs", () => syncRefsExports)

  mock.module("../session-message-loader", () => ({
    ...pristineSessionMessageLoader,
    loadSessionMessagePage: mock(async (input: LoadSessionMessagePageAppInput | { request: () => Promise<unknown> }) => {
      if (!("purpose" in input) || !input.purpose) {
        // Preserve transport overload for any incidental callers.
        if ("request" in input && typeof input.request === "function") {
          return input.request()
        }
        throw new Error("expected application loadSessionMessagePage overload")
      }
      loadCalls.push(input)

      const merge = resolveSessionMergeStrategy({ purpose: input.purpose })

      if (loaderBehavior === "error") {
        return {
          status: "error",
          applied: false,
          changed: false,
          messages: input.deps.getStoreState().message[input.sessionID] ?? [],
          recordCount: 0,
          error: "network down",
        } satisfies LoadSessionMessagePageResult
      }

      if (loaderBehavior === "skipped") {
        return {
          status: "skipped",
          applied: false,
          changed: false,
          messages: input.deps.getStoreState().message[input.sessionID] ?? [],
          recordCount: 0,
        } satisfies LoadSessionMessagePageResult
      }

      const sessionID = input.sessionID
      const state = input.deps.getStoreState()
      const boundary = { kind: "exhausted", loadedTurns: loaderMessages.length } as const
      const reduced = {
        applied: true,
        changed: true,
        messagesChanged: true,
        partsChanged: true,
        boundaryChanged: true,
        merge,
        message: { ...state.message, [sessionID]: loaderMessages },
        part: { ...state.part, ...loaderParts },
        messages: loaderMessages,
        boundary,
        meta: { limit: loaderMessages.length, cursor: undefined, complete: true },
        confirmedOptimisticIDs: [] as string[],
        commands: [] as Array<{ type: "clear-optimistic"; messageIDs: string[] }>,
      } satisfies ReduceSessionMessagePageResult

      input.deps.commitStore(reduced)
      input.deps.onReady?.(reduced.meta)

      return {
        status: "ready",
        applied: true,
        changed: true,
        messages: loaderMessages,
        recordCount: loaderMessages.length,
        meta: reduced.meta,
        reduced,
      } satisfies LoadSessionMessagePageResult
    }),
  }))

  mock.module("@/lib/opencode/client", () => ({
    opencodeClient: {
      getDirectory: () => "/repo",
      getScopedSdkClient: () => ({
        session: {
          get: mock(async ({ sessionID }: { sessionID: string }) => {
            sessionGetCalls.push(sessionID)
            onSessionGet?.()
            if (!sessionGetData) {
              return { error: { message: "missing" }, response: { status: 404 } }
            }
            return { data: { ...sessionGetData, id: sessionID } }
          }),
          messages: mock(async (params: { sessionID: string; limit?: number }) => {
            messagesSdkCalls.push(params)
            return { data: [], response: { headers: { get: () => null } } }
          }),
          message: mock(async () => ({ data: null })),
        },
      }),
      getSessionStatusForDirectory: mock(async (directory?: string | null) => {
        const startedAt = Date.now()
        statusSnapshotCalls.push({ directory: directory ?? "", startedAt })
        const entry = statusSnapshotQueue.shift()
        if (entry?.delayMs && entry.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, entry.delayMs))
        }
        return entry?.snapshot ?? {}
      }),
      getSessionStatus: mock(async () => ({})),
      listPendingQuestions: mock(async () => []),
      listPendingPermissions: mock(async () => []),
      setDirectory: () => undefined,
    },
  }))

  mock.module("@/stores/permissionStore", () => ({
    usePermissionStore: {
      getState: () => ({ isSessionAutoAccepting: () => false }),
    },
  }))

  mock.module("@/stores/useConfigStore", () => ({
    useConfigStore: {
      getState: () => ({ isConnected: true, hasEverConnected: true }),
      setState: () => undefined,
    },
  }))

  mock.module("@/stores/useTodosPersistStore", () => ({
    useTodosPersistStore: { getState: () => ({}) },
  }))

  mock.module("@/components/ui", () => ({
    toast: { info: () => undefined, error: () => undefined, success: () => undefined },
  }))

  mock.module("@/stores/useGlobalSessionsStore", () => ({
    useGlobalSessionsStore: {
      getState: () => ({
        activeSessions: [] as Session[],
        archivedSessions: [] as Session[],
        upsertSession: () => undefined,
        removeSessions: () => undefined,
        pendingDeletionIds: new Set<string>(),
      }),
    },
    resolveGlobalSessionDirectory: () => null,
    mergeSessionDirectoryMetadata: (session: Session) => session,
  }))
}

/** Put the real loader export functions back on the process module record. */
function restorePristineSessionMessageLoader() {
  mock.module("../session-message-loader", () => ({ ...pristineSessionMessageLoader }))
}

// Bind sync-context only after mocks are installed so it resolves mocked deps.
// Lazy: avoid installing mocks at file load time (that would poison later suites
// even if this file's tests never run — bun evaluates every listed file first).
type SyncContextApi = typeof import("../sync-context")
let materializeSessionFromServer: SyncContextApi["materializeSessionFromServer"]
let resyncDirectoryAfterReconnect: SyncContextApi["resyncDirectoryAfterReconnect"]
let setActiveSession: SyncContextApi["setActiveSession"]
let handleEvent: SyncContextApi["handleEvent"]
let invalidateReconnectTranscriptCache: SyncContextApi["invalidateReconnectTranscriptCache"]
let resolveReconnectStatusOnly: SyncContextApi["resolveReconnectStatusOnly"]
let syncContextBound = false

async function ensureSyncContextBound() {
  installModuleMocks()
  if (!syncContextBound) {
    const mod = await import("../sync-context")
    materializeSessionFromServer = mod.materializeSessionFromServer
    resyncDirectoryAfterReconnect = mod.resyncDirectoryAfterReconnect
    setActiveSession = mod.setActiveSession
    handleEvent = mod.handleEvent
    invalidateReconnectTranscriptCache = mod.invalidateReconnectTranscriptCache
    resolveReconnectStatusOnly = mod.resolveReconnectStatusOnly
    syncContextBound = true
  }
}

function message(id: string, role: "user" | "assistant" = "user", sessionID = "ses_viewed"): Message {
  return {
    id,
    sessionID,
    role,
    time: { created: 1 },
  } as Message
}

function part(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: "ses_viewed", type: "text", text } as Part
}

function createDirectoryStore(initial: Partial<State> = {}): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [
      {
        id: "ses_viewed",
        title: "viewed",
        time: { created: 1, updated: 1 },
        version: "1",
      } as State["session"][number],
    ],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createRoutingIndex() {
  return {
    sessionDirectoryById: new Map<string, string>(),
    messageSessionById: new Map<string, string>(),
    sessionMessageIdsById: new Map<string, Set<string>>(),
  }
}

describe("sync-context reconnect / materialize → loadSessionMessagePage", () => {
  beforeEach(async () => {
    // Re-register every mock each test: afterEach clears the loader mock.
    await ensureSyncContextBound()
    loadCalls.length = 0
    sessionGetCalls.length = 0
    messagesSdkCalls.length = 0
    statusSnapshotQueue.length = 0
    statusSnapshotCalls.length = 0
    loaderBehavior = "ready"
    onSessionGet = null
    loaderMessages = [message("msg_1")]
    loaderParts = { msg_1: [part("prt_1", "msg_1")] }
    sessionGetData = {
      id: "ses_viewed",
      title: "viewed",
      time: { created: 1, updated: 1 },
    } as Session
    setActiveSession("/repo", "ses_viewed")
  })

  afterEach(() => {
    // Leave the real loader on the module record so the next file in the same
    // bun process (or the next test if something re-imports) is not poisoned.
    restorePristineSessionMessageLoader()
  })

  afterAll(() => {
    restorePristineSessionMessageLoader()
  })

  test("materializeSessionFromServer calls unified loader with purpose materialize", async () => {
    const store = createDirectoryStore()

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "ensure-session-messages",
    })

    expect(loadCalls).toHaveLength(1)
    expect(loadCalls[0]?.purpose).toBe("materialize")
    expect(loadCalls[0]?.directory).toBe("/repo")
    expect(loadCalls[0]?.sessionID).toBe("ses_viewed")
    expect(typeof loadCalls[0]?.runtimeKey).toBe("string")
    expect(loadCalls[0]?.runtimeKey.length).toBeGreaterThan(0)
    expect(typeof loadCalls[0]?.deps.queryPage).toBe("function")
    expect(typeof loadCalls[0]?.deps.getStoreState).toBe("function")
    expect(typeof loadCalls[0]?.deps.commitStore).toBe("function")
    expect(typeof loadCalls[0]?.deps.isStale).toBe("function")
    // Must not fall through to raw session.messages for the page body.
    expect(messagesSdkCalls).toHaveLength(0)
  })

  test("an actual reconnect dirties every cached session's prefetch while preserving known boundaries", async () => {
    // Directory state: session S has old messages + exhausted boundary + a
    // fresh ready prefetch entry; the viewed session after the stream gap is T
    // (ses_viewed). S must be dirtied so entering it later refreshes the tail.
    const cachedUser = message("msg_s_user", "user", "ses_s")
    const store = createDirectoryStore({
      message: {
        ses_s: [cachedUser],
        ses_viewed: [message("msg_t_user", "user", "ses_viewed")],
      },
      part: {},
      session_history_boundary: {
        ses_s: { kind: "exhausted", loadedTurns: 3 },
        ses_viewed: { kind: "exhausted", loadedTurns: 1 },
      },
      session_status: { ses_viewed: { type: "busy" } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_s", requestedLimit: 6 })
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_viewed", requestedLimit: 6 })

    // Invalidation happens at the resync entry, BEFORE the network recovery.
    invalidateReconnectTranscriptCache("/repo", store)
    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    // The viewed session still recovered immediately via purpose=recovery.
    expect(loadCalls).toHaveLength(1)
    expect(loadCalls[0]?.purpose).toBe("recovery")
    expect(loadCalls[0]?.sessionID).toBe("ses_viewed")

    // Both cached sessions were dirtied BEFORE the viewed recovery ran:
    // the next visit must not skip the authoritative tail fetch.
    const infoS = prefetchCache.getSessionPrefetch("/repo", "ses_s")
    expect(infoS?.at).toBe(0)
    expect(prefetchCache.shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: store.getState().session_history_boundary.ses_s,
      info: infoS,
      pageSize: 6,
    })).toBe(false)
    // The known boundary and cached messages survive the dirty mark.
    expect(store.getState().session_history_boundary.ses_s).toEqual({
      kind: "exhausted",
      loadedTurns: 3,
    })
    expect(store.getState().message.ses_s).toEqual([cachedUser])
    expect(prefetchCache.getSessionPrefetch("/repo", "ses_viewed")?.at).toBe(0)
  })

  test("a clean first connect (statusOnly) does not dirty cached sessions", async () => {
    const cachedUser = message("msg_s_user", "user", "ses_s")
    const store = createDirectoryStore({
      message: { ses_s: [cachedUser] },
      part: {},
      session_history_boundary: { ses_s: { kind: "exhausted", loadedTurns: 3 } },
      session_status: { ses_viewed: { type: "busy" } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_s", requestedLimit: 6 })

    invalidateReconnectTranscriptCache("/repo", store, { statusOnly: true })
    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
      { statusOnly: true },
    )

    // Clean first connect: no transcript invalidation — the fresh ready entry
    // keeps its timestamp, so an exhausted boundary still reuses the cache.
    const infoS = prefetchCache.getSessionPrefetch("/repo", "ses_s")
    expect(infoS?.at).not.toBe(0)
    expect(prefetchCache.shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: store.getState().session_history_boundary.ses_s,
      info: infoS,
      pageSize: 6,
    })).toBe(true)
  })

  test("a transport switch dirties cached sessions with the same semantics", async () => {
    const cachedUser = message("msg_s_user", "user", "ses_s")
    const store = createDirectoryStore({
      message: { ses_s: [cachedUser] },
      part: {},
      session_history_boundary: { ses_s: { kind: "has-more", cursor: "msg_s_user", loadedTurns: 2 } },
      session_status: { ses_viewed: { type: "busy" } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_s", requestedLimit: 6 })

    invalidateReconnectTranscriptCache("/repo", store)
    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "transport-switch",
      () => 1,
    )

    const infoS = prefetchCache.getSessionPrefetch("/repo", "ses_s")
    expect(infoS?.at).toBe(0)
    expect(store.getState().session_history_boundary.ses_s).toEqual({
      kind: "has-more",
      cursor: "msg_s_user",
      loadedTurns: 2,
    })
  })

  test("a boundary-only cached session (no messages) is dirtied on reconnect", async () => {
    const store = createDirectoryStore({
      message: {},
      part: {},
      session_history_boundary: { ses_b: { kind: "has-more", cursor: "msg_b", loadedTurns: 2 } },
      session_status: { ses_viewed: { type: "busy" } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_b", requestedLimit: 6 })

    invalidateReconnectTranscriptCache("/repo", store)

    expect(prefetchCache.getSessionPrefetch("/repo", "ses_b")?.at).toBe(0)
  })

  test("invalidation does not depend on bootstrap or resync-in-flight gates", async () => {
    // A full reconnect arriving while a previous resync flight is still running
    // (or while the bootstrap gate is closed) gets its network refresh coalesced
    // — but the dirty fact must still be recorded so the next entry refetches.
    const cachedUser = message("msg_s_user", "user", "ses_s")
    const store = createDirectoryStore({
      message: { ses_s: [cachedUser] },
      part: {},
      session_history_boundary: { ses_s: { kind: "exhausted", loadedTurns: 3 } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_s", requestedLimit: 6 })

    // The invalidation helper takes only (directory, store, options): no
    // canBootstrap or resyncing consultation, so a coalesced second resync
    // still leaves the dirty mark behind.
    invalidateReconnectTranscriptCache("/repo", store)
    invalidateReconnectTranscriptCache("/repo", store)

    expect(prefetchCache.getSessionPrefetch("/repo", "ses_s")?.at).toBe(0)
    // No network recovery was issued by invalidation itself.
    expect(loadCalls).toHaveLength(0)
    expect(store.getState().session_history_boundary.ses_s).toEqual({
      kind: "exhausted",
      loadedTurns: 3,
    })
    expect(store.getState().message.ses_s).toEqual([cachedUser])
  })

  test("invalidation is a no-op without a live child store", async () => {
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_orphan", requestedLimit: 6 })

    invalidateReconnectTranscriptCache("/repo", undefined)

    // No store means no cached transcript state to invalidate.
    expect(prefetchCache.getSessionPrefetch("/repo", "ses_orphan")?.at).not.toBe(0)
  })

  test("a failed reconnect recovery keeps the boundary and the next visit still fetches", async () => {
    const cachedUser = message("msg_s_user", "user", "ses_s")
    const store = createDirectoryStore({
      message: { ses_s: [cachedUser] },
      part: {},
      session_history_boundary: { ses_s: { kind: "exhausted", loadedTurns: 3 } },
      session_status: { ses_viewed: { type: "busy" } },
    })
    const prefetchCache = await import("../session-prefetch-cache")
    prefetchCache.setSessionPrefetch({ directory: "/repo", sessionID: "ses_s", requestedLimit: 6 })
    loaderBehavior = "error"

    invalidateReconnectTranscriptCache("/repo", store)
    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    // The dirty mark + failed recovery both leave the next visit eligible.
    expect(prefetchCache.shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: store.getState().session_history_boundary.ses_s,
      info: prefetchCache.getSessionPrefetch("/repo", "ses_s"),
      pageSize: 6,
    })).toBe(false)
    expect(store.getState().session_history_boundary.ses_s).toEqual({
      kind: "exhausted",
      loadedTurns: 3,
    })
    expect(store.getState().message.ses_s).toEqual([cachedUser])
  })

  test("resolveReconnectStatusOnly gates statusOnly to a clean first connect only", async () => {
    // Clean first connect: no prior disconnect → statusOnly (no invalidation).
    expect(resolveReconnectStatusOnly({
      isFirstConnect: true,
      disconnectedBeforeFirstConnect: false,
    })).toBe(true)
    // A disconnect before the first connect is a real gap even when the boot
    // is recent — full reconnect semantics, transcripts get dirtied.
    expect(resolveReconnectStatusOnly({
      isFirstConnect: true,
      disconnectedBeforeFirstConnect: true,
    })).toBe(false)
    // Any later reconnect is a real gap regardless of boot recency.
    expect(resolveReconnectStatusOnly({
      isFirstConnect: false,
      disconnectedBeforeFirstConnect: false,
    })).toBe(false)
    expect(resolveReconnectStatusOnly({
      isFirstConnect: false,
      disconnectedBeforeFirstConnect: true,
    })).toBe(false)
  })

  test("resyncDirectoryAfterReconnect calls unified loader with purpose recovery", async () => {
    const store = createDirectoryStore({
      session_status: { ses_viewed: { type: "busy" } },
    })
    const routingIndex = createRoutingIndex()
    const revisions = new Map<string, number>([["ses_viewed", 1]])

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      routingIndex,
      "stream-reconnect",
      (sessionID: string) => revisions.get(sessionID) ?? 0,
    )

    expect(loadCalls).toHaveLength(1)
    expect(loadCalls[0]?.purpose).toBe("recovery")
    expect(loadCalls[0]?.directory).toBe("/repo")
    expect(loadCalls[0]?.sessionID).toBe("ses_viewed")
    expect(typeof loadCalls[0]?.deps.getLiveRevision).toBe("function")
    expect(typeof loadCalls[0]?.deps.isStale).toBe("function")
    expect(sessionGetCalls).toEqual(["ses_viewed"])
    expect(messagesSdkCalls).toHaveLength(0)
  })

  test("recovery reconciles stale busy status after completed message pull", async () => {
    // First directory status still reports busy; the recovery page then lands a
    // completed assistant. Without post-pull reconcile the list keeps busy.
    const busy: { type: "busy" } = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_viewed: busy },
      message: {},
      part: {},
    })
    // Short delay on the first snapshot so its request-start is strictly earlier
    // than the post-message-pull snapshot (requestedAt is captured before await).
    statusSnapshotQueue.push(
      { snapshot: { ses_viewed: { type: "busy" } }, delayMs: 5 },
      { snapshot: {} },
    )
    loaderMessages = [
      {
        id: "msg_done",
        sessionID: "ses_viewed",
        role: "assistant",
        time: { created: 1, completed: 2 },
      } as Message,
    ]
    loaderParts = { msg_done: [part("prt_done", "msg_done")] }

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(statusSnapshotCalls).toHaveLength(2)
    expect(statusSnapshotCalls[1]!.startedAt).toBeGreaterThanOrEqual(statusSnapshotCalls[0]!.startedAt)
    expect(store.getState().message.ses_viewed?.map((item) => item.id)).toEqual(["msg_done"])
    expect(store.getState().session_status.ses_viewed).toEqual({ type: "idle" })
  })

  test("loader ready commits messages into the directory store (materialize)", async () => {
    const store = createDirectoryStore({ message: {}, part: {} })
    loaderMessages = [message("msg_ready"), message("msg_ready_2")]
    loaderParts = {
      msg_ready: [part("prt_ready", "msg_ready")],
      msg_ready_2: [part("prt_ready_2", "msg_ready_2")],
    }

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "orphan-delta",
    })

    expect(store.getState().message.ses_viewed?.map((item) => item.id)).toEqual([
      "msg_ready",
      "msg_ready_2",
    ])
    expect(store.getState().part.msg_ready?.[0]?.id).toBe("prt_ready")
  })

  test("loader ready commits recovery messages into the directory store", async () => {
    const store = createDirectoryStore({
      message: { ses_viewed: [message("msg_old")] },
      part: { msg_old: [part("prt_old", "msg_old")] },
      session_status: { ses_viewed: { type: "busy" } },
    })
    loaderMessages = [message("msg_recovered")]
    loaderParts = { msg_recovered: [part("prt_recovered", "msg_recovered")] }

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(store.getState().message.ses_viewed?.map((item) => item.id)).toEqual(["msg_recovered"])
    expect(store.getState().part.msg_recovered?.[0]?.id).toBe("prt_recovered")
  })

  test("loader ready commits the boundary atomically with messages (materialize)", async () => {
    const store = createDirectoryStore({ message: {}, part: {} })
    loaderMessages = [message("msg_ready")]
    loaderParts = { msg_ready: [part("prt_ready", "msg_ready")] }

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "orphan-delta",
    })

    expect(store.getState().message.ses_viewed?.map((item) => item.id)).toEqual(["msg_ready"])
    // The boundary committed in the same setState, even though the loader
    // resolved it independently from the message payload.
    expect(store.getState().session_history_boundary.ses_viewed).toEqual({
      kind: "exhausted",
      loadedTurns: 1,
    })
  })

  test("loader ready commits the boundary atomically with messages (recovery)", async () => {
    const store = createDirectoryStore({
      message: { ses_viewed: [message("msg_old")] },
      part: { msg_old: [part("prt_old", "msg_old")] },
      session_status: { ses_viewed: { type: "busy" } },
    })
    loaderMessages = [message("msg_recovered")]
    loaderParts = { msg_recovered: [part("prt_recovered", "msg_recovered")] }

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(store.getState().session_history_boundary.ses_viewed).toEqual({
      kind: "exhausted",
      loadedTurns: 1,
    })
  })

  test("loader error preserves the last known boundary (materialize)", async () => {
    const existing = message("msg_keep")
    const existingPart = part("prt_keep", "msg_keep")
    const known = { kind: "has-more", cursor: "msg_keep", loadedTurns: 2 } as const
    const store = createDirectoryStore({
      message: { ses_viewed: [existing] },
      part: { msg_keep: [existingPart] },
      session_history_boundary: { ses_viewed: known },
    })
    loaderBehavior = "error"

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "ensure-session-messages",
    })

    expect(store.getState().session_history_boundary.ses_viewed).toEqual(known)
  })

  test("loader error preserves the last known boundary (recovery)", async () => {
    const existing = message("msg_keep")
    const existingPart = part("prt_keep", "msg_keep")
    const known = { kind: "exhausted", loadedTurns: 3 } as const
    const store = createDirectoryStore({
      message: { ses_viewed: [existing] },
      part: { msg_keep: [existingPart] },
      session_status: { ses_viewed: { type: "busy" } },
      session_history_boundary: { ses_viewed: known },
    })
    loaderBehavior = "error"

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(store.getState().session_history_boundary.ses_viewed).toEqual(known)
  })

  test("loader error preserves existing transcript (materialize)", async () => {
    const existing = message("msg_keep")
    const existingPart = part("prt_keep", "msg_keep")
    const store = createDirectoryStore({
      message: { ses_viewed: [existing] },
      part: { msg_keep: [existingPart] },
    })
    loaderBehavior = "error"

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "ensure-session-messages",
    })

    expect(store.getState().message.ses_viewed).toEqual([existing])
    expect(store.getState().part.msg_keep).toEqual([existingPart])
  })

  test("loader error preserves existing transcript (recovery)", async () => {
    const existing = message("msg_keep")
    const existingPart = part("prt_keep", "msg_keep")
    const store = createDirectoryStore({
      message: { ses_viewed: [existing] },
      part: { msg_keep: [existingPart] },
      session_status: { ses_viewed: { type: "busy" } },
    })
    loaderBehavior = "error"

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(store.getState().message.ses_viewed).toEqual([existing])
    expect(store.getState().part.msg_keep).toEqual([existingPart])
  })

  test("loader skipped does not write store (materialize)", async () => {
    const store = createDirectoryStore({ message: {}, part: {} })
    loaderBehavior = "skipped"

    await materializeSessionFromServer("/repo", "ses_viewed", store, {
      reason: "ensure-session-messages",
    })

    expect(store.getState().message.ses_viewed ?? []).toEqual([])
    expect(Object.keys(store.getState().part)).toHaveLength(0)
  })

  test("loader skipped does not write store (recovery)", async () => {
    const existing = message("msg_keep")
    const store = createDirectoryStore({
      message: { ses_viewed: [existing] },
      part: {},
      session_status: { ses_viewed: { type: "busy" } },
    })
    loaderBehavior = "skipped"

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(store.getState().message.ses_viewed).toEqual([existing])
  })

  test("recovery only loads the viewed session, not background sessions", async () => {
    const store = createDirectoryStore({
      session: [
        {
          id: "ses_viewed",
          title: "viewed",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number],
        {
          id: "ses_background",
          title: "background",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number],
      ],
      session_status: {
        ses_viewed: { type: "busy" },
        ses_background: { type: "busy" },
      },
      message: {
        ses_background: [message("msg_bg", "assistant", "ses_background")],
      },
    })
    setActiveSession("/repo", "ses_viewed")

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(loadCalls.map((call) => call.sessionID)).toEqual(["ses_viewed"])
    expect(sessionGetCalls).toEqual(["ses_viewed"])
  })

  test("recovery provides live-revision deps for stale snapshot protection", async () => {
    const store = createDirectoryStore({
      session_status: { ses_viewed: { type: "busy" } },
    })
    let liveRevision = 3

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "domain-stale-resync",
      () => liveRevision,
    )

    const deps = loadCalls[0]?.deps
    expect(deps?.getLiveRevision?.()).toBe(3)
    liveRevision = 5
    expect(deps?.getLiveRevision?.()).toBe(5)
    // isStale should track the same revision advance semantics used by reconnect.
    expect(deps?.isStale?.()).toBe(true)
  })

  test("live events during session.get still recover the message body", async () => {
    const store = createDirectoryStore({
      session_status: { ses_viewed: { type: "busy" } },
      message: {},
      part: {},
    })
    let liveRevision = 1
    // A streaming session keeps emitting while `session.get` is in flight.
    onSessionGet = () => { liveRevision += 1 }

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => liveRevision,
    )

    expect(loadCalls).toHaveLength(1)
    expect(loadCalls[0]?.purpose).toBe("recovery")
    // Body revision is captured after session.get, so the page is not stale.
    expect(loadCalls[0]?.deps.isStale?.()).toBe(false)
    expect(store.getState().message.ses_viewed).toHaveLength(1)
  })

  test("missing session identity still recovers the message body", async () => {
    const store = createDirectoryStore({
      session_status: { ses_viewed: { type: "busy" } },
      message: {},
      part: {},
    })
    sessionGetData = null

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
    )

    expect(loadCalls).toHaveLength(1)
    expect(store.getState().message.ses_viewed).toHaveLength(1)
  })

  test("live events after the body page starts still mark it stale", async () => {
    const store = createDirectoryStore({
      session_status: { ses_viewed: { type: "busy" } },
    })
    let liveRevision = 1

    await resyncDirectoryAfterReconnect(
      "/repo",
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => liveRevision,
    )

    expect(loadCalls[0]?.deps.isStale?.()).toBe(false)
    liveRevision += 1
    expect(loadCalls[0]?.deps.isStale?.()).toBe(true)
  })

  test("active top-level session.idle enqueues one materialize; background top-level does not", async () => {
    const store = createDirectoryStore({
      session: [
        {
          id: "ses_viewed",
          title: "viewed",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number],
        {
          id: "ses_background",
          title: "background",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number],
      ],
    })
    const childStores = {
      getChild: (directory: string) => (directory === "/repo" ? store : undefined),
      children: new Map([["/repo", store]]),
      mark: () => undefined,
      ensureChild: () => store,
    } as unknown as import("../child-store").ChildStoreManager
    setActiveSession("/repo", "ses_viewed")

    handleEvent(
      "/repo",
      { type: "session.idle", properties: { sessionID: "ses_viewed" } } as never,
      childStores,
      createRoutingIndex(),
    )
    handleEvent(
      "/repo",
      { type: "session.idle", properties: { sessionID: "ses_background" } } as never,
      childStores,
      createRoutingIndex(),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(loadCalls.map((call) => call.sessionID)).toEqual(["ses_viewed"])
    expect(loadCalls[0]?.purpose).toBe("materialize")
  })

  test("child session.idle still materializes the parent session", async () => {
    const store = createDirectoryStore({
      session: [
        {
          id: "ses_parent",
          title: "parent",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number],
        {
          id: "ses_child",
          title: "child",
          parentID: "ses_parent",
          time: { created: 1, updated: 1 },
          version: "1",
        } as State["session"][number] & { parentID: string },
      ],
    })
    const childStores = {
      getChild: (directory: string) => (directory === "/repo" ? store : undefined),
      children: new Map([["/repo", store]]),
      mark: () => undefined,
      ensureChild: () => store,
    } as unknown as import("../child-store").ChildStoreManager
    setActiveSession("/repo", "ses_parent")

    handleEvent(
      "/repo",
      { type: "session.idle", properties: { sessionID: "ses_child" } } as never,
      childStores,
      createRoutingIndex(),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(loadCalls.map((call) => call.sessionID)).toEqual(["ses_parent"])
    expect(loadCalls[0]?.purpose).toBe("materialize")
  })
})