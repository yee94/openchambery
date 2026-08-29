import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import { adoptRelayTunnel, deactivateRelayTunnel } from "@/lib/relay/runtime-tunnel"
import {
  bindStreamReconnect,
  noteStreamActivity,
  resetStreamLivenessForTests,
  STREAM_STALE_MS,
} from "./stream-liveness"
import type { RelayTunnelClient } from "@/lib/relay/tunnel-client"
import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"

type RestoredAttachment = { url: string; mimeType: string; filename: string }
type DraftCommitCall = {
  key: { transportIdentity: string; owner: { kind: string; ownerID: string } }
  expectedRevision: number | "absent"
  snapshot: { text: string; attachments: Array<{ filename?: string; locator?: { kind: string; url?: string } }> }
  values?: ReadonlyMap<string, Blob | string>
}

const mocks = vi.hoisted(() => {
  const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const scopedClientDirectories: string[] = []
  const registeredSessionDirectories: Array<{ sessionID: string; directory: string }> = []
  const globalUpsertedSessions: unknown[] = []
  const abortBlockEvents: Array<{ event: "begin" | "clear"; scope: Record<string, unknown>; token: string }> = []
  const pendingSendTransitions: Array<{ state: "mark" | "clear"; sessionId: string; messageID: string }> = []
  const hostTurnPageCalls: Array<Record<string, unknown>> = []
  const setCurrentSessionCalls: Array<{
    sessionId: string
    directory?: string | null
    options?: { skipMessageFetch?: boolean }
  }> = []
  const draftCommits: DraftCommitCall[] = []

  const state = {
    sessionRevertResult: {} as { data?: unknown; error?: unknown; response?: { status?: number } },
    sessionUnrevertResult: {} as { data?: unknown; error?: unknown; response?: { status?: number } },
    questionReplyError: null as unknown | null,
    questionRejectError: null as unknown | null,
    sessionShareResult: {} as { data?: unknown; error?: unknown; response?: { status?: number } },
    sessionUpdateResult: {} as { data?: unknown; error?: unknown; response?: { status?: number } },
    sessionMessagesResult: { data: [] } as { data?: unknown; error?: unknown; response?: { status?: number } },
    sessionStatusResult: {} as Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }> | null,
    sessionDeleteMessageFailureID: null as string | null,
    sessionForkResult: null as Session | null,
    clearAttachedFilesCalls: 0,
    abortReject: false,
    abortResult: { data: true } as { data?: boolean; error?: unknown; response?: { status?: number } },
    abortBlockToken: 0,
    mobileSurfaceRuntime: false,
    vscodeRuntime: false,
    hostTurnPageBehavior: {
      cursor: null,
      complete: true,
    } as { cursor: string | null; complete: boolean; turnCount?: number; error?: string },
    sessionGetResult: null as Session | null,
    globalActiveSessions: [] as Session[],
    globalArchivedSessions: [] as Session[],
    uiCurrentSessionId: "session-a" as string | null,
    uiPendingSendMessageIDs: new Map<string, string>(),
    draftRevisionByKey: new Map<string, number>(),
    draftCommitShouldFail: false,
    draftCommitFailAfter: 0,
    draftCommitCount: 0,
  }

  const configStoreState = {
    isConnected: true,
    hasEverConnected: true,
    probeConnection: async () => configStoreState.isConnected,
  }

  const mockScopedClient = {
    permission: {
      reply: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "permission.reply", params })
        return Promise.resolve({ data: true })
      }),
    },
    question: {
      reply: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "question.reply", params })
        if (state.questionReplyError) {
          return Promise.resolve({ error: state.questionReplyError, response: { status: 404 } })
        }
        return Promise.resolve({ data: true })
      }),
      reject: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "question.reject", params })
        if (state.questionRejectError) {
          return Promise.resolve({ error: state.questionRejectError, response: { status: 404 } })
        }
        return Promise.resolve({ data: true })
      }),
    },
  }

  const mockSdk = {
    session: {
      messages: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.messages", params })
        return Promise.resolve(state.sessionMessagesResult)
      }),
      revert: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.revert", params })
        return Promise.resolve(state.sessionRevertResult)
      }),
      unrevert: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.unrevert", params })
        return Promise.resolve(state.sessionUnrevertResult)
      }),
      abort: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.abort", params })
        if (state.abortReject) return Promise.reject(new Error("abort failed"))
        return Promise.resolve(state.abortResult)
      }),
      updateSession: vi.fn((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
        replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
        return Promise.resolve(state.sessionUpdateResult.data as Session)
      }),
      update: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.update", params })
        return Promise.resolve(state.sessionUpdateResult)
      }),
      share: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.share", params })
        return Promise.resolve(state.sessionShareResult)
      }),
      unshare: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "session.unshare", params })
        return Promise.resolve(state.sessionShareResult)
      }),
    },
    permission: {
      reply: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "permission.reply", params })
        return Promise.resolve({ data: true })
      }),
    },
    question: {
      reply: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "question.reply", params })
        if (state.questionReplyError) {
          return Promise.resolve({ error: state.questionReplyError, response: { status: 404 } })
        }
        return Promise.resolve({ data: true })
      }),
      reject: vi.fn((params: Record<string, unknown>) => {
        replyCalls.push({ method: "question.reject", params })
        if (state.questionRejectError) {
          return Promise.resolve({ error: state.questionRejectError, response: { status: 404 } })
        }
        return Promise.resolve({ data: true })
      }),
    },
  }

  const inputState = {
    pendingInputText: "",
    pendingInputMode: "normal" as const,
    attachedFiles: [] as RestoredAttachment[],
    drafts: {} as Record<string, { revision: number; text: string }>,
    clearAttachedFiles: () => {
      state.clearAttachedFilesCalls += 1
      inputState.attachedFiles = []
    },
    setAttachedFiles: (attachments: RestoredAttachment[]) => {
      inputState.attachedFiles = attachments
    },
    addRestoredAttachment: (attachment: RestoredAttachment) => {
      inputState.attachedFiles = [...inputState.attachedFiles, attachment]
    },
    captureDraftRuntime: () => {
      // Keep mock transport aligned with real getRuntimeTransportIdentity() used by sessionDraftKey.
      try {
        // Lazy require avoids circular import at mock setup time.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy load for mock setup
        const { getRuntimeTransportIdentity } = require("../lib/runtime-switch") as typeof import("../lib/runtime-switch")
        return { transportIdentity: getRuntimeTransportIdentity(), generation: 1 }
      } catch {
        return { transportIdentity: "direct:url:default", generation: 1 }
      }
    },
    getDraft: (key: { transportIdentity: string; owner: { kind: string; ownerID: string } }) => {
      const id = JSON.stringify([key.transportIdentity, key.owner.kind, key.owner.ownerID])
      const revision = state.draftRevisionByKey.get(id)
      if (!revision) return undefined
      return { version: 1, key, revision, text: inputState.drafts[id]?.text ?? "", attachments: [], syntheticParts: [], mentions: [] }
    },
    draftAttachmentViews: {} as Record<string, Record<string, never>>,
    commitDraftSnapshot: async (request: DraftCommitCall) => {
      state.draftCommitCount += 1
      draftCommits.push(request)
      if (state.draftCommitShouldFail && state.draftCommitCount > state.draftCommitFailAfter) {
        return { status: "failed", durable: false, current: false, errors: [], cleanupErrors: [] }
      }
      const id = JSON.stringify([request.key.transportIdentity, request.key.owner.kind, request.key.owner.ownerID])
      const existing = state.draftRevisionByKey.get(id)
      if (request.expectedRevision === "absent" ? existing !== undefined : existing !== request.expectedRevision) {
        return { status: "conflict", durable: false, current: true, errors: [], cleanupErrors: [] }
      }
      const revision = request.expectedRevision === "absent" ? 1 : request.expectedRevision + 1
      state.draftRevisionByKey.set(id, revision)
      inputState.drafts[id] = { revision, text: request.snapshot.text }
      return {
        status: "committed",
        durable: true,
        current: true,
        record: { version: 1, key: request.key, revision, text: request.snapshot.text, attachments: request.snapshot.attachments ?? [], syntheticParts: [], mentions: [] },
        errors: [],
        cleanupErrors: [],
      }
    },
    deleteDraftSnapshot: async (request: {
      key: { transportIdentity: string; owner: { kind: string; ownerID: string } }
      expectedRevision: number
    }) => {
      const id = JSON.stringify([request.key.transportIdentity, request.key.owner.kind, request.key.owner.ownerID])
      const existing = state.draftRevisionByKey.get(id)
      if (existing !== request.expectedRevision) {
        return { status: "conflict", durable: false, current: true, errors: [], cleanupErrors: [] }
      }
      state.draftRevisionByKey.delete(id)
      delete inputState.drafts[id]
      return { status: "committed", durable: true, current: true, errors: [], cleanupErrors: [] }
    },
  }

  return {
    replyCalls,
    scopedClientDirectories,
    registeredSessionDirectories,
    globalUpsertedSessions,
    abortBlockEvents,
    pendingSendTransitions,
    hostTurnPageCalls,
    setCurrentSessionCalls,
    draftCommits,
    configStoreState,
    mockScopedClient,
    mockSdk,
    inputState,
    get sessionRevertResult() { return state.sessionRevertResult },
    set sessionRevertResult(value) { state.sessionRevertResult = value },
    get sessionUnrevertResult() { return state.sessionUnrevertResult },
    set sessionUnrevertResult(value) { state.sessionUnrevertResult = value },
    get questionReplyError() { return state.questionReplyError },
    set questionReplyError(value) { state.questionReplyError = value },
    get questionRejectError() { return state.questionRejectError },
    set questionRejectError(value) { state.questionRejectError = value },
    get sessionShareResult() { return state.sessionShareResult },
    set sessionShareResult(value) { state.sessionShareResult = value },
    get sessionUpdateResult() { return state.sessionUpdateResult },
    set sessionUpdateResult(value) { state.sessionUpdateResult = value },
    get sessionMessagesResult() { return state.sessionMessagesResult },
    set sessionMessagesResult(value) { state.sessionMessagesResult = value },
    get sessionStatusResult() { return state.sessionStatusResult },
    set sessionStatusResult(value) { state.sessionStatusResult = value },
    get sessionDeleteMessageFailureID() { return state.sessionDeleteMessageFailureID },
    set sessionDeleteMessageFailureID(value) { state.sessionDeleteMessageFailureID = value },
    get sessionForkResult() { return state.sessionForkResult },
    set sessionForkResult(value) { state.sessionForkResult = value },
    get clearAttachedFilesCalls() { return state.clearAttachedFilesCalls },
    set clearAttachedFilesCalls(value) { state.clearAttachedFilesCalls = value },
    get abortReject() { return state.abortReject },
    set abortReject(value) { state.abortReject = value },
    get abortResult() { return state.abortResult },
    set abortResult(value) { state.abortResult = value },
    get abortBlockToken() { return state.abortBlockToken },
    set abortBlockToken(value) { state.abortBlockToken = value },
    get mobileSurfaceRuntime() { return state.mobileSurfaceRuntime },
    set mobileSurfaceRuntime(value) { state.mobileSurfaceRuntime = value },
    get vscodeRuntime() { return state.vscodeRuntime },
    set vscodeRuntime(value) { state.vscodeRuntime = value },
    get hostTurnPageBehavior() { return state.hostTurnPageBehavior },
    set hostTurnPageBehavior(value) { state.hostTurnPageBehavior = value },
    get sessionGetResult() { return state.sessionGetResult },
    set sessionGetResult(value) { state.sessionGetResult = value },
    get globalActiveSessions() { return state.globalActiveSessions },
    set globalActiveSessions(value) { state.globalActiveSessions = value },
    get globalArchivedSessions() { return state.globalArchivedSessions },
    set globalArchivedSessions(value) { state.globalArchivedSessions = value },
    get uiCurrentSessionId() { return state.uiCurrentSessionId },
    set uiCurrentSessionId(value) { state.uiCurrentSessionId = value },
    get uiPendingSendMessageIDs() { return state.uiPendingSendMessageIDs },
    set uiPendingSendMessageIDs(value) { state.uiPendingSendMessageIDs = value },
    get draftRevisionByKey() { return state.draftRevisionByKey },
    set draftRevisionByKey(value) { state.draftRevisionByKey = value },
    get draftCommitShouldFail() { return state.draftCommitShouldFail },
    set draftCommitShouldFail(value) { state.draftCommitShouldFail = value },
    get draftCommitFailAfter() { return state.draftCommitFailAfter },
    set draftCommitFailAfter(value) { state.draftCommitFailAfter = value },
    get draftCommitCount() { return state.draftCommitCount },
    set draftCommitCount(value) { state.draftCommitCount = value },
    state,
  }
})

const {
  replyCalls,
  scopedClientDirectories,
  globalUpsertedSessions,
  abortBlockEvents,
  pendingSendTransitions,
  hostTurnPageCalls,
  setCurrentSessionCalls,
  draftCommits,
  configStoreState,
  mockSdk,
  inputState,
} = mocks

vi.mock("@/lib/runtimeSurface", () => ({
  isMobileSurfaceRuntime: () => mocks.mobileSurfaceRuntime,
}))

vi.mock("@/lib/desktop", () => ({
  isVSCodeRuntime: () => mocks.vscodeRuntime,
  isDesktopShell: () => false,
  isDesktopLocalOriginActive: () => false,
}))

vi.mock("./session-turn-page-api", () => ({
  SESSION_TURN_PAGE_TURNS: 3,
  SESSION_TURN_PAGE_TIMEOUT_MS: 30_000,
  raceWithSessionTurnPageTimeout: async <T>(operation: Promise<T>) => operation,
  fetchHostSessionTurnPageForPurpose: vi.fn(async (input: Record<string, unknown>) => {
    mocks.hostTurnPageCalls.push(input)
    mocks.replyCalls.push({ method: "host.session.turnPage", params: input })
    if (mocks.hostTurnPageBehavior.error) throw new Error(mocks.hostTurnPageBehavior.error)
    const records = Array.isArray(mocks.sessionMessagesResult.data) ? mocks.sessionMessagesResult.data : []
    return {
      records,
      cursor: mocks.hostTurnPageBehavior.cursor,
      complete: mocks.hostTurnPageBehavior.complete,
      turnCount: mocks.hostTurnPageBehavior.turnCount ?? records.filter((record) => {
        const info = (record as { info?: { role?: unknown; clientRole?: unknown } })?.info
        return info?.role === "user" || info?.clientRole === "user"
      }).length,
    }
  }),
  fetchSessionTurnPage: vi.fn(async () => ({
    records: [],
    cursor: null,
    complete: true,
    turnCount: 0,
  })),
}))

vi.mock("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      mocks.scopedClientDirectories.push(directory)
      return mocks.mockScopedClient
    },
    getDirectory: () => "/test/project",
    setDirectory: vi.fn(),
    getSessionStatusForDirectory: vi.fn((directory: string) => {
      mocks.replyCalls.push({ method: "session.status", params: { directory } })
      return Promise.resolve(mocks.sessionStatusResult)
    }),
    getSession: vi.fn((sessionId: string, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.get", params: { sessionID: sessionId, directory } })
      if (!mocks.sessionGetResult) throw new Error("session.get result is unavailable")
      return Promise.resolve(mocks.sessionGetResult)
    }),
    replyToPermission: vi.fn((requestId: string, reply: string, options?: { directory?: string | null }) => {
      mocks.replyCalls.push({ method: "permission.reply", params: { requestID: requestId, reply, directory: options?.directory } })
      return Promise.resolve(true)
    }),
    replyToQuestion: vi.fn((requestId: string, answers: string[] | string[][], directory?: string | null) => {
      mocks.replyCalls.push({ method: "question.reply", params: { requestID: requestId, answers, directory } })
      return Promise.resolve(true)
    }),
    revertSession: vi.fn((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      mocks.replyCalls.push({
        method: "session.revert",
        params: { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      })
      if (mocks.sessionRevertResult.error) {
        const status = mocks.sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(mocks.sessionRevertResult.data)
    }),
    deleteSessionMessage: vi.fn((sessionId: string, messageId: string, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.deleteMessage", params: { sessionID: sessionId, messageID: messageId, directory } })
      if (mocks.sessionDeleteMessageFailureID === messageId) {
        throw new Error("session.deleteMessage failed (500): rejected")
      }
      return Promise.resolve(true)
    }),
    updateSession: vi.fn((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(mocks.sessionUpdateResult.data)
    }),
    forkSession: vi.fn((sessionId: string, messageId?: string, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.fork", params: { sessionID: sessionId, messageID: messageId, directory } })
      if (!mocks.sessionForkResult) throw new Error("session.fork result is unavailable")
      return Promise.resolve(mocks.sessionForkResult)
    }),
  },
}))

vi.mock("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => mocks.configStoreState,
  },
}))

vi.mock("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: mocks.uiCurrentSessionId,
      pendingSendMessageIDs: mocks.uiPendingSendMessageIDs,
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "session-a") return "/test/project"
        if (sessionId === "session-b") return "/other/project"
        return null
      },
      setCurrentSession: (
        sessionId: string,
        directory?: string | null,
        options?: { skipMessageFetch?: boolean },
      ) => {
        mocks.setCurrentSessionCalls.push({ sessionId, directory, options })
        mocks.uiCurrentSessionId = sessionId
      },
      beginQueueAbortBlock: (scope: Record<string, unknown>) => {
        const token = `abort-${++mocks.abortBlockToken}`
        mocks.abortBlockEvents.push({ event: "begin", scope, token })
        return token
      },
      clearQueueAbortBlock: (scope: Record<string, unknown>, token: string) => {
        mocks.abortBlockEvents.push({ event: "clear", scope, token })
      },
      markMessageSending: (sessionId: string, messageID: string) => {
        mocks.pendingSendTransitions.push({ state: "mark", sessionId, messageID })
      },
      clearMessageSending: (sessionId: string, messageID: string) => {
        mocks.pendingSendTransitions.push({ state: "clear", sessionId, messageID })
      },
    }),
    setState: () => undefined,
  },
}))

vi.mock("./input-store", () => ({
  useInputStore: {
    getState: () => mocks.inputState,
    setState: (patch: Partial<typeof mocks.inputState>) => Object.assign(mocks.inputState, patch),
  },
}))

vi.mock("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session, existing?: SessionWithDirectory | null): SessionWithDirectory => {
    if (!existing) return incoming as SessionWithDirectory
    const next = { ...(incoming as SessionWithDirectory) }
    if (!next.directory && existing.directory) next.directory = existing.directory
    if (!next.project && existing.project) next.project = existing.project
    if (next.project && !next.project.worktree && existing.project?.worktree) {
      next.project = { ...next.project, worktree: existing.project.worktree }
    }
    return next
  },
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: mocks.globalActiveSessions,
      archivedSessions: mocks.globalArchivedSessions,
      upsertSession: (session: unknown) => {
        mocks.globalUpsertedSessions.push(session)
      },
    }),
  },
}))

vi.mock("./sync-refs", () => ({
  registerSessionDirectory: (sessionID: string, directory: string) => {
    mocks.registeredSessionDirectories.push({ sessionID, directory })
  },
  getAllSyncSessionMap: () => new Map(),
}))

type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveCall = { sessionID: string; directory?: string | null; messageID: string }
/** Test store: DirectoryStore + optional transcript maps for residual fixtures. */
type TestDirectoryStore = DirectoryStore & {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_history_boundary: Record<string, unknown>
}

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<TestDirectoryStore>,
): StoreApi<TestDirectoryStore> {
  // Ticket 09 batch 2: production State has no message/part; tests keep optional
  // transcript maps for residual fixtures that still assert host store fields.
  return create<TestDirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_history_boundary: {},
    ...state,
    permission: permissions,
    patch: (partial) => set(partial as never),
    replace: (next) => set(next as never),
  }))
}

function createChildStores(
  entries: Array<[string, StoreApi<TestDirectoryStore>]>,
  options?: {
    trackEnsure?: Array<{ directory: string; options?: { bootstrap?: boolean } }>
  },
) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string, ensureOptions?: { bootstrap?: boolean }) => {
      options?.trackEnsure?.push({ directory: dir, options: ensureOptions })
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("./child-store").ChildStoreManager
}

describe("fetchMessagesForSession startup race", () => {
  beforeEach(() => {
    mocks.mobileSurfaceRuntime = false
    mocks.vscodeRuntime = false
    mocks.sessionStatusResult = {}
    configStoreState.isConnected = true
    configStoreState.hasEverConnected = true
    hostTurnPageCalls.length = 0
    replyCalls.length = 0
    mocks.hostTurnPageBehavior = { cursor: null, complete: true }
    mocks.uiCurrentSessionId = "session-a"
  })

  test("replays a selection fetch queued before sync action refs initialize", async () => {
    replyCalls.length = 0
    hostTurnPageCalls.length = 0
    mocks.sessionMessagesResult = { data: [] }
    const store = createStore({}, { session: [{ id: "startup-session", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")

    await fetchMessagesForSession("startup-session", "/test/project")
    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(0)

    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    expect(hostTurnPageCalls[0]?.purpose).toBe("initial")
  })

  test("uses one Host turn-page request for concurrent session selection loads", async () => {
    replyCalls.length = 0
    hostTurnPageCalls.length = 0
    mocks.sessionMessagesResult = { data: [] }
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await Promise.all([
      fetchMessagesForSession("session-a", "/test/project"),
      fetchMessagesForSession("session-a", "/test/project"),
    ])

    const turnCalls = replyCalls.filter((call) => call.method === "host.session.turnPage")
    expect(turnCalls).toHaveLength(1)
    expect(turnCalls[0]?.params.purpose).toBe("initial")
  })

  test("selection materialize uses Host initial turn purpose on every surface", async () => {
    const store = createStore({}, {
      session: [
        { id: "session-mobile", time: { created: 1 } } as Session,
        { id: "session-web", time: { created: 1 } } as Session,
        { id: "session-vscode", time: { created: 1 } } as Session,
      ],
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    for (const runtime of ["mobile", "web", "vscode"] as const) {
      replyCalls.length = 0
      hostTurnPageCalls.length = 0
      mocks.mobileSurfaceRuntime = runtime === "mobile"
      mocks.vscodeRuntime = runtime === "vscode"
      await fetchMessagesForSession(`session-${runtime}`, "/test/project")

      expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
      expect(hostTurnPageCalls[0]?.purpose).toBe("initial")
    }
  })

  test("refetches a busy session when the local tail is still pre-send (last message is assistant)", async () => {
    replyCalls.length = 0
    // IDs must sort lexicographically the same way materialization orders them.
    const existingUser = {
      id: "msg_1",
      role: "user",
      sessionID: "session-busy",
      time: { created: 1 },
    } as Message
    const existingAssistant = {
      id: "msg_2",
      role: "assistant",
      sessionID: "session-busy",
      time: { created: 2 },
    } as Message
    const sentUser = {
      id: "msg_3",
      role: "user",
      sessionID: "session-busy",
      time: { created: 3 },
    } as Message
    mocks.sessionMessagesResult = {
      data: [
        { info: existingUser, parts: [{ id: "prt_1", type: "text", text: "old" } as Part] },
        { info: existingAssistant, parts: [{ id: "prt_2", type: "text", text: "reply" } as Part] },
        { info: sentUser, parts: [{ id: "prt_3", type: "text", text: "new" } as Part] },
      ],
    }
    const store = createStore({}, {
      session: [{ id: "session-busy", time: { created: 1 } } as Session],
      message: { "session-busy": [existingUser, existingAssistant] },
      part: {
        msg_1: [{ id: "prt_1", type: "text", text: "old" } as Part],
        msg_2: [{ id: "prt_2", type: "text", text: "reply" } as Part],
      },
      session_status: { "session-busy": { type: "busy" } },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    // Pin selection so the in-flight write is not treated as stale.
    const { useSessionUIStore } = await import("./session-ui-store")
    const previousGetState = useSessionUIStore.getState
    useSessionUIStore.getState = () => ({
      ...previousGetState(),
      currentSessionId: "session-busy",
    }) as ReturnType<typeof previousGetState>

    try {
      await fetchMessagesForSession("session-busy", "/test/project")
    } finally {
      useSessionUIStore.getState = previousGetState
    }

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    expect(store.getState().message["session-busy"]?.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
    ])
  })

  test("reconciles stale busy after a same-size current-session message pull", async () => {
    replyCalls.length = 0
    const existingUser = {
      id: "msg_status_1",
      role: "user",
      sessionID: "session-status-reconcile",
      time: { created: 1 },
    } as Message
    const completedAssistant = {
      id: "msg_status_2",
      role: "assistant",
      sessionID: "session-status-reconcile",
      finish: "stop",
      time: { created: 2, completed: 3 },
    } as Message
    const textPart = {
      id: "prt_status_2",
      messageID: "msg_status_2",
      sessionID: "session-status-reconcile",
      type: "text",
      text: "done",
      time: { start: 2, end: 3 },
    } as Part
    mocks.sessionMessagesResult = {
      data: [
        { info: existingUser, parts: [{ id: "prt_status_1", type: "text", text: "run" } as Part] },
        { info: completedAssistant, parts: [textPart] },
      ],
    }
    mocks.sessionStatusResult = {}
    const busyStatus = { type: "busy" } as const
    const store = createStore({}, {
      session: [{ id: "session-status-reconcile", time: { created: 1 } } as Session],
      message: { "session-status-reconcile": [existingUser, completedAssistant] },
      part: {
        msg_status_1: [{ id: "prt_status_1", type: "text", text: "run" } as Part],
        msg_status_2: [textPart],
      },
      session_status: { "session-status-reconcile": busyStatus },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const { useSessionUIStore } = await import("./session-ui-store")
    const previousGetState = useSessionUIStore.getState
    useSessionUIStore.getState = () => ({
      ...previousGetState(),
      currentSessionId: "session-status-reconcile",
      currentSessionDirectory: "/test/project",
    }) as ReturnType<typeof previousGetState>

    try {
      await fetchMessagesForSession("session-status-reconcile", "/test/project")
    } finally {
      useSessionUIStore.getState = previousGetState
    }

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    expect(replyCalls.filter((call) => call.method === "session.status")).toHaveLength(1)
    expect(store.getState().session_status["session-status-reconcile"]).toEqual({ type: "idle" })
    expect(typeof store.getState().session_status_observed_at["session-status-reconcile"]).toBe("number")
    expect(typeof store.getState().session_status_snapshot_at).toBe("number")
  })

  test("does not force-refetch a busy session when the local tail is already a user message", async () => {
    replyCalls.length = 0
    const existingUser = {
      id: "msg_1",
      role: "user",
      sessionID: "session-busy-tail",
      time: { created: 1 },
    } as Message
    const existingAssistant = {
      id: "msg_2",
      role: "assistant",
      sessionID: "session-busy-tail",
      time: { created: 2 },
    } as Message
    const optimisticUser = {
      id: "msg_3",
      role: "user",
      sessionID: "session-busy-tail",
      time: { created: 3 },
    } as Message
    const store = createStore({}, {
      session: [{ id: "session-busy-tail", time: { created: 1 } } as Session],
      message: { "session-busy-tail": [existingUser, existingAssistant, optimisticUser] },
      part: {
        msg_1: [{ id: "prt_1", type: "text", text: "old" } as Part],
        msg_2: [{ id: "prt_2", type: "text", text: "reply" } as Part],
        msg_3: [{ id: "prt_3", type: "text", text: "new" } as Part],
      },
      session_status: { "session-busy-tail": { type: "busy" } },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await fetchMessagesForSession("session-busy-tail", "/test/project")

    expect(replyCalls.filter((call) => call.method === "session.messages")).toHaveLength(0)
  })

  test("still early-returns an idle renderable cache without refetching", async () => {
    replyCalls.length = 0
    const existingUser = {
      id: "msg_idle",
      role: "user",
      sessionID: "session-idle-cache",
      time: { created: 1 },
    } as Message
    const existingAssistant = {
      id: "msg_idle_assistant",
      role: "assistant",
      sessionID: "session-idle-cache",
      time: { created: 2 },
    } as Message
    const store = createStore({}, {
      session: [{ id: "session-idle-cache", time: { created: 1 } } as Session],
      message: { "session-idle-cache": [existingUser, existingAssistant] },
      part: {
        msg_idle: [{ id: "prt_idle", type: "text", text: "hi" } as Part],
        msg_idle_assistant: [{ id: "prt_idle_a", type: "text", text: "hello" } as Part],
      },
      session_status: { "session-idle-cache": { type: "idle" } },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await fetchMessagesForSession("session-idle-cache", "/test/project")

    expect(replyCalls.filter((call) => call.method === "session.messages")).toHaveLength(0)
  })

  test("refetches dirty same-size half-finished reasoning and materializes completed text", async () => {
    replyCalls.length = 0
    const sessionID = "session-dirty-reasoning"
    const existingUser = {
      id: "msg_dr_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const existingAssistant = {
      id: "msg_dr_assistant",
      role: "assistant",
      sessionID,
      time: { created: 2 },
    } as Message
    const halfReasoning = {
      id: "prt_dr_reasoning",
      messageID: "msg_dr_assistant",
      sessionID,
      type: "reasoning",
      text: "thinking half",
    } as Part
    const completeReasoning = {
      id: "prt_dr_reasoning",
      messageID: "msg_dr_assistant",
      sessionID,
      type: "reasoning",
      text: "thinking half complete answer",
      time: { end: 99 },
    } as Part
    mocks.sessionMessagesResult = {
      data: [
        { info: existingUser, parts: [{ id: "prt_dr_user", type: "text", text: "go" } as Part] },
        { info: { ...existingAssistant, finish: "stop", time: { created: 2, completed: 3 } }, parts: [completeReasoning] },
      ],
    }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingUser, existingAssistant] },
      part: {
        msg_dr_user: [{ id: "prt_dr_user", type: "text", text: "go" } as Part],
        msg_dr_assistant: [halfReasoning],
      },
      session_status: { [sessionID]: { type: "idle" } },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const { useSessionUIStore } = await import("./session-ui-store")
    const previousGetState = useSessionUIStore.getState
    useSessionUIStore.getState = () => ({
      ...previousGetState(),
      currentSessionId: sessionID,
      currentSessionDirectory: "/test/project",
    }) as ReturnType<typeof previousGetState>

    try {
      await fetchMessagesForSession(sessionID, "/test/project")
    } finally {
      useSessionUIStore.getState = previousGetState
    }

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    const stored = store.getState().part.msg_dr_assistant?.[0] as { text?: string; time?: { end?: number } }
    expect(stored?.text).toBe("thinking half complete answer")
    expect(stored?.time?.end).toBe(99)
  })

  test("optimisticInsertUserMessage returns false when optimistic ref is not mounted", async () => {
    const sessionID = "session-no-opt-ref"
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: {},
      part: {},
    })
    const childStores = createChildStores([["/test/project", store]])
    const { optimisticInsertUserMessage, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs(null as unknown as (input: OptimisticAddCall) => void, () => {})

    const inserted = optimisticInsertUserMessage({
      sessionId: sessionID,
      messageID: "msg_direct_user",
      content: "should not paint without shadow",
      providerID: "openai",
      modelID: "gpt-4o",
      directory: "/test/project",
    })

    expect(inserted).toBe(false)
    expect(store.getState().message[sessionID]).toBeUndefined()
  })

  test("optimisticInsertUserMessage inserts when canonical has a message shell without parts", async () => {
    const sessionID = "session-shell-user"
    const messageID = "msg_shell_user"
    const shell = {
      id: messageID,
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [shell] },
      part: { [messageID]: [] },
    })
    const childStores = createChildStores([["/test/project", store]])
    const added: OptimisticAddCall[] = []
    const { optimisticInsertUserMessage, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs((input) => { added.push(input) }, () => {})

    const inserted = optimisticInsertUserMessage({
      sessionId: sessionID,
      messageID,
      content: "hello after shell",
      providerID: "openai",
      modelID: "gpt-4o",
      directory: "/test/project",
    })

    expect(inserted).toBe(true)
    expect(added).toHaveLength(1)
    expect(added[0]?.message.id).toBe(messageID)
    expect(added[0]?.parts.length).toBeGreaterThan(0)
    expect((added[0]?.parts[0] as { text?: string })?.text).toBe("hello after shell")
    expect(store.getState().session_status[sessionID]).toEqual({ type: "busy" })
  })

  test("optimisticInsertUserMessage skips when canonical already has a complete row", async () => {
    const sessionID = "session-complete-user"
    const messageID = "msg_complete_user"
    const existing = {
      id: messageID,
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existing] },
      part: { [messageID]: [{ id: "prt_complete", type: "text", text: "already there" } as Part] },
    })
    const childStores = createChildStores([["/test/project", store]])
    const added: OptimisticAddCall[] = []
    const { optimisticInsertUserMessage, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs((input) => { added.push(input) }, () => {})

    const inserted = optimisticInsertUserMessage({
      sessionId: sessionID,
      messageID,
      content: "should not replace complete row",
      providerID: "openai",
      modelID: "gpt-4o",
      directory: "/test/project",
    })

    expect(inserted).toBe(false)
    expect(added).toHaveLength(0)
    expect(store.getState().session_status[sessionID]).toEqual({ type: "busy" })
  })

  test("a new/empty session's first complete page commits an exhausted boundary atomically", async () => {
    const sessionID = "session-new-boundary"
    mocks.sessionMessagesResult = { data: [] }
    mocks.hostTurnPageBehavior = { cursor: null, complete: true }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    expect(store.getState().session_history_boundary[sessionID]).toEqual({
      kind: "exhausted",
      loadedTurns: 0,
    })
    expect(store.getState().message[sessionID]).toEqual([])
  })

  test("cached user messages with an unknown boundary still fetch the authoritative tail", async () => {
    const sessionID = "session-unknown-boundary"
    const existingUser = {
      id: "msg_ub_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    mocks.sessionMessagesResult = {
      data: [{ info: existingUser, parts: [{ id: "prt_ub", type: "text", text: "hi" } as Part] }],
    }
    mocks.hostTurnPageBehavior = { cursor: null, complete: true }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingUser] },
      part: { msg_ub_user: [{ id: "prt_ub", type: "text", text: "hi" } as Part] },
      session_status: { [sessionID]: { type: "idle" } },
      // No session_history_boundary entry → unknown.
    })
    const childStores = createChildStores([["/test/project", store]])
    // Unknown boundary must still force an authoritative tail fetch (no prefetch cache).
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    expect(store.getState().session_history_boundary[sessionID]).toEqual({
      kind: "exhausted",
      loadedTurns: 1,
    })
  })

  test("a known exhausted boundary with resolved hasSession reuses the cache", async () => {
    const sessionID = "session-known-boundary"
    const existingUser = {
      id: "msg_kb_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingUser] },
      part: { msg_kb_user: [{ id: "prt_kb", type: "text", text: "hi" } as Part] },
      session_status: { [sessionID]: { type: "idle" } },
      session_history_boundary: {
        [sessionID]: { kind: "exhausted", loadedTurns: 1 },
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(0)
  })

  test("an incomplete first page with a cursor commits a has-more boundary", async () => {
    const sessionID = "session-cursor-boundary"
    const existingUser = {
      id: "msg_cb_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    mocks.sessionMessagesResult = {
      data: [{ info: existingUser, parts: [{ id: "prt_cb", type: "text", text: "hi" } as Part] }],
    }
    mocks.hostTurnPageBehavior = { cursor: "msg_cb_user", complete: false }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(store.getState().session_history_boundary[sessionID]).toEqual({
      kind: "has-more",
      cursor: "msg_cb_user",
      loadedTurns: 1,
    })
  })

  test("an unchanged page still commits the boundary (boundary-only commit)", async () => {
    const sessionID = "session-boundary-only"
    const existingUser = {
      id: "msg_bo_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const existingPart = { id: "prt_bo", type: "text", text: "hi" } as Part
    mocks.sessionMessagesResult = {
      data: [{ info: existingUser, parts: [existingPart] }],
    }
    mocks.hostTurnPageBehavior = { cursor: null, complete: true }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingUser] },
      part: { msg_bo_user: [existingPart] },
      session_status: { [sessionID]: { type: "idle" } },
      // Messages cached, boundary unknown — the page resolves to the same
      // messages, so only the boundary may change.
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    const messagesBefore = store.getState().message
    const partsBefore = store.getState().part
    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    // Message/part references stay stable; only the boundary was committed.
    expect(store.getState().message).toBe(messagesBefore)
    expect(store.getState().part).toBe(partsBefore)
    expect(store.getState().session_history_boundary[sessionID]).toEqual({
      kind: "exhausted",
      loadedTurns: 1,
    })
  })

  test("a switched-away stale completion does not commit messages or the boundary", async () => {
    const sessionID = "session-switched-away"
    const existingUser = {
      id: "msg_sa_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    mocks.sessionMessagesResult = {
      data: [{ info: existingUser, parts: [{ id: "prt_sa", type: "text", text: "hi" } as Part] }],
    }
    mocks.hostTurnPageBehavior = { cursor: null, complete: true }
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    // The user switched to another session before the fetch starts/settles.
    mocks.uiCurrentSessionId = "someone-else"

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
    // Nothing was repopulated: the next visit reads unknown and refetches.
    expect(store.getState().message[sessionID]).toBeUndefined()
    expect(store.getState().session_history_boundary[sessionID]).toBeUndefined()
  })

  test("a failed pull preserves the last known boundary without clearing transcript", async () => {
    const sessionID = "session-fail-boundary"
    // Cache holds an assistant tail with no authored user boundary, so it is not
    // reusable and a pull is required.
    const existingAssistant = {
      id: "msg_fb_assistant",
      role: "assistant",
      sessionID,
      time: { created: 2 },
    } as Message
    const known = { kind: "has-more", cursor: "msg_fb_user", loadedTurns: 2 } as const
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingAssistant] },
      part: {
        msg_fb_assistant: [{ id: "prt_fb_a", type: "text", text: "reply" } as Part],
      },
      session_status: { [sessionID]: { type: "busy" } },
      session_history_boundary: { [sessionID]: known },
    })
    const childStores = createChildStores([["/test/project", store]])
    // Force the Host page to fail. Ticket 09: prior boundary/messages stay;
    // request error is not written to session-prefetch-cache.
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID
    mocks.hostTurnPageBehavior = { cursor: null, complete: true, error: "host unreachable" }

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(store.getState().session_history_boundary[sessionID]).toEqual(known)
    expect(store.getState().message[sessionID]?.map((m) => m.id)).toEqual([
      "msg_fb_assistant",
    ])
    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(1)
  })

  test("opening a busy session reuses a complete cache instead of refetching the page", async () => {
    const sessionID = "ses_busy_reuse"
    // Mid-task shape: cache is complete (authored user boundary + known
    // boundary) and the tail is an assistant. This used to force the most
    // expensive request the client makes; SSE and reconnect compensation own
    // the tail now, so no turn page should be requested.
    const existingUser = {
      id: "msg_br_user",
      role: "user",
      sessionID,
      time: { created: 1 },
    } as Message
    const existingAssistant = {
      id: "msg_br_assistant",
      role: "assistant",
      sessionID,
      time: { created: 2 },
    } as Message
    const store = createStore({}, {
      session: [{ id: sessionID, time: { created: 1 } } as Session],
      message: { [sessionID]: [existingUser, existingAssistant] },
      part: {
        msg_br_user: [{ id: "prt_br", type: "text", text: "hi" } as Part],
        msg_br_assistant: [{ id: "prt_br_a", type: "text", text: "reply" } as Part],
      },
      session_status: { [sessionID]: { type: "busy" } },
      session_history_boundary: {
        [sessionID]: { kind: "has-more", cursor: "msg_br_user", loadedTurns: 2 },
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    mocks.uiCurrentSessionId = sessionID

    await fetchMessagesForSession(sessionID, "/test/project")

    expect(replyCalls.filter((call) => call.method === "host.session.turnPage")).toHaveLength(0)
    expect(store.getState().message[sessionID]?.map((m) => m.id)).toEqual([
      "msg_br_user",
      "msg_br_assistant",
    ])
  })
})

describe("abort queue dispatch block", () => {
  beforeEach(() => {
    replyCalls.length = 0
    abortBlockEvents.length = 0
    mocks.abortBlockToken = 0
    mocks.abortReject = false
    mocks.abortResult = { data: true }
  })

  test("creates the exact-scope block before the SDK abort and rolls back its token on failure", async () => {
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: {
        "session-a": [{ id: "assistant-pending", sessionID: "session-a", role: "assistant", time: { created: 2 } } as Message],
      },
      session_status: { "session-a": { type: "busy" } },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await abortCurrentOperation("session-a")
    expect(abortBlockEvents).toHaveLength(1)
    expect(abortBlockEvents[0]?.event).toBe("begin")
    expect(abortBlockEvents[0]?.scope.directory).toBe("/test/project")
    expect(abortBlockEvents[0]?.scope.sessionID).toBe("session-a")
    expect(abortBlockEvents[0]?.token).toBe("abort-1")
    expect(replyCalls.findIndex((call) => call.method === "session.abort")).toBeGreaterThanOrEqual(0)
    expect(store.getState().session_status["session-a"]).toEqual({ type: "idle" })
    expect(typeof store.getState().session_status_observed_at["session-a"]).toBe("number")

    mocks.abortReject = true
    await abortCurrentOperation("session-a")
    mocks.abortReject = false
    const [begin, clear] = abortBlockEvents.slice(-2)
    expect(begin?.event).toBe("begin")
    expect(clear?.event).toBe("clear")
    expect(begin?.scope).toEqual(clear?.scope)
    expect(begin?.token).toBe("abort-2")
    expect(clear?.token).toBe("abort-2")
  })

  test("rolls back the matching block for SDK error and false data responses", async () => {
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      session_status: { "session-a": { type: "busy" } },
      session_status_observed_at: { "session-a": 123 },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    for (const result of [
      { error: { message: "abort rejected" }, response: { status: 500 } },
      { data: false },
    ]) {
      mocks.abortResult = result
      await abortCurrentOperation("session-a")
      const [begin, clear] = abortBlockEvents.slice(-2)
      expect(begin?.event).toBe("begin")
      expect(clear?.event).toBe("clear")
      expect(clear?.token).toBe(begin?.token)
      expect(store.getState().session_status["session-a"]).toEqual({ type: "busy" })
      expect(store.getState().session_status_observed_at["session-a"]).toBe(123)
    }
  })
})

describe("resolveForkMessageId", () => {
  const userMessage = { id: "user-message", role: "user", sessionID: "session-a", time: { created: 2 } } as Message
  const assistantMessage = { id: "assistant-message", role: "assistant", sessionID: "session-a", time: { created: 3, completed: 4 } } as Message
  const nextMessage = { id: "next-message", role: "user", sessionID: "session-a", time: { created: 4 } } as Message
  const laterUser = { id: "later-user", role: "user", sessionID: "session-a", time: { created: 5 } } as Message
  const laterAssistant = { id: "later-assistant", role: "assistant", sessionID: "session-a", time: { created: 6, completed: 7 } } as Message
  const openAssistant = { id: "open-assistant", role: "assistant", sessionID: "session-a", time: { created: 8 } } as Message

  test("uses the exclusive cutoff after the latest user while a response is in progress", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "busy" })).toBe("assistant-message")
    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "retry", attempt: 1, message: "retrying", next: 0 })).toBe("assistant-message")
    expect(resolveForkMessageId(undefined, [userMessage], { type: "busy" })).toBe(undefined)
  })

  test("resolves explicit fork points against source message roles", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId("user-message", [userMessage, assistantMessage], { type: "busy" })).toBe("user-message")
    expect(resolveForkMessageId("assistant-message", [userMessage, assistantMessage, nextMessage], { type: "idle" })).toBe("next-message")
    expect(resolveForkMessageId("assistant-message", [userMessage, assistantMessage], { type: "idle" })).toBe(undefined)
    expect(resolveForkMessageId("unknown-message", [userMessage, assistantMessage], { type: "busy" })).toBe("unknown-message")
    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "idle" })).toBe(undefined)
  })

  test("copies the full history when status is missing and the tail is complete", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage, laterUser, laterAssistant], undefined)).toBe(undefined)
    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], undefined)).toBe(undefined)
    expect(resolveForkMessageId(undefined, [assistantMessage], undefined)).toBe(undefined)
  })

  test("treats a missing status entry as live only when the assistant tail is still open", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId(undefined, [userMessage, openAssistant], undefined)).toBe("open-assistant")
  })
})

describe("forkSession input restoration", () => {
  beforeEach(() => {
    replyCalls.length = 0
    mocks.clearAttachedFilesCalls = 0
    setCurrentSessionCalls.length = 0
    mocks.uiCurrentSessionId = "session-a"
    mocks.sessionMessagesResult = { data: [] }
    mocks.sessionGetResult = null
    mocks.globalActiveSessions = []
    mocks.globalArchivedSessions = []
    mocks.sessionForkResult = { id: "forked-session", title: "Source (fork #1)", time: { created: 2 } } as Session
    mocks.sessionUpdateResult = { data: mocks.sessionForkResult }
    Object.assign(inputState, {
      pendingInputText: "existing draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }],
    })
  })

  test("preserves composer attachments for a current-session fork without a message id", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const sessionStore = createStore({}, { session: [sourceSession], session_status: { "session-a": { type: "idle" } } })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await forkSession("session-a", 1)

    expect(replyCalls.find((call) => call.method === "session.fork")?.params.messageID).toBe(undefined)
    expect(mocks.clearAttachedFilesCalls).toBe(0)
    expect(inputState.attachedFiles).toEqual([{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }])
    expect(inputState.pendingInputText).toBe("existing draft")
  })

  test("copies the full history when the session status entry is missing", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const firstUser = { id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const firstAssistant = { id: "message-b", sessionID: "session-a", role: "assistant", time: { created: 2, completed: 3 } } as Message
    const laterUser = { id: "message-c", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const laterAssistant = { id: "message-d", sessionID: "session-a", role: "assistant", time: { created: 5, completed: 6 } } as Message
    // No session_status entry: idle snapshots omit idle sessions, so /fork
    // must copy the complete history rather than cut before the latest user turn.
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [firstUser, firstAssistant, laterUser, laterAssistant] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await expect(forkSession("session-a", 1)).resolves.toBe(true)

    expect(replyCalls.find((call) => call.method === "session.fork")?.params.messageID).toBe(undefined)
  })

  test("busy current-session fork includes the latest user by cutting before the following assistant", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const userMessage = { id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const assistantMessage = { id: "message-b", sessionID: "session-a", role: "assistant", time: { created: 2 } } as Message
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [userMessage, assistantMessage] },
      session_status: { "session-a": { type: "busy" } },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await expect(forkSession("session-a", 1)).resolves.toBe(true)

    expect(replyCalls.find((call) => call.method === "session.fork")?.params.messageID).toBe("message-b")
  })

  test("restores selected-message text and attachments", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const selectedMessage = { id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [selectedMessage] },
      session_status: { "session-a": { type: "idle" } },
      part: {
        "message-a": [
          { id: "text-a", messageID: "message-a", type: "text", text: "fork message" },
          { id: "file-a", messageID: "message-a", type: "file", url: "file:///fork.txt", mime: "text/plain", filename: "fork.txt" },
        ] as Part[],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await forkSession("session-a", 2, "message-a")

    expect(mocks.clearAttachedFilesCalls).toBe(1)
    expect(inputState.attachedFiles).toEqual([{ url: "file:///fork.txt", mimeType: "text/plain", filename: "fork.txt" }])
    expect(inputState.pendingInputText).toBe("fork message")
    expect(inputState.pendingInputText).not.toContain("/fork")
  })

  test("keeps the composer unchanged and passes the next message when forking from an assistant message", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const selectedMessage = { id: "message-a", sessionID: "session-a", role: "assistant", time: { created: 1 } } as Message
    const nextMessage = { id: "message-b", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    inputState.pendingInputText = "existing draft"
    inputState.attachedFiles = [{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }]
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [selectedMessage, nextMessage] },
      session_status: { "session-a": { type: "idle" } },
      part: {
        "message-a": [
          { id: "text-a", messageID: "message-a", type: "text", text: "assistant answer that must not enter the composer" },
        ] as Part[],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await forkSession("session-a", 2, "message-a")

    expect(replyCalls.find((call) => call.method === "session.fork")?.params.messageID).toBe("message-b")
    expect(mocks.clearAttachedFilesCalls).toBe(0)
    expect(inputState.pendingInputText).toBe("existing draft")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }])
  })

  test("hydrates source session from global store when child store has no session row", async () => {
    const sourceSession = {
      id: "session-a",
      title: "Cold start source",
      directory: "/test/project",
      time: { created: 1 },
    } as Session & { directory?: string }
    mocks.globalActiveSessions = [sourceSession]
    // Messages already loaded (user is viewing the chat) but session row missing — cold start race.
    const sessionStore = createStore({}, {
      session: [],
      message: {
        "session-a": [{ id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message],
      },
      session_status: { "session-a": { type: "idle" } },
      part: {
        "message-a": [
          { id: "text-a", messageID: "message-a", type: "text", text: "fork after cold start" },
        ] as Part[],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const completed = await forkSession("session-a", 3, "message-a")

    expect(completed).toBe(true)
    expect(sessionStore.getState().session.some((session) => session.id === "session-a")).toBe(true)
    expect(replyCalls.find((call) => call.method === "session.get")).toBeFalsy()
    expect(replyCalls.find((call) => call.method === "session.fork")?.params.sessionID).toBe("session-a")
    expect(inputState.pendingInputText).toBe("fork after cold start")
  })

  test("hydrates source session via session.get when global and child stores miss it", async () => {
    const sourceSession = { id: "session-a", title: "Fetched source", time: { created: 1 } } as Session
    mocks.sessionGetResult = sourceSession
    const sessionStore = createStore({}, {
      session: [],
      session_status: { "session-a": { type: "idle" } },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const completed = await forkSession("session-a", 4)

    expect(completed).toBe(true)
    expect(replyCalls.find((call) => call.method === "session.get")?.params).toEqual({
      sessionID: "session-a",
      directory: "/test/project",
    })
    // Fork also inserts the forked session; source must still be present.
    expect(sessionStore.getState().session.some((session) => session.id === "session-a")).toBe(true)
    expect(sessionStore.getState().session.some((session) => session.id === "forked-session")).toBe(true)
    expect(replyCalls.find((call) => call.method === "session.fork")?.params.sessionID).toBe("session-a")
  })

  test("does not yank selection or restore composer when the user left the source session", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const selectedMessage = { id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    mocks.uiCurrentSessionId = "session-b"
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [selectedMessage] },
      session_status: { "session-a": { type: "idle" } },
      part: {
        "message-a": [
          { id: "text-a", messageID: "message-a", type: "text", text: "fork message" },
          { id: "file-a", messageID: "message-a", type: "file", url: "file:///fork.txt", mime: "text/plain", filename: "fork.txt" },
        ] as Part[],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const completed = await forkSession("session-a", 5, "message-a")

    expect(completed).toBe(true)
    expect(setCurrentSessionCalls).toEqual([])
    expect(mocks.uiCurrentSessionId).toBe("session-b")
    expect(mocks.clearAttachedFilesCalls).toBe(0)
    expect(inputState.pendingInputText).toBe("existing draft")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }])
    expect(sessionStore.getState().session.some((session) => session.id === "forked-session")).toBe(true)
  })

  test("selects the forked session as soon as OpenCode returns the id, before transcript load", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    let releasePromote!: () => void
    const promoteGate = new Promise<void>((resolve) => {
      releasePromote = resolve
    })
    vi.mocked(opencodeClient.updateSession).mockImplementationOnce(async (sessionId, changes, directory) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      await promoteGate
      return mocks.sessionUpdateResult.data as Session
    })
    const sessionStore = createStore({}, {
      session: [sourceSession],
      session_status: { "session-a": { type: "idle" } },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const completed = forkSession("session-a", 6)
    await vi.waitFor(() => {
      expect(setCurrentSessionCalls[0]).toEqual({
        sessionId: "forked-session",
        directory: "/test/project",
        options: { skipMessageFetch: true },
      })
    })
    expect(sessionStore.getState().session.some((session) => session.id === "forked-session")).toBe(true)

    releasePromote()
    await expect(completed).resolves.toBe(true)
  })

  test("does not restore composer onto the source after the user returns from the fork", async () => {
    const sourceSession = { id: "session-a", title: "Source", time: { created: 1 } } as Session
    const selectedMessage = { id: "message-a", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    let releasePromote!: () => void
    const promoteGate = new Promise<void>((resolve) => {
      releasePromote = resolve
    })
    vi.mocked(opencodeClient.updateSession).mockImplementationOnce(async (sessionId, changes, directory) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      await promoteGate
      return mocks.sessionUpdateResult.data as Session
    })
    const sessionStore = createStore({}, {
      session: [sourceSession],
      message: { "session-a": [selectedMessage] },
      session_status: { "session-a": { type: "idle" } },
      part: {
        "message-a": [
          { id: "text-a", messageID: "message-a", type: "text", text: "fork message" },
          { id: "file-a", messageID: "message-a", type: "file", url: "file:///fork.txt", mime: "text/plain", filename: "fork.txt" },
        ] as Part[],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { forkSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const completed = forkSession("session-a", 7, "message-a")
    await vi.waitFor(() => {
      expect(setCurrentSessionCalls[0]?.sessionId).toBe("forked-session")
    })
    mocks.uiCurrentSessionId = "session-a"
    releasePromote()
    await expect(completed).resolves.toBe(true)

    expect(mocks.clearAttachedFilesCalls).toBe(0)
    expect(inputState.pendingInputText).toBe("existing draft")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }])
  })
})

describe("shareSession live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    mocks.sessionShareResult = {}
  })

  test("updates the directory live store after unsharing", async () => {
    const sharedSession = { id: "session-a", time: { created: 1 }, share: { url: "https://share.example/a" } } as Session
    const unsharedSession = { id: "session-a", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const otherStore = createStore({}, { session: [{ id: "other", time: { created: 1 } } as Session] })
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/other/project", otherStore],
    ])
    mocks.sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await unshareSession("session-a")

    expect(result).toBe(unsharedSession)
    expect(replyCalls.find((call) => call.method === "session.unshare")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share).toBe(undefined)
    expect(otherStore.getState().session[0].id).toBe("other")
    expect(globalUpsertedSessions).toEqual([unsharedSession])
  })

  test("updates the directory live store after sharing", async () => {
    const unsharedSession = { id: "session-a", time: { created: 1 } } as Session
    const sharedSession = { id: "session-a", time: { created: 1, updated: 2 }, share: { url: "https://share.example/a" } } as Session
    const sessionStore = createStore({}, { session: [unsharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionShareResult = { data: sharedSession }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    expect(result).toBe(sharedSession)
    expect(replyCalls.find((call) => call.method === "session.share")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share?.url).toBe("https://share.example/a")
    expect(globalUpsertedSessions).toEqual([sharedSession])
  })

  test("preserves live directory metadata while clearing share from null response", async () => {
    const sharedSession = {
      id: "session-a",
      time: { created: 1 },
      directory: "/test/project",
      project: { worktree: "/test/project" },
      share: { url: "https://share.example/a" },
    } as SessionWithDirectory
    const unsharedSession = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: null,
    } as unknown as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await unshareSession("session-a")

    const liveSession = sessionStore.getState().session[0] as SessionWithDirectory & { share?: null }
    expect(liveSession.share).toBe(null)
    expect(liveSession.directory).toBe("/test/project")
    expect(liveSession.project?.worktree).toBe("/test/project")
  })

  test("strips oversized diff snapshots before updating session stores", async () => {
    const sessionWithDiff = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: { url: "https://share.example/a" },
      summary: {
        diffs: [{ file: "a.txt", before: "old", after: "new", additions: 1, deletions: 1 }],
      },
    } as unknown as Session
    const sessionStore = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionShareResult = { data: sessionWithDiff }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    const storedDiff = ((sessionStore.getState().session[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    const globalDiff = (((globalUpsertedSessions[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0])
    const resultDiff = ((result as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    expect(storedDiff.before).toBe(undefined)
    expect(storedDiff.after).toBe(undefined)
    expect(globalDiff.before).toBe(undefined)
    expect(resultDiff.after).toBe(undefined)
  })
})

describe("updateSessionTitle live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    mocks.sessionUpdateResult = {}
  })

  test("updates the live directory store after renaming", async () => {
    const oldSession = { id: "session-a", title: "Old Title", time: { created: 1, updated: 1 } } as Session
    const updatedSession = { id: "session-a", title: "New Title", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await updateSessionTitle("session-a", "New Title")

    const updateCall = replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("session-a")
    expect(updateCall?.params.title).toBe("New Title")
    expect(updateCall?.params.directory).toBe("/test/project")
    expect(globalUpsertedSessions).toEqual([updatedSession])
    expect(sessionStore.getState().session[0].title).toBe("New Title")
  })
})

describe("requestSessionSmartTitle", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    mocks.globalActiveSessions = []
    mocks.sessionUpdateResult = {}
  })

  test("writes titleRefresh.requestedAt and mirrors the updated session", async () => {
    const oldSession = {
      id: "session-a",
      title: "Old Title",
      time: { created: 1, updated: 1 },
      metadata: {
        openchamber: {
          titleRefresh: { lastAutoTitle: "prior" },
        },
      },
    } as unknown as Session
    const updatedSession = {
      ...oldSession,
      time: { created: 1, updated: 2 },
      metadata: {
        openchamber: {
          titleRefresh: {
            lastAutoTitle: "Old Title",
            requestedAt: 123,
          },
        },
      },
    } as unknown as Session
    mocks.globalActiveSessions = [oldSession]
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, requestSessionSmartTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const before = Date.now()
    await requestSessionSmartTitle("session-a")
    const after = Date.now()

    const updateCall = replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("session-a")
    expect(updateCall?.params.directory).toBe("/test/project")
    expect(updateCall?.params.title).toBe(undefined)
    const titleRefresh = (
      updateCall?.params.metadata as {
        openchamber?: { titleRefresh?: { lastAutoTitle?: string; requestedAt?: number } }
      }
    )?.openchamber?.titleRefresh
    expect(titleRefresh?.lastAutoTitle).toBe("Old Title")
    expect(typeof titleRefresh?.requestedAt).toBe("number")
    expect(titleRefresh!.requestedAt!).toBeGreaterThanOrEqual(before)
    expect(titleRefresh!.requestedAt!).toBeLessThanOrEqual(after)
    expect(globalUpsertedSessions).toEqual([updatedSession])
  })
})

describe("optimisticSend target directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.sessionMessagesResult = { data: [] }
    configStoreState.isConnected = true
    configStoreState.hasEverConnected = true
    pendingSendTransitions.length = 0
  })

  afterEach(() => {
    deactivateRelayTunnel()
    resetStreamLivenessForTests()
  })

  test("keeps the pending send status until the prompt request settles for every runtime", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let releaseSend!: () => void
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    const send = optimisticSend({
      sessionId: "session-send",
      directory: "/target/project",
      content: "pending message",
      providerID: "provider",
      modelID: "model",
      messageID: "message-pending",
      send: () => sendGate,
    })

    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-pending' },
    ])

    releaseSend()
    await send

    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-pending' },
      { state: 'clear', sessionId: 'session-send', messageID: 'message-pending' },
    ])
  })

  test("clears pending send by message id so an older settle cannot erase a newer concurrent pending", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    const olderSend = optimisticSend({
      sessionId: "session-send",
      directory: "/target/project",
      content: "first",
      providerID: "provider",
      modelID: "model",
      messageID: "message-old",
      send: () => oldGate,
    })

    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-old' },
    ])

    const newerSend = optimisticSend({
      sessionId: "session-send",
      directory: "/target/project",
      content: "second",
      providerID: "provider",
      modelID: "model",
      messageID: "message-new",
      send: () => newGate,
    })

    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-old' },
      { state: 'mark', sessionId: 'session-send', messageID: 'message-new' },
    ])

    releaseOld()
    await olderSend
    // Older clear is still invoked with its own messageID; production store only
    // deletes when the session's pending id still matches that messageID.
    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-old' },
      { state: 'mark', sessionId: 'session-send', messageID: 'message-new' },
      { state: 'clear', sessionId: 'session-send', messageID: 'message-old' },
    ])

    releaseNew()
    await newerSend
    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-old' },
      { state: 'mark', sessionId: 'session-send', messageID: 'message-new' },
      { state: 'clear', sessionId: 'session-send', messageID: 'message-old' },
      { state: 'clear', sessionId: 'session-send', messageID: 'message-new' },
    ])
  })

  test("clears pending send after pre-dispatch failure", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    configStoreState.isConnected = false

    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-send",
        directory: "/target/project",
        content: "offline",
        providerID: "provider",
        modelID: "model",
        messageID: "message-fail",
        send: async () => {},
      })
    } catch (error) {
      caught = error
    }

    expect(getSendFailureKind(caught)).toBe("pre-dispatch")
    expect(pendingSendTransitions).toEqual([
      { state: 'mark', sessionId: 'session-send', messageID: 'message-fail' },
      { state: 'clear', sessionId: 'session-send', messageID: 'message-fail' },
    ])
  })

  test("inserts the optimistic user row before waiting for connection recovery", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let sendCalled = false
    configStoreState.isConnected = false

    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
        // Mirror production optimisticAdd: paint the row into the directory store.
        const current = targetStore.getState()
        const messages = current.message[input.sessionID] ? [...current.message[input.sessionID]] : []
        messages.push(input.message)
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part: { ...current.part, [input.message.id]: input.parts },
          session_status: { ...current.session_status, [input.sessionID]: { type: "busy" as const } },
          session_status_observed_at: { ...current.session_status_observed_at, [input.sessionID]: Date.now() },
        })
      },
      (input) => {
        optimisticRemove = input
        const current = targetStore.getState()
        const messages = (current.message[input.sessionID] ?? []).filter((message) => message.id !== input.messageID)
        const part = { ...current.part }
        delete part[input.messageID]
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part,
        })
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-idle",
        directory: "/target/project",
        content: "after long idle",
        providerID: "provider",
        modelID: "model",
        send: async () => {
          sendCalled = true
        },
      })
    } catch (error) {
      caught = error
    }

    expect(optimisticAdd).not.toBeNull()
    expect((optimisticAdd as unknown as OptimisticAddCall).sessionID).toBe("session-idle")
    expect((optimisticAdd as unknown as OptimisticAddCall).message.role).toBe("user")
    // Connection never recovered — transport must not enter, and the optimistic
    // row is rolled back as a pre-dispatch failure.
    expect(sendCalled).toBe(false)
    expect(getSendFailureKind(caught)).toBe("pre-dispatch")
    expect((optimisticRemove as OptimisticRemoveCall | null)?.sessionID).toBe("session-idle")
    expect(targetStore.getState().session_status["session-idle"]?.type).toBe("idle")
  })

  test("dispatches send over a live relay tunnel even when the event pipeline is disconnected", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    configStoreState.isConnected = false
    adoptRelayTunnel(
      {
        relayUrl: "ws://relay.test/ws",
        serverId: "server-1",
        hostEncPubJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" },
      },
      {
        getStatus: () => ({ state: "connected" }),
        fetch: async () => new Response(null, { status: 204 }),
        openWebSocket: () => {
          throw new Error("unused")
        },
        subscribeStatus: () => () => undefined,
        close: () => undefined,
      } as unknown as RelayTunnelClient,
    )
    let sendCalled = false

    const { waitForConnectionOrThrow, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    const started = Date.now()
    await waitForConnectionOrThrow()
    expect(Date.now() - started).toBeLessThan(200)

    await optimisticSend({
      sessionId: "session-send",
      directory: "/target/project",
      content: "relay send",
      providerID: "provider",
      modelID: "model",
      messageID: "message-relay",
      send: async () => {
        sendCalled = true
      },
    })
    expect(sendCalled).toBe(true)
  })

  test("reconnects a stale event stream before trusting isConnected for send", async () => {
    const reasons: string[] = []
    bindStreamReconnect((reason) => {
      reasons.push(reason ?? "")
      configStoreState.isConnected = false
    })
    noteStreamActivity(Date.now() - STREAM_STALE_MS)
    configStoreState.isConnected = true
    configStoreState.probeConnection = async () => {
      configStoreState.isConnected = true
      noteStreamActivity(Date.now())
      return true
    }

    const { waitForConnectionOrThrow } = await import("./session-actions")
    try {
      await waitForConnectionOrThrow()
      expect(reasons).toEqual(["send_stream_stale"])
      expect(configStoreState.isConnected).toBe(true)
    } finally {
      configStoreState.probeConnection = async () => configStoreState.isConnected
    }
  })

  test("passes the prompt directory to optimistic state during session switch races", async () => {
    const currentStore = createStore({})
    const targetStore = createStore({})
    const childStores = createChildStores([
      ["/current/project", currentStore],
      ["/target/project", targetStore],
    ])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    await optimisticSend({
      sessionId: "session-new",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
      },
    })

    expect(optimisticAdd).not.toBeNull()
    const add = optimisticAdd as unknown as OptimisticAddCall
    expect(add.directory).toBe("/target/project")
    expect(add.sessionID).toBe("session-new")
    expect(add.message.id).toBe(sentMessageID)
    expect(optimisticRemove).toBe(null)
    expect(targetStore.getState().session_status["session-new"]?.type).toBe("busy")
    expect(typeof targetStore.getState().session_status_observed_at["session-new"]).toBe("number")
    expect(currentStore.getState().session_status["session-new"]).toBe(undefined)
  })

  test("allows callers to block final send when runtime changes after optimistic insert", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let finalSendCalled = false
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })

    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-race",
        directory: "/target/project",
        content: "hello",
        providerID: "provider",
        modelID: "model",
        beforeOptimisticInsert: () => {
          expect(getRuntimeKey()).toBe("runtime-a")
        },
        send: async () => {
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
          if (getRuntimeKey() !== "runtime-a") throw new Error("Auto-review stopped because the runtime changed.")
          finalSendCalled = true
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("runtime changed")
    expect(getSendFailureKind(caught)).toBe("ambiguous-dispatched")

    expect(optimisticAdd).not.toBeNull()
    expect(finalSendCalled).toBe(false)
    expect(optimisticRemove).toBeNull()
    expect(targetStore.getState().session_status["session-race"]?.type).toBe("busy")
  })

  test("confirms an ambiguous send failure with a recent message refetch", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    await optimisticSend({
      sessionId: "session-confirmed",
      directory: "/target/project",
      content: "hello",
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
        mocks.sessionMessagesResult = {
          data: [{
            info: { id: messageID, role: "user", sessionID: "session-confirmed", time: { created: 1 } } as Message,
            parts: [{ id: "server-part", type: "text", text: "hello" } as Part],
          }],
        }
        const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
        error.status = 504
        throw error
      },
    })

    expect(optimisticRemove).toBe(null)
    expect((optimisticConfirm as OptimisticRemoveCall | null)?.messageID).toBe(sentMessageID)
    expect(replyCalls.find((call) => call.method === "session.messages")?.params.limit).toBe(30)
    expect(targetStore.getState().message["session-confirmed"]?.[0]?.id).toBe(sentMessageID)
    expect(targetStore.getState().part[sentMessageID]?.[0]?.id).toBe("server-part")
  })

  test("rolls back an ambiguous send failure when recent messages do not contain the sent ID", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-missing",
        directory: "/target/project",
        content: "hello",
        providerID: "provider",
        modelID: "model",
        send: async () => {
          const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((optimisticRemove as OptimisticRemoveCall | null)?.sessionID).toBe("session-missing")
    expect(optimisticConfirm).toBe(null)
    expect(replyCalls.filter((call) => call.method === "session.messages").every((call) => call.params.limit === 30)).toBe(true)
    expect(targetStore.getState().session_status["session-missing"]?.type).toBe("idle")
    expect(typeof targetStore.getState().session_status_observed_at["session-missing"]).toBe("number")
  })

  test("beginOptimisticSend paints the optimistic row and sending status before settle", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let sendCalled = false

    const { beginOptimisticSend, settleOptimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
        const current = targetStore.getState()
        const messages = current.message[input.sessionID] ? [...current.message[input.sessionID]] : []
        messages.push(input.message)
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part: { ...current.part, [input.message.id]: input.parts },
          session_status: { ...current.session_status, [input.sessionID]: { type: "busy" as const } },
          session_status_observed_at: { ...current.session_status_observed_at, [input.sessionID]: Date.now() },
        })
      },
      () => {},
    )

    const ticket = beginOptimisticSend({
      sessionId: "session-begin",
      directory: "/target/project",
      content: "hello begin",
      providerID: "provider",
      modelID: "model",
      messageID: "message-begin",
    })

    expect(ticket.messageID).toBe("message-begin")
    const { hasPendingUserSendAnimation } = await import("@/lib/userSendAnimation")
    expect(hasPendingUserSendAnimation("session-begin")).toBe(true)
    expect(optimisticAdd).not.toBeNull()
    expect((optimisticAdd as unknown as OptimisticAddCall).message.id).toBe("message-begin")
    expect(targetStore.getState().session_status["session-begin"]?.type).toBe("busy")
    expect(pendingSendTransitions).toEqual([
      { state: "mark", sessionId: "session-begin", messageID: "message-begin" },
    ])
    expect(sendCalled).toBe(false)

    await settleOptimisticSend({
      ticket,
      send: async (messageID) => {
        expect(messageID).toBe("message-begin")
        sendCalled = true
      },
    })

    expect(sendCalled).toBe(true)
    expect(pendingSendTransitions).toEqual([
      { state: "mark", sessionId: "session-begin", messageID: "message-begin" },
      { state: "clear", sessionId: "session-begin", messageID: "message-begin" },
    ])
    const { resetUserSendAnimationForTests } = await import("@/lib/userSendAnimation")
    resetUserSendAnimationForTests()
  })

  test("ticket settle failure rolls back the optimistic row without double insert", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAddCount = 0
    let optimisticRemove: OptimisticRemoveCall | null = null

    const {
      beginOptimisticSend,
      settleOptimisticSend,
      getSendFailureKind,
      setActionRefs,
      setOptimisticRefs,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAddCount += 1
        const current = targetStore.getState()
        const messages = current.message[input.sessionID] ? [...current.message[input.sessionID]] : []
        messages.push(input.message)
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part: { ...current.part, [input.message.id]: input.parts },
          session_status: { ...current.session_status, [input.sessionID]: { type: "busy" as const } },
          session_status_observed_at: { ...current.session_status_observed_at, [input.sessionID]: Date.now() },
        })
      },
      (input) => {
        optimisticRemove = input
        const current = targetStore.getState()
        const messages = (current.message[input.sessionID] ?? []).filter((message) => message.id !== input.messageID)
        const part = { ...current.part }
        delete part[input.messageID]
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part,
        })
      },
    )

    const ticket = beginOptimisticSend({
      sessionId: "session-ticket-fail",
      directory: "/target/project",
      content: "will fail",
      providerID: "provider",
      modelID: "model",
      messageID: "message-ticket-fail",
    })
    expect(optimisticAddCount).toBe(1)

    let caught: unknown = null
    try {
      await settleOptimisticSend({
        ticket,
        send: async () => {
          throw Object.assign(new Error("bad request"), { status: 400 })
        },
      })
    } catch (error) {
      caught = error
    }

    expect(getSendFailureKind(caught)).toBe("definitive-rejection")
    expect(optimisticAddCount).toBe(1)
    expect((optimisticRemove as OptimisticRemoveCall | null)?.messageID).toBe("message-ticket-fail")
    expect(targetStore.getState().session_status["session-ticket-fail"]?.type).toBe("idle")
    expect(pendingSendTransitions.filter((t) => t.messageID === "message-ticket-fail")).toEqual([
      { state: "mark", sessionId: "session-ticket-fail", messageID: "message-ticket-fail" },
      { state: "clear", sessionId: "session-ticket-fail", messageID: "message-ticket-fail" },
    ])
  })

  test("stale runtime rollback skips optimisticRemove but still clears this message pending", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { beginOptimisticSend, rollbackOptimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        const current = targetStore.getState()
        const messages = current.message[input.sessionID] ? [...current.message[input.sessionID]] : []
        messages.push(input.message)
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part: { ...current.part, [input.message.id]: input.parts },
          session_status: { ...current.session_status, [input.sessionID]: { type: "busy" as const } },
        })
      },
      (input) => { optimisticRemove = input },
    )

    const ticket = beginOptimisticSend({
      sessionId: "session-stale-rollback",
      directory: "/target/project",
      content: "stale",
      providerID: "provider",
      modelID: "model",
      messageID: "message-stale-rollback",
    })
    expect(targetStore.getState().message["session-stale-rollback"]?.map((message) => message.id)).toEqual(["message-stale-rollback"])

    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
    rollbackOptimisticSend(ticket)

    // Stale capture+transport must not invoke the live remove hook (new runtime may share IDs).
    expect(optimisticRemove).toBeNull()
    expect(targetStore.getState().message["session-stale-rollback"]?.map((message) => message.id)).toEqual(["message-stale-rollback"])
    expect(pendingSendTransitions).toEqual([
      { state: "mark", sessionId: "session-stale-rollback", messageID: "message-stale-rollback" },
      { state: "clear", sessionId: "session-stale-rollback", messageID: "message-stale-rollback" },
    ])
  })

  test("optimisticSend with ticket reuses messageID and never double-inserts", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAddCount = 0
    let transmittedMessageID = ""

    const { beginOptimisticSend, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAddCount += 1
        const current = targetStore.getState()
        const messages = current.message[input.sessionID] ? [...current.message[input.sessionID]] : []
        if (!messages.some((message) => message.id === input.message.id)) {
          messages.push(input.message)
        }
        targetStore.setState({
          message: { ...current.message, [input.sessionID]: messages },
          part: { ...current.part, [input.message.id]: input.parts },
          session_status: { ...current.session_status, [input.sessionID]: { type: "busy" as const } },
        })
      },
      () => {},
    )

    const ticket = beginOptimisticSend({
      sessionId: "session-reuse",
      directory: "/target/project",
      content: "reuse",
      providerID: "provider",
      modelID: "model",
      messageID: "message-reuse",
    })
    expect(optimisticAddCount).toBe(1)

    await optimisticSend({
      sessionId: "session-reuse",
      directory: "/target/project",
      content: "reuse",
      providerID: "provider",
      modelID: "model",
      ticket,
      send: async (messageID) => {
        transmittedMessageID = messageID
      },
    })

    expect(optimisticAddCount).toBe(1)
    expect(transmittedMessageID).toBe("message-reuse")
    expect(ticket.messageID).toBe("message-reuse")
  })
})

describe("queue reconciliation optimistic cleanup", () => {
  test("removes the exact optimistic row while preserving authoritative busy status", async () => {
    const targetStore = createStore({}, {
      session_status: { "queued-session": { type: "busy" } },
    })
    const childStores = createChildStores([["/target/project", targetStore]])
    let removed: OptimisticRemoveCall | null = null
    const { releaseUnconfirmedQueueSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
    setOptimisticRefs(() => {}, (input) => { removed = input })

    releaseUnconfirmedQueueSend({
      sessionID: "queued-session",
      messageID: "queued-message-id",
      directory: "/target/project",
    })

    expect(removed).toEqual({
      sessionID: "queued-session",
      messageID: "queued-message-id",
      directory: "/target/project",
    })
    expect(targetStore.getState().session_status["queued-session"]?.type).toBe("busy")
  })
})

describe("send failure classification", () => {
  test("separates pre-dispatch, authoritative rejection, and ambiguous dispatched failures", async () => {
    const { classifySendFailure } = await import("./session-actions")
    expect(classifySendFailure(new Error("connection wait failed"), false)).toBe("pre-dispatch")
    expect(classifySendFailure(Object.assign(new Error("bad request"), { status: 400 }), true)).toBe("definitive-rejection")
    expect(classifySendFailure(new Error("transport closed"), true)).toBe("ambiguous-dispatched")
    for (const failure of [
      new TypeError("Failed to fetch"),
      Object.assign(new Error("timeout"), { status: 408 }),
      Object.assign(new Error("unavailable"), { status: 503 }),
      Object.assign(new Error("gateway timeout"), { status: 504 }),
    ]) {
      expect(classifySendFailure(failure, true)).toBe("ambiguous-dispatched")
    }
  })

  test("reports an expired scope before transport entry as pre-dispatch", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "pre-dispatch-session",
        directory: "/target/project",
        content: "blocked",
        providerID: "provider",
        modelID: "model",
        beforeOptimisticInsert: () => {
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
        },
        send: async () => {},
      })
    } catch (error) {
      caught = error
    }

    expect(getSendFailureKind(caught)).toBe("pre-dispatch")
  })

  test("preserves queued optimistic state after ambiguous dispatch and reuses its message ID", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let transmittedMessageID = ""
    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, (input) => { optimisticRemove = input })

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "queued-session",
        directory: "/target/project",
        content: "queued",
        providerID: "provider",
        modelID: "model",
        messageID: "queued-message-id",
        preserveOptimisticOnAmbiguous: true,
        send: async (messageID) => {
          transmittedMessageID = messageID
          throw new TypeError("Failed to fetch")
        },
      })
    } catch (error) {
      caught = error
    }
    expect(getSendFailureKind(caught)).toBe("ambiguous-dispatched")

    expect(transmittedMessageID).toBe("queued-message-id")
    expect(optimisticRemove).toBeNull()
    expect(targetStore.getState().session_status["queued-session"]?.type).toBe("busy")
  })

  test("cleans up definitive rejections and ignores a late result for a recreated child store", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let removed: OptimisticRemoveCall | null = null
    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, (input) => { removed = input })

    let caught: unknown = null
    try {
      await optimisticSend({
      sessionId: "rejected-session",
      directory: "/target/project",
      content: "reject",
      providerID: "provider",
      modelID: "model",
      send: async () => { throw Object.assign(new Error("bad request"), { status: 400 }) },
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe("bad request")
    expect(getSendFailureKind(caught)).toBe("definitive-rejection")
    expect((removed as OptimisticRemoveCall | null)?.sessionID).toBe("rejected-session")
    expect(targetStore.getState().session_status["rejected-session"]?.type).toBe("idle")
  })

  test("marks a resolved send with an expired runtime capture as ambiguous without confirming", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let confirmed = false
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    const { getSendFailureKind, optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
    setOptimisticRefs(() => {}, () => {})

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "expired-session",
        directory: "/target/project",
        content: "sent",
        providerID: "provider",
        modelID: "model",
        onSendConfirmed: () => { confirmed = true },
        send: async () => {
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
        },
      })
    } catch (error) {
      caught = error
    }

    expect(getRuntimeKey()).toBe("runtime-b")
    expect(getSendFailureKind(caught)).toBe("ambiguous-dispatched")
    expect(confirmed).toBe(false)
  })
})

describe("respondToPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.sessionRevertResult = {}
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })
})

describe("revertToMessage passes session directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.sessionRevertResult = {}
    draftCommits.length = 0
    mocks.draftRevisionByKey = new Map()
    mocks.draftCommitShouldFail = false
    mocks.draftCommitFailAfter = 0
    mocks.draftCommitCount = 0
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
      drafts: {},
    })
  })

  test("routes revert through the session directory instead of the current directory", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const currentStore = createStore({})
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/current/project", currentStore],
    ])
    mocks.sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await revertToMessage("session-a", "msg_2")

    expect(replyCalls.find((call) => call.method === "session.revert")?.params.directory).toBe("/test/project")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    expect(currentStore.getState().session).toHaveLength(0)
    expect(draftCommits.at(-1)?.snapshot.text).toBe("edit this")
  })

  test("throws before mutating marker or draft when the target user message is missing", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await expect(revertToMessage("session-a", "missing")).rejects.toThrow("The selected user message is unavailable")
    expect(replyCalls.find((call) => call.method === "session.revert")).toBe(undefined)
    expect((sessionStore.getState().session[0] as Session & { revert?: unknown }).revert).toBe(undefined)
    expect(draftCommits).toHaveLength(0)
  })

  test("returns a scoped restoration snapshot into an explicit DraftKey", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const sessionStore = createStore({}, { session: [session], message: { "session-a": [targetMessage] }, part: { "msg_2": [{ id: "text", messageID: "msg_2", type: "text", text: "assistant draft" } as Part, { id: "file", messageID: "msg_2", type: "file", url: "https://files.example/a", mime: "text/plain", filename: "a.txt" } as Part] } })
    mocks.sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", sessionStore]]), () => "/current/project")
    const { getRuntimeTransportIdentity } = await import("../lib/runtime-switch")
    const surfaceKey = { transportIdentity: getRuntimeTransportIdentity(), owner: { kind: "surface" as const, ownerID: "assistant:a" } }
    const snapshot = await revertToMessage("session-a", "msg_2", { directory: "/test/project", draftKey: surfaceKey, restorePrimaryInput: false })
    expect(snapshot.snapshot.text).toBe("assistant draft")
    expect(snapshot.snapshot.attachments.some((attachment) => attachment.locator.kind === "url" && attachment.locator.url === "https://files.example/a")).toBe(true)
    expect(draftCommits.at(-1)?.key.owner).toEqual({ kind: "surface", ownerID: "assistant:a" })
    expect(inputState.pendingInputText).toBe("previous draft")
  })

  test("rolls back optimistic revert and draft when the SDK returns an error", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionRevertResult = { error: { message: "rejected" }, response: { status: 500 } }
    const { getRuntimeTransportIdentity } = await import("../lib/runtime-switch")
    const transportIdentity = getRuntimeTransportIdentity()
    const draftKeyId = JSON.stringify([transportIdentity, "session", "session-a"])
    mocks.draftRevisionByKey.set(draftKeyId, 2)
    inputState.drafts[draftKeyId] = { revision: 2, text: "previous draft" }
    inputState.captureDraftRuntime = () => ({ transportIdentity, generation: 1 })

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("session.revert failed (500)")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert).toBe(undefined)
    // First commit restores message; second commit rolls back previous draft.
    expect(draftCommits.length).toBeGreaterThanOrEqual(2)
    expect(draftCommits.at(-1)?.snapshot.text).toBe("previous draft")
  })
})

describe("message edit staging", () => {
  beforeEach(() => {
    replyCalls.length = 0
    mocks.sessionDeleteMessageFailureID = null
    mocks.sessionMessagesResult = { data: [] }
    mocks.uiPendingSendMessageIDs = new Map()
    draftCommits.length = 0
    mocks.draftRevisionByKey = new Map()
    mocks.draftCommitShouldFail = false
    mocks.draftCommitFailAfter = 0
    mocks.draftCommitCount = 0
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }],
      drafts: {},
    })
  })

  test("restores the user draft without deleting session messages", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const assistantMessage = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message
    const laterMessage = { id: "msg_4", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const targetParts = [
      { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" },
      { id: "file_2", messageID: "msg_2", type: "file", url: "file:///attached.txt", mime: "text/plain", filename: "attached.txt" },
    ] as Part[]
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, assistantMessage, laterMessage] },
      part: {
        "msg_2": targetParts,
        "msg_3": [{ id: "prt_3", messageID: "msg_3", type: "text", text: "answer" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "later" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])

    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await stageMessageEdit("session-a", "msg_2")

    expect(replyCalls.filter((call) => call.method === "session.deleteMessage")).toHaveLength(0)
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_2", "msg_3", "msg_4"])
    expect(sessionStore.getState().part["msg_2"]).toEqual(targetParts)
    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.snapshot.text).toBe("edit this")
    expect(draftCommits[0]?.snapshot.attachments.some((attachment) => attachment.locator?.kind === "url" && attachment.locator.url === "file:///attached.txt")).toBe(true)
  })

  test("stages an empty composer draft when the store user message has no part key", async () => {
    const sessionStore = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: { "session-a": [{ id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await stageMessageEdit("session-a", "msg_2")

    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.snapshot.text).toBe("")
    // Must not invent a [] part key for the user message.
    expect(Object.prototype.hasOwnProperty.call(sessionStore.getState().part, "msg_2")).toBe(false)
  })

  test("restores a visible user snapshot when the child store lacks its message and parts", async () => {
    const sessionStore = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: { "session-a": [] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const snapshot = {
      info: { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message,
      parts: [
        { id: "text_2", messageID: "msg_2", type: "text", text: "edit this" },
        { id: "synthetic_2", messageID: "msg_2", type: "text", text: "hidden", synthetic: true },
        { id: "file_2", messageID: "msg_2", type: "file", url: "file:///attached.txt", mime: "text/plain", filename: "attached.txt" },
      ] as Part[],
    }

    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await stageMessageEdit("session-a", "msg_2", snapshot)

    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.snapshot.text).toBe("edit this")
    expect(draftCommits[0]?.snapshot.attachments.some((attachment) => attachment.locator?.kind === "url" && attachment.locator.url === "file:///attached.txt")).toBe(true)
  })

  test("preserves the composer when a visible snapshot identity does not match", async () => {
    const sessionStore = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const snapshot = {
      info: { id: "wrong-message", sessionID: "session-a", role: "user", time: { created: 2 } } as Message,
      parts: [{ id: "text_2", messageID: "wrong-message", type: "text", text: "wrong" } as Part],
    }

    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await expect(stageMessageEdit("session-a", "msg_2", snapshot)).rejects.toThrow("The selected user message is unavailable")
    expect(draftCommits).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("previous draft")
    expect(inputState.pendingInputMode).toBe("normal")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }])
  })

  test("commits the selected turn and later messages immediately before replacement send", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const assistantMessage = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message
    const laterMessage = { id: "msg_4", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, assistantMessage, laterMessage] },
      part: {
        "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part],
        "msg_3": [{ id: "prt_3", messageID: "msg_3", type: "text", text: "answer" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "later" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [
        { info: targetMessage, parts: [] },
        { info: assistantMessage, parts: [] },
        { info: laterMessage, parts: [] },
      ],
    }

    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await commitMessageEdit("session-a", "msg_2")

    const deletedIDs = replyCalls
      .filter((call) => call.method === "session.deleteMessage")
      .map((call) => call.params.messageID)
    expect(deletedIDs).toEqual(["msg_4", "msg_3", "msg_2"])
    expect(replyCalls.filter((call) => call.method === "session.deleteMessage").every((call) => call.params.directory === "/test/project")).toBe(true)
    expect(sessionStore.getState().message["session-a"]).toEqual([])
  })

  test("leaves rows whose delete never landed in the transcript", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const laterMessage = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message
    const latestMessage = { id: "msg_4", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, laterMessage, latestMessage] },
      part: {
        "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part],
        "msg_3": [{ id: "prt_3", messageID: "msg_3", type: "text", text: "answer" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "later" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionDeleteMessageFailureID = "msg_3"
    mocks.sessionMessagesResult = {
      data: [
        { info: targetMessage, parts: [] },
        { info: laterMessage, parts: [] },
        { info: latestMessage, parts: [] },
      ],
    }

    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await expect(commitMessageEdit("session-a", "msg_2")).rejects.toThrow("session.deleteMessage failed (500)")

    // No pre-hide: a row leaves the transcript only once its own delete lands.
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_2", "msg_3"])
    expect(inputState.pendingInputText).toBe("previous draft")
    expect(inputState.pendingInputMode).toBe("normal")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }])
  })

  test("stages into an explicit surfaceDraftKey without touching the primary session draft key", async () => {
    const sessionStore = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: { "session-a": [{ id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message] },
      part: { "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "surface edit" } as Part] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
    const { getRuntimeTransportIdentity } = await import("../lib/runtime-switch")
    const surfaceKey = { transportIdentity: getRuntimeTransportIdentity(), owner: { kind: "surface" as const, ownerID: "assistant:a" } }
    const primaryKey = { transportIdentity: getRuntimeTransportIdentity(), owner: { kind: "session" as const, ownerID: "session-a" } }

    await stageMessageEdit("session-a", "msg_2", undefined, { directory: "/test/project", draftKey: surfaceKey })

    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.key.owner).toEqual({ kind: "surface", ownerID: "assistant:a" })
    expect(draftCommits[0]?.snapshot.text).toBe("surface edit")
    expect(mocks.draftRevisionByKey.has(JSON.stringify([primaryKey.transportIdentity, "session", "session-a"]))).toBe(false)
  })

  test("returns an opaque rollback handle that restores prior absence via CAS", async () => {
    const sessionStore = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: { "session-a": [{ id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message] },
      part: { "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "edit body" } as Part] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
    const { getRuntimeTransportIdentity } = await import("../lib/runtime-switch")
    const key = { transportIdentity: getRuntimeTransportIdentity(), owner: { kind: "session" as const, ownerID: "session-a" } }
    const id = JSON.stringify([key.transportIdentity, "session", "session-a"])

    const handle = await stageMessageEdit("session-a", "msg_2")
    expect(mocks.draftRevisionByKey.get(id)).toBe(1)
    expect(typeof handle.rollback).toBe("function")
    // Handle must not expose DraftRecord / attachment internals.
    expect(Object.keys(handle).sort()).toEqual(["rollback"])

    const rolled = await handle.rollback()
    expect(rolled.status).toBe("rolled-back")
    expect(mocks.draftRevisionByKey.has(id)).toBe(false)

    // Conflict: user continued editing after stage — keep newer revision.
    const handle2 = await stageMessageEdit("session-a", "msg_2")
    const revision = mocks.draftRevisionByKey.get(id)!
    mocks.draftRevisionByKey.set(id, revision + 1)
    inputState.drafts[id] = { revision: revision + 1, text: "user continued" }
    const conflict = await handle2.rollback()
    expect(conflict.status).toBe("conflict")
    expect(mocks.draftRevisionByKey.get(id)).toBe(revision + 1)
    expect(inputState.drafts[id]?.text).toBe("user continued")
  })

  test("commitMessageEdit accepts an explicit directory override for the child store", async () => {
    const sessionStore = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: {
        "session-a": [
          { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message,
          { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message,
        ],
      },
      part: {
        "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "edit" } as Part],
        "msg_3": [{ id: "prt_3", messageID: "msg_3", type: "text", text: "answer" } as Part],
      },
    })
    const wrongStore = createStore({})
    const childStores = createChildStores([
      ["/assistant/workspace", sessionStore],
      ["/current/project", wrongStore],
    ])
    mocks.sessionMessagesResult = {
      data: [
        { info: { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message, parts: [] },
        { info: { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message, parts: [] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await commitMessageEdit("session-a", "msg_2", { directory: "/assistant/workspace" })

    expect(replyCalls.filter((call) => call.method === "session.deleteMessage").every((call) => call.params.directory === "/assistant/workspace")).toBe(true)
    expect(sessionStore.getState().message["session-a"]).toEqual([])
    expect(wrongStore.getState().message["session-a"]).toBe(undefined)
  })

  test("commitMessageEdit deletes forward only — earlier history is never a candidate", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const olderUser = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const olderReply = { id: "msg_2", sessionID: "session-a", role: "assistant", time: { created: 2 } } as Message
    const targetMessage = { id: "msg_3", sessionID: "session-a", role: "user", time: { created: 3 } } as Message
    const targetReply = { id: "msg_4", sessionID: "session-a", role: "assistant", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [olderUser, olderReply, targetMessage, targetReply] },
      part: {
        "msg_3": [{ id: "prt_3", messageID: "msg_3", type: "text", text: "edit this" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "answer" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [
        { info: olderUser, parts: [] },
        { info: olderReply, parts: [] },
        { info: targetMessage, parts: [{ id: "prt_3", messageID: "msg_3", type: "text", text: "edit this" } as Part] },
        { info: targetReply, parts: [{ id: "prt_4", messageID: "msg_4", type: "text", text: "answer" } as Part] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_3")

    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_4", "msg_3"])
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  })

  test("commitMessageEdit never deletes the in-flight replacement the server already echoed", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_3", sessionID: "session-a", role: "user", time: { created: 3 } } as Message
    const targetReply = { id: "msg_4", sessionID: "session-a", role: "assistant", time: { created: 4 } } as Message
    const inFlightMessage = { id: "msg_9", sessionID: "session-a", role: "user", time: { created: 9 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, targetReply, inFlightMessage] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.uiPendingSendMessageIDs = new Map([["session-a", "msg_9"]])
    mocks.sessionMessagesResult = {
      data: [
        { info: targetMessage, parts: [] },
        { info: targetReply, parts: [] },
        { info: inFlightMessage, parts: [] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_3")

    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_4", "msg_3"])
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_9"])
  })

  test("commitMessageEdit waits for idle after abort before deleting", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_3", sessionID: "session-a", role: "user", time: { created: 3 } } as Message
    const targetReply = { id: "msg_4", sessionID: "session-a", role: "assistant", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, targetReply] },
      session_status: { "session-a": { type: "busy" as const } },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [
        { info: targetMessage, parts: [] },
        { info: targetReply, parts: [] },
      ],
    }
    mockSdk.session.abort = vi.fn(async (params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      setTimeout(() => {
        sessionStore.setState({
          session_status: { "session-a": { type: "idle" as const } },
        })
      }, 20)
      return { data: true }
    })
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_3")

    expect(replyCalls.some((call) => call.method === "session.abort")).toBe(true)
    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_4", "msg_3"])
    expect(sessionStore.getState().message["session-a"]).toEqual([])
  })

  test("commitMessageEdit follows conversation order when ids are not monotonic", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    // Conversation: older high-id row, then a later low-id user turn.
    // Id-sort would treat msg_9 as "after" msg_2 and delete / move it.
    const olderHighId = { id: "msg_9", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const olderLowId = { id: "msg_1", sessionID: "session-a", role: "assistant", time: { created: 2 } } as Message
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 3 } } as Message
    const targetReply = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [olderHighId, olderLowId, targetMessage, targetReply] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [
        { info: targetReply, parts: [] },
        { info: targetMessage, parts: [] },
        { info: olderLowId, parts: [] },
        { info: olderHighId, parts: [] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_2")

    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_3", "msg_2"])
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_9", "msg_1"])
  })

  test("commitMessageEdit fails closed when the server snapshot omits the target", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetReply = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, targetReply] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [{ info: targetReply, parts: [] }],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await expect(commitMessageEdit("session-a", "msg_2")).rejects.toThrow("The selected user message is unavailable")
    expect(replyCalls.filter((call) => call.method === "session.deleteMessage")).toEqual([])
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_2", "msg_3"])
  })

  test("commitMessageEdit does not delete unloaded server history outside the local tail", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetReply = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as Message
    const unloadedOlder = { id: "msg_0", sessionID: "session-a", role: "user", time: { created: 0 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, targetReply] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.sessionMessagesResult = {
      data: [
        { info: unloadedOlder, parts: [] },
        { info: targetMessage, parts: [] },
        { info: targetReply, parts: [] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_2")

    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_3", "msg_2"])
  })

  test("commitMessageEdit cuts a preserved replacement by conversation position, not id order", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_3", sessionID: "session-a", role: "user", time: { created: 3 } } as Message
    const targetReply = { id: "msg_4", sessionID: "session-a", role: "assistant", time: { created: 4 } } as Message
    const replacement = { id: "msg_0", sessionID: "session-a", role: "user", time: { created: 5 } } as Message
    const replacementReply = { id: "msg_5", sessionID: "session-a", role: "assistant", time: { created: 6 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage, targetReply, replacement, replacementReply] },
      part: {},
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    mocks.uiPendingSendMessageIDs = new Map([["session-a", "msg_0"]])
    mocks.sessionMessagesResult = {
      data: [
        { info: targetMessage, parts: [] },
        { info: targetReply, parts: [] },
        { info: replacement, parts: [] },
        { info: replacementReply, parts: [] },
      ],
    }
    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await commitMessageEdit("session-a", "msg_3")

    expect(
      replyCalls
        .filter((call) => call.method === "session.deleteMessage")
        .map((call) => call.params.messageID),
    ).toEqual(["msg_4", "msg_3"])
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_0", "msg_5"])
  })

  test("commitMessageEdit removes the deleted tail from every canonical scope of the session", async () => {
    const { QueryClient } = await import("@tanstack/react-query")
    const { createQueryTranscriptRepository } = await import("./transcript-repository-query-adapter")
    const { createMemoryTranscriptDurableStore } = await import("./transcript-durable-store")
    const {
      bindTranscriptRepositoryInstance,
      unbindTranscriptRepository,
      transcriptScope,
    } = await import("./transcript-repository-runtime")
    const { getRuntimeGeneration, getRuntimeTransportIdentity } = await import("../lib/runtime-switch")

    const session = { id: "session-a", time: { created: 1 } } as Session
    const older = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const tail = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 }, finish: "stop" } as Message
    const page = {
      records: [
        { info: older, parts: [] },
        { info: target, parts: [] },
        { info: tail, parts: [] },
      ],
      complete: true,
      turnCount: 2,
    }
    const dirA = "/test/project"
    const dirB = "/other/project"
    const sessionStore = createStore({}, { session: [session] })
    const childStores = createChildStores([[dirA, sessionStore]])
    mocks.sessionMessagesResult = { data: page.records }

    const transport = getRuntimeTransportIdentity()
    const generation = getRuntimeGeneration()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const durable = createMemoryTranscriptDurableStore()
    const repo = createQueryTranscriptRepository({
      client,
      durableStore: durable,
      transport,
      generation,
      probe: {
        getTransport: () => transport,
        getGeneration: () => generation,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    const scopeA = transcriptScope(dirA, "session-a", { transport, generation })
    const scopeB = transcriptScope(dirB, "session-a", { transport, generation })
    repo.apply(scopeA, { type: "http-page", purpose: "initial", page })
    repo.apply(scopeB, { type: "http-page", purpose: "initial", page })

    const durableA = { transport, generation, directory: dirA, sessionID: "session-a" }
    const durableB = { transport, generation, directory: dirB, sessionID: "session-a" }
    const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeout = 800) => {
      const started = Date.now()
      while (!(await predicate())) {
        if (Date.now() - started > timeout) throw new Error("timed out waiting for durable side effect")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    await waitUntil(async () => {
      const a = await durable.readSession(durableA)
      const b = await durable.readSession(durableB)
      return a.records.some((record) => record.messageID === "msg_2")
        && b.records.some((record) => record.messageID === "msg_2")
    })

    try {
      const { commitMessageEdit, setActionRefs } = await import("./session-actions")
      setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
      await commitMessageEdit("session-a", "msg_2")

      expect(repo.getTranscript(scopeA).messageOrder).not.toContain("msg_2")
      expect(repo.getTranscript(scopeA).messageOrder).not.toContain("msg_3")
      expect(repo.getTranscript(scopeB).messageOrder).not.toContain("msg_2")
      expect(repo.getTranscript(scopeB).messageOrder).not.toContain("msg_3")

      await waitUntil(async () => {
        const a = await durable.readSession(durableA)
        const b = await durable.readSession(durableB)
        const leftover = (session: typeof a) => session.records.filter((record) => (
          record.messageID === "msg_2" || record.messageID === "msg_3"
        ))
        return leftover(a).length === 0 && leftover(b).length === 0
      })
      expect((await durable.readSession(durableA)).records.map((record) => record.messageID)).toEqual(["msg_1"])
      expect((await durable.readSession(durableB)).records.map((record) => record.messageID)).toEqual(["msg_1"])
    } finally {
      unbindTranscriptRepository()
      repo.destroy()
    }
  })

})

describe("session history mutation serial coordinator", () => {
  const flushAsync = async (ticks = 20) => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve()
  }
  const waitUntil = async (predicate: () => boolean, ticks = 100) => {
    for (let i = 0; i < ticks; i += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
  }

  beforeEach(() => {
    replyCalls.length = 0
    mocks.sessionRevertResult = {}
    mocks.sessionUnrevertResult = {}
    mocks.sessionMessagesResult = { data: [] }
    draftCommits.length = 0
    mocks.draftRevisionByKey = new Map()
    mocks.draftCommitShouldFail = false
    mocks.draftCommitFailAfter = 0
    mocks.draftCommitCount = 0
    Object.assign(inputState, {
      pendingInputText: "",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
      drafts: {},
    })
  })

  test("same-session second revert waits for the first and the later marker wins", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const msg2 = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const msg4 = { id: "msg_4", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [msg2, msg4] },
      part: {
        "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "first" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "second" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted = false
    let secondStarted = false
    const order: string[] = []
    let callCount = 0

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const client = (await import("@/lib/opencode/client")).opencodeClient as {
      revertSession: (sessionId: string, messageId: string, partId?: string, directory?: string | null) => Promise<unknown>
    }
    const realRevert = client.revertSession
    client.revertSession = (async (sessionId: string, messageId: string) => {
      callCount += 1
      if (callCount === 1) {
        firstStarted = true
        order.push(`start:${messageId}`)
        await firstGate
        order.push(`end:${messageId}`)
      } else {
        secondStarted = true
        order.push(`start:${messageId}`)
        order.push(`end:${messageId}`)
      }
      return { id: sessionId, time: { created: 1, updated: 2 }, revert: { messageID: messageId } }
    }) as typeof client.revertSession

    try {
      const first = revertToMessage("session-a", "msg_2")
      await waitUntil(() => firstStarted)
      expect(firstStarted).toBe(true)
      const second = revertToMessage("session-a", "msg_4")
      await flushAsync()
      // Second must not start remote until first completes.
      expect(secondStarted).toBe(false)
      releaseFirst()
      await Promise.all([first, second])
      expect(order).toEqual(["start:msg_2", "end:msg_2", "start:msg_4", "end:msg_4"])
      expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_4")
    } finally {
      client.revertSession = realRevert
    }
  })

  test("first revert failure does not block the second same-session revert", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const msg2 = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const msg4 = { id: "msg_4", sessionID: "session-a", role: "user", time: { created: 4 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [msg2, msg4] },
      part: {
        "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "first" } as Part],
        "msg_4": [{ id: "prt_4", messageID: "msg_4", type: "text", text: "second" } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const client = (await import("@/lib/opencode/client")).opencodeClient as {
      revertSession: (sessionId: string, messageId: string, partId?: string, directory?: string | null) => Promise<unknown>
    }
    const realRevert = client.revertSession
    let callCount = 0
    client.revertSession = (async (sessionId: string, messageId: string) => {
      callCount += 1
      if (callCount === 1) {
        throw new Error("session.revert failed (500): rejected")
      }
      return { id: sessionId, time: { created: 1, updated: 2 }, revert: { messageID: messageId } }
    }) as typeof client.revertSession

    try {
      await expect(revertToMessage("session-a", "msg_2")).rejects.toThrow("session.revert failed")
      await revertToMessage("session-a", "msg_4")
      expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_4")
      expect(callCount).toBe(2)
    } finally {
      client.revertSession = realRevert
    }
  })

  test("different sessions run revert in parallel", async () => {
    const storeA = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      message: { "session-a": [{ id: "msg_a", sessionID: "session-a", role: "user", time: { created: 2 } } as Message] },
      part: { "msg_a": [{ id: "prt_a", messageID: "msg_a", type: "text", text: "a" } as Part] },
    })
    const storeB = createStore({}, {
      session: [{ id: "session-b", time: { created: 1 } } as Session],
      message: { "session-b": [{ id: "msg_b", sessionID: "session-b", role: "user", time: { created: 2 } } as Message] },
      part: { "msg_b": [{ id: "prt_b", messageID: "msg_b", type: "text", text: "b" } as Part] },
    })
    const childStores = createChildStores([
      ["/test/project", storeA],
      ["/other/project", storeB],
    ])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const client = (await import("@/lib/opencode/client")).opencodeClient as {
      revertSession: (sessionId: string, messageId: string, partId?: string, directory?: string | null) => Promise<unknown>
    }
    const realRevert = client.revertSession
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []
    client.revertSession = (async (sessionId: string, messageId: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => { gates.push(resolve) })
      active -= 1
      return { id: sessionId, time: { created: 1, updated: 2 }, revert: { messageID: messageId } }
    }) as typeof client.revertSession

    try {
      const first = revertToMessage("session-a", "msg_a")
      const second = revertToMessage("session-b", "msg_b")
      await waitUntil(() => maxActive === 2)
      expect(maxActive).toBe(2)
      for (const release of gates) release()
      await Promise.all([first, second])
      expect((storeA.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_a")
      expect((storeB.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_b")
    } finally {
      client.revertSession = realRevert
    }
  })

  test("runtime switch prevents a stale revert from publishing its marker", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const msg2 = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [msg2] },
      part: { "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "stale" } as Part] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const client = (await import("@/lib/opencode/client")).opencodeClient as {
      revertSession: (sessionId: string, messageId: string, partId?: string, directory?: string | null) => Promise<unknown>
    }
    const realRevert = client.revertSession
    let releaseRemote!: () => void
    const remoteGate = new Promise<void>((resolve) => { releaseRemote = resolve })
    client.revertSession = (async (sessionId: string, messageId: string) => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
      await remoteGate
      return { id: sessionId, time: { created: 1, updated: 2 }, revert: { messageID: messageId } }
    }) as typeof client.revertSession

    try {
      const pending = revertToMessage("session-a", "msg_2")
      await waitUntil(() => true)
      // Wait until remote is entered (runtime already switched inside the mock).
      await flushAsync(30)
      releaseRemote()
      await expect(pending).rejects.toThrow("runtime changed")
      expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert).toBe(undefined)
    } finally {
      client.revertSession = realRevert
      switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })
    }
  })

  test("unrevert and revert on the same session serialize", async () => {
    const session = { id: "session-a", time: { created: 1 }, revert: { messageID: "msg_2" } } as Session
    const msg2 = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [msg2] },
      part: { "msg_2": [{ id: "prt_2", messageID: "msg_2", type: "text", text: "body" } as Part] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    const { setActionRefs, revertToMessage, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const order: string[] = []
    let releaseUnrevert!: () => void
    const unrevertGate = new Promise<void>((resolve) => { releaseUnrevert = resolve })

    // Patch SDK unrevert path used by unrevertSession.
    const originalUnrevert = mockSdk.session.unrevert
    mockSdk.session.unrevert = vi.fn(async (params: Record<string, unknown>) => {
      order.push("unrevert-start")
      replyCalls.push({ method: "session.unrevert", params })
      await unrevertGate
      order.push("unrevert-end")
      return { data: { id: "session-a", time: { created: 1, updated: 3 } } }
    })

    const client = (await import("@/lib/opencode/client")).opencodeClient as {
      revertSession: (sessionId: string, messageId: string, partId?: string, directory?: string | null) => Promise<unknown>
    }
    const realRevert = client.revertSession
    client.revertSession = (async (sessionId: string, messageId: string) => {
      order.push("revert-start")
      order.push("revert-end")
      return { id: sessionId, time: { created: 1, updated: 4 }, revert: { messageID: messageId } }
    }) as typeof client.revertSession

    try {
      const first = unrevertSession("session-a")
      await waitUntil(() => order.includes("unrevert-start"))
      const second = revertToMessage("session-a", "msg_2")
      await flushAsync()
      expect(order).toEqual(["unrevert-start"])
      releaseUnrevert()
      await Promise.all([first, second])
      expect(order).toEqual(["unrevert-start", "unrevert-end", "revert-start", "revert-end"])
      expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    } finally {
      mockSdk.session.unrevert = originalUnrevert
      client.revertSession = realRevert
    }
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.questionReplyError = null
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("respondToQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.questionReplyError = null
  })

  test("passes directory to question.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-1", [["answer1"]])

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
    expect(scopedClientDirectories).toEqual(["/test/project"])
  })

  test("removes stale question from child store when reply returns not found", async () => {
    const question: QuestionRequest = {
      id: "q-stale",
      sessionID: "session-a",
      questions: [
        {
          question: "Choose an option",
          header: "Choice",
          options: [{ label: "Yes", description: "Proceed" }],
        },
      ],
    }
    const store = createStore({}, { question: { "session-a": [question] } })
    const childStores = createChildStores([["/test/project", store]])
    mocks.questionReplyError = Object.assign(new Error("question.reply failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await respondToQuestion("session-a", "q-stale", [["Yes"]])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.questionReplyError = null
  })

  test("passes directory to question.reject", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

function buildQuestion(id: string, sessionId: string): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [
      {
        question: "Choose an option",
        header: "Choice",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  }
}

describe("dirStoreForDirectory bootstrap option", () => {
  test("forwards optional bootstrap flag to ensureChild and defaults when omitted", async () => {
    const store = createStore({})
    const trackEnsure: Array<{ directory: string; options?: { bootstrap?: boolean } }> = []
    const childStores = createChildStores([["/test/project", store]], { trackEnsure })
    const { setActionRefs, dirStoreForDirectory } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    dirStoreForDirectory("/test/project")
    dirStoreForDirectory("/test/project", { bootstrap: false })
    dirStoreForDirectory("/test/project", { bootstrap: true })

    expect(trackEnsure).toEqual([
      { directory: "/test/project", options: undefined },
      { directory: "/test/project", options: { bootstrap: false } },
      { directory: "/test/project", options: { bootstrap: true } },
    ])
  })
})

describe("ensureSentUserMessagePresence", () => {
  const userRecord = (messageID: string) => ({
    info: { id: messageID, role: "user", sessionID: "session-a", time: { created: 1 } },
    parts: [{ id: "prt", type: "text", text: "hi", messageID, sessionID: "session-a" }],
  })

  test("issues no request when the store already holds the row with parts", async () => {
    const messageID = "msg_present"
    const store = createStore({}, {
      message: { "session-a": [{ id: messageID, role: "user", sessionID: "session-a" } as unknown as Message] },
      part: { [messageID]: [{ id: "prt_live", type: "text", text: "hi" } as unknown as Part] },
    })
    const childStores = createChildStores([["/test/project", store]])
    let calls = 0
    const messagesMock = vi.fn(() => {
      calls += 1
      return Promise.resolve({ data: [userRecord(messageID)] })
    })
    const sdk = { ...mockSdk, session: { ...mockSdk.session, messages: messagesMock } }
    const { setActionRefs, ensureSentUserMessagePresence } = await import("./session-actions")
    setActionRefs(sdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const outcome = await ensureSentUserMessagePresence({
      store,
      sessionId: "session-a",
      messageID,
      directory: "/test/project",
      graceMs: 50,
    })

    expect(outcome).toBe("present")
    expect(calls).toBe(0)
  })

  test("resolves without a request when the row lands during the grace window", async () => {
    const messageID = "msg_late_sse"
    const store = createStore({})
    const childStores = createChildStores([["/test/project", store]])
    let calls = 0
    const messagesMock = vi.fn(() => {
      calls += 1
      return Promise.resolve({ data: [userRecord(messageID)] })
    })
    const sdk = { ...mockSdk, session: { ...mockSdk.session, messages: messagesMock } }
    const { setActionRefs, ensureSentUserMessagePresence } = await import("./session-actions")
    setActionRefs(sdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const work = ensureSentUserMessagePresence({
      store,
      sessionId: "session-a",
      messageID,
      directory: "/test/project",
      graceMs: 200,
    })
    // Stand in for SSE delivering the row while the local wait is still open.
    setTimeout(() => {
      store.setState({
        message: { "session-a": [{ id: messageID, role: "user", sessionID: "session-a" } as unknown as Message] },
        part: { [messageID]: [{ id: "prt_sse", type: "text", text: "hi" } as unknown as Part] },
      })
    }, 10)

    expect(await work).toBe("present")
    expect(calls).toBe(0)
  })

  test("treats a part-less row as absent and recovers it", async () => {
    const messageID = "msg_partless"
    const store = createStore({}, {
      message: { "session-a": [{ id: messageID, role: "user", sessionID: "session-a" } as unknown as Message] },
    })
    const childStores = createChildStores([["/test/project", store]])
    mocks.sessionMessagesResult = { data: [userRecord(messageID)] }
    const { setActionRefs, ensureSentUserMessagePresence, combinedSendConfirmationOptions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    combinedSendConfirmationOptions.recovery = { attempts: 1, retryDelayMs: 0 }

    const outcome = await ensureSentUserMessagePresence({
      store,
      sessionId: "session-a",
      messageID,
      directory: "/test/project",
      graceMs: 5,
    })

    expect(outcome).toBe("recovered")
    expect(store.getState().part[messageID]?.some((part) => part.id === "prt")).toBe(true)
  })

  test("reports a bounded miss without clearing existing messages", async () => {
    const messageID = "msg_never"
    const prior = { id: "msg_prior", role: "user", sessionID: "session-a" } as unknown as Message
    const store = createStore({}, {
      message: { "session-a": [prior] },
      part: { msg_prior: [{ id: "prt_prior", type: "text", text: "keep me" } as unknown as Part] },
    })
    const childStores = createChildStores([["/test/project", store]])
    mocks.sessionMessagesResult = { data: [] }
    const { setActionRefs, ensureSentUserMessagePresence, combinedSendConfirmationOptions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    combinedSendConfirmationOptions.recovery = { attempts: 1, retryDelayMs: 0 }

    const outcome = await ensureSentUserMessagePresence({
      store,
      sessionId: "session-a",
      messageID,
      directory: "/test/project",
      graceMs: 5,
    })

    expect(outcome).toBe("missing")
    expect(store.getState().message["session-a"]?.map((m) => m.id)).toEqual(["msg_prior"])
    expect(store.getState().part.msg_prior?.[0]?.id).toBe("prt_prior")
  })

  test("stops at the grace window when the runtime is no longer current", async () => {
    const messageID = "msg_switched"
    const store = createStore({})
    const childStores = createChildStores([["/test/project", store]])
    let calls = 0
    const messagesMock = vi.fn(() => {
      calls += 1
      return Promise.resolve({ data: [userRecord(messageID)] })
    })
    const sdk = { ...mockSdk, session: { ...mockSdk.session, messages: messagesMock } }
    const { setActionRefs, ensureSentUserMessagePresence } = await import("./session-actions")
    setActionRefs(sdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const outcome = await ensureSentUserMessagePresence({
      store,
      sessionId: "session-a",
      messageID,
      directory: "/test/project",
      graceMs: 5,
      isCurrent: () => false,
    })

    expect(outcome).toBe("cancelled")
    expect(calls).toBe(0)
    expect(store.getState().message["session-a"] ?? []).toEqual([])
  })
})

describe("dismissOpenQuestionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    mocks.questionReplyError = null
  })

  test("returns false and rejects nothing when no questions are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(false)
    expect(replyCalls.filter((call) => call.method === "question.reject")).toHaveLength(0)
  })

  test("rejects every pending question in the session subtree (root + subagent child)", async () => {
    const rootQuestion = buildQuestion("q-root", "session-a")
    const childQuestion = buildQuestion("q-child", "session-child")
    const store = createStore({}, {
      session: [
        { id: "session-a", time: { created: 1 } } as Session,
        { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
      ],
      question: {
        "session-a": [rootQuestion],
        "session-child": [childQuestion],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(2)
    const rejectedIds = rejectCalls.map((call) => call.params.requestID).sort()
    expect(rejectedIds).toEqual(["q-child", "q-root"])
    // Optimistic clear: the questions are removed from the local store so the
    // prompt disappears instantly, without waiting for the reject round-trip.
    expect(store.getState().question["session-a"]).toBe(undefined)
    expect(store.getState().question["session-child"]).toBe(undefined)
  })

  test("swallows QuestionNotFoundError so a stranded question never blocks the send", async () => {
    const staleQuestion = buildQuestion("q-stale", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [staleQuestion] },
    })
    const childStores = createChildStores([["/test/project", store]])
    mocks.questionRejectError = Object.assign(new Error("question.reject failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(1)
    expect(rejectCalls[0].params.requestID).toBe("q-stale")
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})


describe("composer restoration file-part materialize", () => {
  const IMAGE_DATA_URL = "data:image/png;base64,eA=="

  const previousDraft = {
    pendingInputText: "previous draft",
    pendingInputMode: "normal" as const,
    attachedFiles: [{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }],
  }

  beforeEach(() => {
    replyCalls.length = 0
    draftCommits.length = 0
    mocks.draftRevisionByKey = new Map()
    mocks.draftCommitShouldFail = false
    mocks.draftCommitFailAfter = 0
    mocks.draftCommitCount = 0
    mocks.sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }
    Object.assign(inputState, {
      ...previousDraft,
      drafts: {},
    })
  })

  afterEach(async () => {
    const { unbindTranscriptRepository } = await import("./transcript-repository-runtime")
    unbindTranscriptRepository()
  })

  async function bindMaterializingStoreRepo(
    store: StoreApi<TestDirectoryStore>,
    materialize: (messageID: string) => Promise<void> | void,
  ) {
    const { createStoreTranscriptRepository } = await import("./transcript-repository-store-adapter")
    const { bindTranscriptRepositoryInstance } = await import("./transcript-repository-runtime")
    const inner = createStoreTranscriptRepository({ getStore: () => store as never })
    const calls: Array<{ directory: string; sessionID: string; messageID: string }> = []
    bindTranscriptRepositoryInstance({
      ...inner,
      async materializeMessage(scope, messageID) {
        calls.push({ directory: scope.directory, sessionID: scope.sessionID, messageID })
        await materialize(messageID)
        return inner.getTranscript(scope)
      },
    })
    return calls
  }

  function imageSession(parts: Part[]) {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const store = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { msg_2: parts },
    })
    return { store, childStores: createChildStores([["/test/project", store]]) }
  }

  test("materializes a slim data-url image then restores a Blob", async () => {
    const slim = {
      id: "file_2",
      messageID: "msg_2",
      sessionID: "session-a",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "",
      slim: true,
    } as unknown as Part
    const full = {
      id: "file_2",
      messageID: "msg_2",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: IMAGE_DATA_URL,
    } as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      slim,
    ])
    const calls = await bindMaterializingStoreRepo(store, (messageID) => {
      store.setState((state) => ({
        part: { ...state.part, [messageID]: [state.part[messageID]![0]!, full] },
      }))
    })
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await stageMessageEdit("session-a", "msg_2")

    expect(calls).toEqual([{ directory: "/test/project", sessionID: "session-a", messageID: "msg_2" }])
    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.snapshot.text).toBe("see shot")
    expect(draftCommits[0]?.snapshot.attachments[0]?.locator?.kind).toBe("blob")
    expect(draftCommits[0]?.snapshot.attachments[0]?.filename).toBe("shot.png")
    const value = [...(draftCommits[0]?.values ?? new Map()).values()][0]
    expect(value).toBeInstanceOf(Blob)
  })

  test("does not fetch when the image file part is already full", async () => {
    const full = {
      id: "file_2",
      messageID: "msg_2",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: IMAGE_DATA_URL,
    } as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      full,
    ])
    const calls = await bindMaterializingStoreRepo(store, () => {
      throw new Error("unexpected materialize")
    })
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await stageMessageEdit("session-a", "msg_2")

    expect(calls).toEqual([])
    expect(draftCommits).toHaveLength(1)
    expect(draftCommits[0]?.snapshot.attachments[0]?.locator?.kind).toBe("blob")
    expect([...(draftCommits[0]?.values ?? new Map()).values()][0]).toBeInstanceOf(Blob)
  })

  test("fails the edit and keeps composer when materialize throws", async () => {
    const slim = {
      id: "file_2",
      messageID: "msg_2",
      sessionID: "session-a",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "",
      slim: true,
    } as unknown as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      slim,
    ])
    await bindMaterializingStoreRepo(store, () => {
      throw new Error("host unavailable")
    })
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await expect(stageMessageEdit("session-a", "msg_2")).rejects.toThrow("composer-restoration-materialize-failed")
    expect(draftCommits).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("previous draft")
    expect(inputState.attachedFiles).toEqual(previousDraft.attachedFiles)
  })

  test("fails the edit when materialize still leaves a body-less file part", async () => {
    const slim = {
      id: "file_2",
      messageID: "msg_2",
      sessionID: "session-a",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "",
    } as unknown as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      slim,
    ])
    const calls = await bindMaterializingStoreRepo(store, () => undefined)
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await expect(stageMessageEdit("session-a", "msg_2")).rejects.toThrow("composer-restoration-incomplete-attachment")
    expect(calls).toHaveLength(1)
    expect(draftCommits).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("previous draft")
    expect(inputState.attachedFiles).toEqual(previousDraft.attachedFiles)
  })

  test("does not restore after a runtime switch during materialize", async () => {
    const slim = {
      id: "file_2",
      messageID: "msg_2",
      sessionID: "session-a",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "",
      slim: true,
    } as unknown as Part
    const full = {
      id: "file_2",
      messageID: "msg_2",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: IMAGE_DATA_URL,
    } as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      slim,
    ])
    const {
      getRuntimeApiBaseUrl,
      getRuntimeKey,
      switchRuntimeEndpoint,
    } = await import("../lib/runtime-switch")
    const previousUrl = getRuntimeApiBaseUrl()
    const previousKey = getRuntimeKey()
    await bindMaterializingStoreRepo(store, (messageID) => {
      store.setState((state) => ({
        part: { ...state.part, [messageID]: [state.part[messageID]![0]!, full] },
      }))
      switchRuntimeEndpoint({
        apiBaseUrl: "http://stale-runtime.test",
        runtimeKey: "stale-runtime",
      })
    })
    const { stageMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    try {
      await expect(stageMessageEdit("session-a", "msg_2")).rejects.toThrow("runtime changed")
      expect(draftCommits).toHaveLength(0)
      expect(inputState.pendingInputText).toBe("previous draft")
      expect(inputState.attachedFiles).toEqual(previousDraft.attachedFiles)
    } finally {
      switchRuntimeEndpoint({
        apiBaseUrl: previousUrl || "http://127.0.0.1",
        runtimeKey: previousKey || "local",
      })
    }
  })

  test("revertToMessage materializes slim file parts before restoration", async () => {
    const slim = {
      id: "file_2",
      messageID: "msg_2",
      sessionID: "session-a",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "",
      slim: true,
    } as unknown as Part
    const full = {
      id: "file_2",
      messageID: "msg_2",
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: IMAGE_DATA_URL,
    } as Part
    const { store, childStores } = imageSession([
      { id: "prt_2", messageID: "msg_2", type: "text", text: "see shot" } as Part,
      slim,
    ])
    const calls = await bindMaterializingStoreRepo(store, (messageID) => {
      store.setState((state) => ({
        part: { ...state.part, [messageID]: [state.part[messageID]![0]!, full] },
      }))
    })
    const { revertToMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const snapshot = await revertToMessage("session-a", "msg_2")
    expect(calls).toEqual([{ directory: "/test/project", sessionID: "session-a", messageID: "msg_2" }])
    expect(snapshot.snapshot.attachments[0]?.locator.kind).toBe("blob")
    expect([...snapshot.values.values()][0]).toBeInstanceOf(Blob)
    expect(draftCommits).toHaveLength(1)
  })
})
