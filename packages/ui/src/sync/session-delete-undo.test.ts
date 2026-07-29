import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
let deleteSessionResult: boolean | Error = true
let updateSessionImpl: (sessionId: string, changes: Record<string, unknown>, directory?: string | null) => Promise<Session>

const globalState = {
  activeSessions: [] as Session[],
  archivedSessions: [] as Session[],
  pendingDeletionIds: new Set<string>(),
}

function upsertGlobalSession(session: Session): void {
  if (globalState.pendingDeletionIds.has(session.id)) return
  const isArchived = Boolean(session.time?.archived)
  globalState.activeSessions = isArchived
    ? globalState.activeSessions.filter((item) => item.id !== session.id)
    : [session, ...globalState.activeSessions.filter((item) => item.id !== session.id)]
  globalState.archivedSessions = isArchived
    ? [session, ...globalState.archivedSessions.filter((item) => item.id !== session.id)]
    : globalState.archivedSessions.filter((item) => item.id !== session.id)
}

const uiState = {
  currentSessionId: null as string | null,
  setCurrentSessionCalls: [] as Array<{ id: string | null; directory: string | null | undefined }>,
}

function makeSession(id: string, options?: { archived?: number; directory?: string }): Session {
  return {
    id,
    slug: id,
    projectID: "proj",
    directory: options?.directory ?? "/test/project",
    title: id,
    version: "1",
    time: {
      created: 1,
      updated: 2,
      ...(options?.archived ? { archived: options.archived } : {}),
    },
  } as Session
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/test/project",
    getSession: mock(async () => {
      throw new Error("not used")
    }),
    deleteSession: mock(async (sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.delete", params: { sessionID: sessionId, directory } })
      if (deleteSessionResult instanceof Error) throw deleteSessionResult
      return deleteSessionResult
    }),
    updateSession: mock(async (sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return updateSessionImpl(sessionId, changes, directory)
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: null,
    }),
  },
}))

mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: uiState.currentSessionId,
      getDirectoryForSession: (sessionId: string) => {
        const hit = [...globalState.activeSessions, ...globalState.archivedSessions]
          .find((session) => session.id === sessionId)
        return (hit as Session & { directory?: string } | undefined)?.directory ?? "/test/project"
      },
      setCurrentSession: (id: string | null, directoryHint?: string | null) => {
        uiState.currentSessionId = id
        uiState.setCurrentSessionCalls.push({ id, directory: directoryHint })
      },
      setWorktreeMetadata: () => undefined,
      getWorktreeMetadata: () => null,
    }),
    setState: () => undefined,
  },
}))

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => ({}),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: globalState.activeSessions,
      archivedSessions: globalState.archivedSessions,
      pendingDeletionIds: globalState.pendingDeletionIds,
      upsertSession: upsertGlobalSession,
      markSessionsPendingDeletion: (ids: Iterable<string>) => {
        for (const id of ids) globalState.pendingDeletionIds.add(id)
      },
      clearSessionsPendingDeletion: (ids: Iterable<string>) => {
        for (const id of ids) globalState.pendingDeletionIds.delete(id)
      },
      removeSessions: (ids: Iterable<string>) => {
        const idSet = new Set(ids)
        globalState.activeSessions = globalState.activeSessions.filter((session) => !idSet.has(session.id))
        globalState.archivedSessions = globalState.archivedSessions.filter((session) => !idSet.has(session.id))
      },
      archiveSessions: (ids: Iterable<string>, archivedAt = Date.now()) => {
        const idSet = new Set(ids)
        const moved: Session[] = []
        globalState.activeSessions = globalState.activeSessions.filter((session) => {
          if (!idSet.has(session.id)) return true
          moved.push({
            ...session,
            time: { ...session.time, archived: archivedAt },
          })
          return false
        })
        globalState.archivedSessions = [...moved, ...globalState.archivedSessions]
      },
    }),
  },
}))

mock.module("./sync-refs", () => ({
  getAllSyncSessionMap: () => new Map(),
  registerSessionDirectory: () => undefined,
}))

const {
  cancelScheduledSessionDeletes,
  clearScheduledSessionDeletesForTests,
  scheduleSessionDeletes,
  unarchiveSession,
} = await import("./session-actions")

describe("session delete undo window", () => {
  beforeEach(() => {
    replyCalls.length = 0
    deleteSessionResult = true
    updateSessionImpl = async (sessionId, changes) => {
      const base = makeSession(sessionId, { archived: 100 })
      const timePatch = (changes.time as { archived?: number } | undefined) ?? {}
      return {
        ...base,
        time: {
          ...base.time,
          ...timePatch,
        },
      }
    }
    globalState.activeSessions = [makeSession("ses_1"), makeSession("ses_2")]
    globalState.archivedSessions = []
    uiState.currentSessionId = "ses_1"
    uiState.setCurrentSessionCalls = []
    clearScheduledSessionDeletesForTests()
    globalState.pendingDeletionIds.clear()
  })

  afterEach(() => {
    clearScheduledSessionDeletesForTests()
  })

  test("scheduleSessionDeletes removes optimistically and commits after delay", async () => {
    let settledResult: { deletedIds: string[]; failedIds: string[] } | null = null
    const settled = new Promise<{ deletedIds: string[]; failedIds: string[] }>((resolve) => {
      // resolved from onSettled below
      const check = () => {
        if (settledResult) resolve(settledResult)
        else setTimeout(check, 5)
      }
      setTimeout(check, 5)
    })
    const { batchId, scheduledIds } = scheduleSessionDeletes(["ses_1"], {
      delayMs: 20,
      onSettled: (result) => {
        settledResult = result
      },
    })

    expect(batchId).toBeTruthy()
    expect(scheduledIds).toEqual(["ses_1"])
    expect(globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])
    expect(uiState.currentSessionId).toBeNull()
    expect(replyCalls.some((call) => call.method === "session.delete")).toBe(false)

    const result = await settled
    expect(result).toEqual({ deletedIds: ["ses_1"], failedIds: [] })
    expect(replyCalls.some((call) => call.method === "session.delete")).toBe(true)
  })

  test("cancelScheduledSessionDeletes restores local state without deleting", async () => {
    const { batchId } = scheduleSessionDeletes(["ses_1"], { delayMs: 50 })
    expect(globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])

    const cancelled = cancelScheduledSessionDeletes(batchId)
    expect(cancelled).toBe(true)
    expect(globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(globalState.pendingDeletionIds).toEqual(new Set())
    expect(uiState.setCurrentSessionCalls.some((call) => call.id === "ses_1")).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(replyCalls.some((call) => call.method === "session.delete")).toBe(false)
  })

  test("keeps a server upsert hidden during the undo window", () => {
    const { batchId } = scheduleSessionDeletes(["ses_1"], { delayMs: 50 })
    upsertGlobalSession(makeSession("ses_1"))

    expect(globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])
    expect(globalState.pendingDeletionIds).toEqual(new Set(["ses_1"]))

    cancelScheduledSessionDeletes(batchId)
    expect(globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(globalState.pendingDeletionIds).toEqual(new Set())
  })

  test("restores a failed delayed delete and clears its pending state", async () => {
    deleteSessionResult = new Error("delete failed")
    const settled = new Promise<{ deletedIds: string[]; failedIds: string[] }>((resolve) => {
      scheduleSessionDeletes(["ses_1"], { delayMs: 5, onSettled: resolve })
    })

    expect(await settled).toEqual({ deletedIds: [], failedIds: ["ses_1"] })
    expect(globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(globalState.pendingDeletionIds).toEqual(new Set())
  })

  test("unarchiveSession clears archived timestamp via updateSession(0)", async () => {
    const archived = makeSession("ses_arch", { archived: 1234 })
    globalState.activeSessions = []
    globalState.archivedSessions = [archived]

    const ok = await unarchiveSession("ses_arch")
    expect(ok).toBe(true)

    const updateCall = replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("ses_arch")
    expect(updateCall?.params.time).toEqual({ archived: 0 })
    expect(globalState.archivedSessions).toEqual([])
    expect(globalState.activeSessions[0]?.id).toBe("ses_arch")
    expect(globalState.activeSessions[0]?.time?.archived).toEqual(undefined)
  })
})
