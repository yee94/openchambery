import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Session } from "@opencode-ai/sdk/v2/client"

const mocks = vi.hoisted(() => {
  const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const globalState = {
    activeSessions: [] as Session[],
    archivedSessions: [] as Session[],
    pendingDeletionIds: new Set<string>(),
  }
  const uiState = {
    currentSessionId: null as string | null,
    setCurrentSessionCalls: [] as Array<{ id: string | null; directory: string | null | undefined }>,
  }
  const state = {
    deleteSessionResult: true as boolean | Error,
    updateSessionImpl: (async (sessionId: string, _changes: Record<string, unknown>, _directory?: string | null) => {
      return { id: sessionId } as Session
    }) as (sessionId: string, changes: Record<string, unknown>, directory?: string | null) => Promise<Session>,
  }

  const upsertGlobalSession = (session: Session): void => {
    if (globalState.pendingDeletionIds.has(session.id)) return
    const isArchived = Boolean(session.time?.archived)
    globalState.activeSessions = isArchived
      ? globalState.activeSessions.filter((item) => item.id !== session.id)
      : [session, ...globalState.activeSessions.filter((item) => item.id !== session.id)]
    globalState.archivedSessions = isArchived
      ? [session, ...globalState.archivedSessions.filter((item) => item.id !== session.id)]
      : globalState.archivedSessions.filter((item) => item.id !== session.id)
  }

  return { replyCalls, globalState, uiState, state, upsertGlobalSession }
})

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

vi.mock("@/lib/opencode/client", () => ({
  opencodeClient: {
    setDirectory: vi.fn(),
    getDirectory: () => "/test/project",
    getSession: vi.fn(async () => {
      throw new Error("not used")
    }),
    deleteSession: vi.fn(async (sessionId: string, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.delete", params: { sessionID: sessionId, directory } })
      if (mocks.state.deleteSessionResult instanceof Error) throw mocks.state.deleteSessionResult
      return mocks.state.deleteSessionResult
    }),
    updateSession: vi.fn(async (sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      mocks.replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return mocks.state.updateSessionImpl(sessionId, changes, directory)
    }),
  },
}))

vi.mock("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: null,
    }),
  },
}))

vi.mock("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: mocks.uiState.currentSessionId,
      getDirectoryForSession: (sessionId: string) => {
        const hit = [...mocks.globalState.activeSessions, ...mocks.globalState.archivedSessions]
          .find((session) => session.id === sessionId)
        return (hit as Session & { directory?: string } | undefined)?.directory ?? "/test/project"
      },
      setCurrentSession: (id: string | null, directoryHint?: string | null) => {
        mocks.uiState.currentSessionId = id
        mocks.uiState.setCurrentSessionCalls.push({ id, directory: directoryHint })
      },
      setWorktreeMetadata: () => undefined,
      getWorktreeMetadata: () => null,
    }),
    setState: () => undefined,
  },
}))

vi.mock("./input-store", () => ({
  useInputStore: {
    getState: () => ({}),
    setState: () => undefined,
  },
}))

vi.mock("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: mocks.globalState.activeSessions,
      archivedSessions: mocks.globalState.archivedSessions,
      pendingDeletionIds: mocks.globalState.pendingDeletionIds,
      upsertSession: mocks.upsertGlobalSession,
      markSessionsPendingDeletion: (ids: Iterable<string>) => {
        for (const id of ids) mocks.globalState.pendingDeletionIds.add(id)
      },
      clearSessionsPendingDeletion: (ids: Iterable<string>) => {
        for (const id of ids) mocks.globalState.pendingDeletionIds.delete(id)
      },
      removeSessions: (ids: Iterable<string>) => {
        const idSet = new Set(ids)
        mocks.globalState.activeSessions = mocks.globalState.activeSessions.filter((session) => !idSet.has(session.id))
        mocks.globalState.archivedSessions = mocks.globalState.archivedSessions.filter((session) => !idSet.has(session.id))
      },
      archiveSessions: (ids: Iterable<string>, archivedAt = Date.now()) => {
        const idSet = new Set(ids)
        const moved: Session[] = []
        mocks.globalState.activeSessions = mocks.globalState.activeSessions.filter((session) => {
          if (!idSet.has(session.id)) return true
          moved.push({
            ...session,
            time: { ...session.time, archived: archivedAt },
          })
          return false
        })
        mocks.globalState.archivedSessions = [...moved, ...mocks.globalState.archivedSessions]
      },
    }),
  },
}))

vi.mock("./sync-refs", () => ({
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
    mocks.replyCalls.length = 0
    mocks.state.deleteSessionResult = true
    mocks.state.updateSessionImpl = async (sessionId, changes) => {
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
    mocks.globalState.activeSessions = [makeSession("ses_1"), makeSession("ses_2")]
    mocks.globalState.archivedSessions = []
    mocks.uiState.currentSessionId = "ses_1"
    mocks.uiState.setCurrentSessionCalls = []
    clearScheduledSessionDeletesForTests()
    mocks.globalState.pendingDeletionIds.clear()
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
    expect(mocks.globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])
    expect(mocks.uiState.currentSessionId).toBeNull()
    expect(mocks.replyCalls.some((call) => call.method === "session.delete")).toBe(false)

    const result = await settled
    expect(result).toEqual({ deletedIds: ["ses_1"], failedIds: [] })
    expect(mocks.replyCalls.some((call) => call.method === "session.delete")).toBe(true)
  })

  test("cancelScheduledSessionDeletes restores local state without deleting", async () => {
    const { batchId } = scheduleSessionDeletes(["ses_1"], { delayMs: 50 })
    expect(mocks.globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])

    const cancelled = cancelScheduledSessionDeletes(batchId)
    expect(cancelled).toBe(true)
    expect(mocks.globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(mocks.globalState.pendingDeletionIds).toEqual(new Set())
    expect(mocks.uiState.setCurrentSessionCalls.some((call) => call.id === "ses_1")).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(mocks.replyCalls.some((call) => call.method === "session.delete")).toBe(false)
  })

  test("keeps a server upsert hidden during the undo window", () => {
    const { batchId } = scheduleSessionDeletes(["ses_1"], { delayMs: 50 })
    mocks.upsertGlobalSession(makeSession("ses_1"))

    expect(mocks.globalState.activeSessions.map((session) => session.id)).toEqual(["ses_2"])
    expect(mocks.globalState.pendingDeletionIds).toEqual(new Set(["ses_1"]))

    cancelScheduledSessionDeletes(batchId)
    expect(mocks.globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(mocks.globalState.pendingDeletionIds).toEqual(new Set())
  })

  test("restores a failed delayed delete and clears its pending state", async () => {
    mocks.state.deleteSessionResult = new Error("delete failed")
    const settled = new Promise<{ deletedIds: string[]; failedIds: string[] }>((resolve) => {
      scheduleSessionDeletes(["ses_1"], { delayMs: 5, onSettled: resolve })
    })

    expect(await settled).toEqual({ deletedIds: [], failedIds: ["ses_1"] })
    expect(mocks.globalState.activeSessions.map((session) => session.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(mocks.globalState.pendingDeletionIds).toEqual(new Set())
  })

  test("unarchiveSession clears archived timestamp via updateSession(0)", async () => {
    const archived = makeSession("ses_arch", { archived: 1234 })
    mocks.globalState.activeSessions = []
    mocks.globalState.archivedSessions = [archived]

    const ok = await unarchiveSession("ses_arch")
    expect(ok).toBe(true)

    const updateCall = mocks.replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("ses_arch")
    expect(updateCall?.params.time).toEqual({ archived: 0 })
    expect(mocks.globalState.archivedSessions).toEqual([])
    expect(mocks.globalState.activeSessions[0]?.id).toBe("ses_arch")
    expect(mocks.globalState.activeSessions[0]?.time?.archived).toEqual(undefined)
  })
})
