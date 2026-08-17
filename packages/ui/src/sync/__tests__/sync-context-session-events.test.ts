import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Session, SessionInfo } from '@/lib/opencode/v2-types'
import type { Event } from '@/sync/types'
import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []
const reconnectHarness = {
  sessionGetResult: null as SessionInfo | Error | null,
  onSessionGet: null as (() => void) | null,
  transcriptFetchShouldThrow: true,
}

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
    }),
  },
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/workspace/project",
    getScopedSdkClient: () => ({
      session: {
        get: async () => {
          reconnectHarness.onSessionGet?.()
          if (reconnectHarness.sessionGetResult instanceof Error) throw reconnectHarness.sessionGetResult
          if (!reconnectHarness.sessionGetResult) throw new Error("session.get is unavailable")
          return reconnectHarness.sessionGetResult
        },
      },
    }),
    setDirectory: () => undefined,
  },
}))

mock.module("../session-status-reconciliation", () => ({
  promoteRetryToBusyOnLiveActivity: () => undefined,
  reconcileActiveSessionStatusAfterMessagePull: async () => undefined,
  resyncDirectorySessionStatuses: async () => null,
  setAuthoritativeGlobalSessionStatusConverge: () => undefined,
}))

mock.module("../transcript-repository-production", () => ({
  applyProductionHttpPage: () => ({ applied: false }),
  fetchProductionTranscriptTransportPage: async () => {
    if (reconnectHarness.transcriptFetchShouldThrow) throw new Error("transcript recovery failed")
    return { records: [], cursor: undefined, complete: true }
  },
  mountProductionTranscriptStack: () => undefined,
}))

import { applySessionEventToGlobalSessions } from "../session-event-router"
import {
  getSessionIdFromPayload,
  resyncDirectoryAfterReconnect,
  setActiveSession,
} from "../sync-context"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  title,
  time,
} as Session)

const buildEvent = (session: Session): Event => ({
  type: "session.updated",
  properties: {
    info: session,
  },
} as Event)

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    currentSessions = []
    upsertedSessions.length = 0
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    currentSessions = [buildSession("New Title", { created: 1, updated: 20 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })

  test("skips time-only session updates and renderer-side index writes", () => {
    currentSessions = [buildSession("Same Title", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Same Title", { created: 1, updated: 20 })))

    expect(upsertedSessions).toEqual([])
  })

  test("applies visible session updates", () => {
    currentSessions = [buildSession("Old Title", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("New Title", { created: 1, updated: 20 })))

    expect(upsertedSessions).toHaveLength(1)
  })
})

describe("getSessionIdFromPayload", () => {
  test("extracts properties.sessionID for session.idle", () => {
    expect(getSessionIdFromPayload({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe("ses_1")
  })

  test("extracts properties.sessionID for session.error", () => {
    expect(getSessionIdFromPayload({
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe("ses_1")
  })
})

const DIRECTORY = "/workspace/project"

function buildV2SessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_1",
    projectID: "prj_1",
    title: "Viewed",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: DIRECTORY },
    ...overrides,
  } as SessionInfo
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
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

describe("resyncDirectoryAfterReconnect v2 session projection", () => {
  beforeEach(() => {
    reconnectHarness.sessionGetResult = null
    reconnectHarness.onSessionGet = null
    reconnectHarness.transcriptFetchShouldThrow = true
    setActiveSession("", "")
  })

  test("projects session.get SessionInfo.location.directory onto the child-store session", async () => {
    const store = createDirectoryStore({
      session: [{ id: "ses_1", title: "Viewed", time: { created: 1, updated: 1 } } as Session],
      session_status: { ses_1: { type: "busy" } },
    })
    setActiveSession(DIRECTORY, "ses_1")
    reconnectHarness.sessionGetResult = buildV2SessionInfo()

    await resyncDirectoryAfterReconnect(
      DIRECTORY,
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
      { statusOnly: true },
    )

    const next = store.getState().session.find((session) => session.id === "ses_1")
    expect(next?.directory).toBe(DIRECTORY)
    expect("directory" in (reconnectHarness.sessionGetResult as object)).toBe(false)
  })

  test("inserts a viewed session missing from the catalog using the projected directory", async () => {
    const store = createDirectoryStore({ session: [] })
    const routingIndex = createRoutingIndex()
    setActiveSession(DIRECTORY, "ses_1")
    reconnectHarness.sessionGetResult = buildV2SessionInfo({
      location: { directory: "/workspace/other" },
    })

    await resyncDirectoryAfterReconnect(
      DIRECTORY,
      store,
      routingIndex,
      "stream-reconnect",
      () => 1,
      { statusOnly: true },
    )

    expect(store.getState().session).toHaveLength(1)
    expect(store.getState().session[0]?.directory).toBe("/workspace/other")
    expect(routingIndex.sessionDirectoryById.get("ses_1")).toBe(DIRECTORY)
  })

  test("session.get failure does not clear existing child-store session state", async () => {
    const existing = {
      id: "ses_1",
      title: "Kept",
      directory: DIRECTORY,
      time: { created: 1, updated: 1 },
    } as Session
    const store = createDirectoryStore({
      session: [existing],
      session_status: { ses_1: { type: "busy" } },
    })
    setActiveSession(DIRECTORY, "ses_1")
    reconnectHarness.sessionGetResult = new Error("session.get failed")

    await resyncDirectoryAfterReconnect(
      DIRECTORY,
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
      { statusOnly: true },
    )

    expect(store.getState().session).toEqual([existing])
    expect(store.getState().session_status?.ses_1).toEqual({ type: "busy" })
  })

  test("transcript recovery failure keeps the projected identity and prior status", async () => {
    const store = createDirectoryStore({
      session: [{ id: "ses_1", title: "Viewed", time: { created: 1, updated: 1 } } as Session],
      session_status: { ses_1: { type: "retry", attempt: 1, message: "x", next: 9 } },
    })
    setActiveSession(DIRECTORY, "ses_1")
    reconnectHarness.sessionGetResult = buildV2SessionInfo({ title: "Recovered" })
    reconnectHarness.transcriptFetchShouldThrow = true

    await resyncDirectoryAfterReconnect(
      DIRECTORY,
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => 1,
      { statusOnly: true },
    )

    const next = store.getState().session.find((session) => session.id === "ses_1")
    expect(next?.directory).toBe(DIRECTORY)
    expect(next?.title).toBe("Recovered")
    expect(store.getState().session_status?.ses_1).toEqual({
      type: "retry",
      attempt: 1,
      message: "x",
      next: 9,
    })
  })

  test("live events during session.get skip only the identity write", async () => {
    const existing = {
      id: "ses_1",
      title: "Streaming",
      time: { created: 1, updated: 1 },
    } as Session
    const store = createDirectoryStore({ session: [existing] })
    setActiveSession(DIRECTORY, "ses_1")
    reconnectHarness.sessionGetResult = buildV2SessionInfo({ title: "Stale identity" })
    let revision = 1
    reconnectHarness.onSessionGet = () => {
      revision = 2
    }

    await resyncDirectoryAfterReconnect(
      DIRECTORY,
      store,
      createRoutingIndex(),
      "stream-reconnect",
      () => revision,
      { statusOnly: true },
    )

    expect(store.getState().session).toEqual([existing])
    expect(store.getState().session[0]?.directory).toBeUndefined()
  })
})
