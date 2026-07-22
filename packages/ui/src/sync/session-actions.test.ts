import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []
const registeredSessionDirectories: Array<{ sessionID: string; directory: string }> = []
let sessionRevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let questionReplyError: unknown | null = null
let questionRejectError: unknown | null = null
let sessionShareResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionUpdateResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionMessagesResult: { data?: unknown; error?: unknown; response?: { status?: number } } = { data: [] }
let sessionDeleteMessageFailureID: string | null = null
let sessionForkResult: import("@opencode-ai/sdk/v2/client").Session | null = null
let clearAttachedFilesCalls = 0
const globalUpsertedSessions: unknown[] = []
let abortReject = false
let abortResult: { data?: boolean; error?: unknown; response?: { status?: number } } = { data: true }
const abortBlockEvents: Array<{ event: "begin" | "clear"; scope: Record<string, unknown>; token: string }> = []
let abortBlockToken = 0
let mobileSurfaceRuntime = false
let vscodeRuntime = false

mock.module("@/lib/runtimeSurface", () => ({
  isMobileSurfaceRuntime: () => mobileSurfaceRuntime,
}))

mock.module("@/lib/desktop", () => ({
  isVSCodeRuntime: () => vscodeRuntime,
}))

const mockScopedClient = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

const mockSdk = {
  session: {
    messages: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.messages", params })
      return Promise.resolve(sessionMessagesResult)
    }),
    revert: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.revert", params })
      return Promise.resolve(sessionRevertResult)
    }),
    abort: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      if (abortReject) return Promise.reject(new Error("abort failed"))
      return Promise.resolve(abortResult)
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(sessionUpdateResult.data as Session)
    }),
    update: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.update", params })
      return Promise.resolve(sessionUpdateResult)
    }),
    share: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.share", params })
      return Promise.resolve(sessionShareResult)
    }),
    unshare: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.unshare", params })
      return Promise.resolve(sessionShareResult)
    }),
  },
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

let sessionGetResult: Session | null = null
let globalActiveSessions: Session[] = []
let globalArchivedSessions: Session[] = []

// Mock opencodeClient singleton
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedClientDirectories.push(directory)
      return mockScopedClient
    },
    getDirectory: () => "/test/project",
    getSession: mock((sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.get", params: { sessionID: sessionId, directory } })
      if (!sessionGetResult) throw new Error("session.get result is unavailable")
      return Promise.resolve(sessionGetResult)
    }),
    replyToPermission: mock((requestId: string, reply: string, options?: { directory?: string | null }) => {
      replyCalls.push({ method: "permission.reply", params: { requestID: requestId, reply, directory: options?.directory } })
      return Promise.resolve(true)
    }),
    replyToQuestion: mock((requestId: string, answers: string[] | string[][], directory?: string | null) => {
      replyCalls.push({ method: "question.reply", params: { requestID: requestId, answers, directory } })
      return Promise.resolve(true)
    }),
    revertSession: mock((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      replyCalls.push({
        method: "session.revert",
        params: { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      })
      if (sessionRevertResult.error) {
        const status = sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(sessionRevertResult.data)
    }),
    deleteSessionMessage: mock((sessionId: string, messageId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.deleteMessage", params: { sessionID: sessionId, messageID: messageId, directory } })
      if (sessionDeleteMessageFailureID === messageId) {
        throw new Error("session.deleteMessage failed (500): rejected")
      }
      return Promise.resolve(true)
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(sessionUpdateResult.data)
    }),
    forkSession: mock((sessionId: string, messageId?: string, directory?: string | null) => {
      replyCalls.push({ method: "session.fork", params: { sessionID: sessionId, messageID: messageId, directory } })
      if (!sessionForkResult) throw new Error("session.fork result is unavailable")
      return Promise.resolve(sessionForkResult)
    }),
  },
}))

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

// Mock useSessionUIStore
mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "session-a") return "/test/project"
        if (sessionId === "session-b") return "/other/project"
        return null
      },
      setCurrentSession: () => undefined,
      beginQueueAbortBlock: (scope: Record<string, unknown>) => {
        const token = `abort-${++abortBlockToken}`
        abortBlockEvents.push({ event: "begin", scope, token })
        return token
      },
      clearQueueAbortBlock: (scope: Record<string, unknown>, token: string) => {
        abortBlockEvents.push({ event: "clear", scope, token })
      },
    }),
    setState: () => undefined,
  },
}))

// Mock useInputStore
type RestoredAttachment = { url: string; mimeType: string; filename: string }

const inputState = {
  pendingInputText: "",
  pendingInputMode: "normal" as const,
  attachedFiles: [] as RestoredAttachment[],
  clearAttachedFiles: () => {
    clearAttachedFilesCalls += 1
    inputState.attachedFiles = []
  },
  setAttachedFiles: (attachments: RestoredAttachment[]) => {
    inputState.attachedFiles = attachments
  },
  addRestoredAttachment: (attachment: RestoredAttachment) => {
    inputState.attachedFiles = [...inputState.attachedFiles, attachment]
  },
}

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
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
      activeSessions: globalActiveSessions,
      archivedSessions: globalArchivedSessions,
      upsertSession: (session: unknown) => {
        globalUpsertedSessions.push(session)
      },
    }),
  },
}))

mock.module("./sync-refs", () => ({
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registeredSessionDirectories.push({ sessionID, directory })
  },
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveCall = { sessionID: string; directory?: string | null; messageID: string }
type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: permissions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("./child-store").ChildStoreManager
}

describe("fetchMessagesForSession startup race", () => {
  beforeEach(() => {
    mobileSurfaceRuntime = false
    vscodeRuntime = false
  })

  test("replays a selection fetch queued before sync action refs initialize", async () => {
    replyCalls.length = 0
    sessionMessagesResult = { data: [] }
    const store = createStore({}, { session: [{ id: "startup-session", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")

    await fetchMessagesForSession("startup-session", "/test/project")
    expect(replyCalls.filter((call) => call.method === "session.messages")).toHaveLength(0)

    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(replyCalls.filter((call) => call.method === "session.messages")).toHaveLength(1)
  })

  test("uses one small initial request for concurrent session selection loads", async () => {
    replyCalls.length = 0
    sessionMessagesResult = { data: [] }
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await Promise.all([
      fetchMessagesForSession("session-a", "/test/project"),
      fetchMessagesForSession("session-a", "/test/project"),
    ])

    const messageCalls = replyCalls.filter((call) => call.method === "session.messages")
    expect(messageCalls).toHaveLength(1)
    expect(messageCalls[0]?.params.limit).toBe(30)
  })

  test("uses the runtime-aware initial page size", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { fetchMessagesForSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    for (const runtime of ["mobile", "web", "vscode"] as const) {
      replyCalls.length = 0
      mobileSurfaceRuntime = runtime === "mobile"
      vscodeRuntime = runtime === "vscode"
      await fetchMessagesForSession("session-a", "/test/project")

      expect(replyCalls.filter((call) => call.method === "session.messages")[0]?.params.limit).toBe(runtime === "mobile" ? 16 : 30)
    }
  })
})

describe("abort queue dispatch block", () => {
  beforeEach(() => {
    replyCalls.length = 0
    abortBlockEvents.length = 0
    abortBlockToken = 0
    abortReject = false
    abortResult = { data: true }
  })

  test("creates the exact-scope block before the SDK abort and rolls back its token on failure", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
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

    abortReject = true
    await abortCurrentOperation("session-a")
    abortReject = false
    const [begin, clear] = abortBlockEvents.slice(-2)
    expect(begin?.event).toBe("begin")
    expect(clear?.event).toBe("clear")
    expect(begin?.scope).toEqual(clear?.scope)
    expect(begin?.token).toBe("abort-2")
    expect(clear?.token).toBe("abort-2")
  })

  test("rolls back the matching block for SDK error and false data responses", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    for (const result of [
      { error: { message: "abort rejected" }, response: { status: 500 } },
      { data: false },
    ]) {
      abortResult = result
      await abortCurrentOperation("session-a")
      const [begin, clear] = abortBlockEvents.slice(-2)
      expect(begin?.event).toBe("begin")
      expect(clear?.event).toBe("clear")
      expect(clear?.token).toBe(begin?.token)
    }
  })
})

describe("resolveForkMessageId", () => {
  const userMessage = { id: "user-message", role: "user", sessionID: "session-a", time: { created: 2 } } as Message
  const assistantMessage = { id: "assistant-message", role: "assistant", sessionID: "session-a", time: { created: 3 } } as Message
  const nextMessage = { id: "next-message", role: "user", sessionID: "session-a", time: { created: 4 } } as Message

  test("uses the latest user message while a response is in progress", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "busy" })).toBe("user-message")
    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "retry", attempt: 1, message: "retrying", next: 0 })).toBe("user-message")
  })

  test("resolves explicit fork points against source message roles", async () => {
    const { resolveForkMessageId } = await import("./session-actions")

    expect(resolveForkMessageId("user-message", [userMessage, assistantMessage], { type: "busy" })).toBe("user-message")
    expect(resolveForkMessageId("assistant-message", [userMessage, assistantMessage, nextMessage], { type: "idle" })).toBe("next-message")
    expect(resolveForkMessageId("assistant-message", [userMessage, assistantMessage], { type: "idle" })).toBe(undefined)
    expect(resolveForkMessageId("unknown-message", [userMessage, assistantMessage], { type: "busy" })).toBe("unknown-message")
    expect(resolveForkMessageId(undefined, [userMessage, assistantMessage], { type: "idle" })).toBe(undefined)
  })
})

describe("forkSession input restoration", () => {
  beforeEach(() => {
    replyCalls.length = 0
    clearAttachedFilesCalls = 0
    sessionMessagesResult = { data: [] }
    sessionGetResult = null
    globalActiveSessions = []
    globalArchivedSessions = []
    sessionForkResult = { id: "forked-session", title: "Source (fork #1)", time: { created: 2 } } as Session
    sessionUpdateResult = { data: sessionForkResult }
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
    expect(clearAttachedFilesCalls).toBe(0)
    expect(inputState.attachedFiles).toEqual([{ url: "file:///existing.txt", mimeType: "text/plain", filename: "existing.txt" }])
    expect(inputState.pendingInputText).toBe("existing draft")
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

    expect(clearAttachedFilesCalls).toBe(1)
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
    expect(clearAttachedFilesCalls).toBe(0)
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
    globalActiveSessions = [sourceSession]
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
    sessionGetResult = sourceSession
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
})

describe("shareSession live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionShareResult = {}
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
    sessionShareResult = { data: unsharedSession }

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
    sessionShareResult = { data: sharedSession }

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
    sessionShareResult = { data: unsharedSession }

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
    sessionShareResult = { data: sessionWithDiff }

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
    sessionUpdateResult = {}
  })

  test("updates the live directory store after renaming", async () => {
    const oldSession = { id: "session-a", title: "Old Title", time: { created: 1, updated: 1 } } as Session
    const updatedSession = { id: "session-a", title: "New Title", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionUpdateResult = { data: updatedSession }

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

describe("optimisticSend target directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionMessagesResult = { data: [] }
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
        sessionMessagesResult = {
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
    sessionRevertResult = {}
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
    sessionRevertResult = {}
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
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
    sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await revertToMessage("session-a", "msg_2")

    expect(replyCalls.find((call) => call.method === "session.revert")?.params.directory).toBe("/test/project")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    expect(currentStore.getState().session).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("edit this")
  })

  test("rolls back optimistic revert when the SDK returns an error", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRevertResult = { error: { message: "rejected" }, response: { status: 500 } }

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
    expect(inputState.pendingInputText).toBe("previous draft")
  })
})

describe("message edit staging", () => {
  beforeEach(() => {
    replyCalls.length = 0
    sessionDeleteMessageFailureID = null
    sessionMessagesResult = { data: [] }
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }],
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

    stageMessageEdit("session-a", "msg_2")

    expect(replyCalls.filter((call) => call.method === "session.deleteMessage")).toHaveLength(0)
    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_2", "msg_3", "msg_4"])
    expect(sessionStore.getState().part["msg_2"]).toEqual(targetParts)
    expect(inputState.pendingInputText).toBe("edit this")
    expect(inputState.pendingInputMode).toBe("replace")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///attached.txt", mimeType: "text/plain", filename: "attached.txt" }])
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

    stageMessageEdit("session-a", "msg_2", snapshot)

    expect(inputState.pendingInputText).toBe("edit this")
    expect(inputState.pendingInputMode).toBe("replace")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///attached.txt", mimeType: "text/plain", filename: "attached.txt" }])
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

    expect(() => stageMessageEdit("session-a", "msg_2", snapshot)).toThrow("The selected user message is unavailable")
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

  test("preserves the existing draft when a later-message deletion fails", async () => {
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
    sessionDeleteMessageFailureID = "msg_3"

    const { commitMessageEdit, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await expect(commitMessageEdit("session-a", "msg_2")).rejects.toThrow("session.deleteMessage failed (500)")

    expect(sessionStore.getState().message["session-a"].map((message) => message.id)).toEqual(["msg_2", "msg_3"])
    expect(sessionStore.getState().part["msg_4"]).toBe(undefined)
    expect(inputState.pendingInputText).toBe("previous draft")
    expect(inputState.pendingInputMode).toBe("normal")
    expect(inputState.attachedFiles).toEqual([{ url: "file:///previous.txt", mimeType: "text/plain", filename: "previous.txt" }])
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
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
    questionReplyError = null
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
    questionReplyError = Object.assign(new Error("question.reply failed (404): QuestionNotFoundError"), { status: 404 })

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
    questionReplyError = null
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

describe("dismissOpenQuestionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
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
    questionRejectError = Object.assign(new Error("question.reject failed (404): QuestionNotFoundError"), { status: 404 })

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
