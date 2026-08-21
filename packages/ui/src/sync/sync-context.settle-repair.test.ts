/**
 * Regression coverage for the "assistant TPS missing after settle" repair.
 *
 * The settle `message.updated` tick that carries `time.completed` can be lost
 * on the live channel (observed on mobile relay/WS). The tail assistant then
 * keeps its terminal finish without a completion timestamp, turn duration and
 * assistant TPS cannot render, and a cold start is the only recovery. These
 * tests pin the two self-heal triggers added around session materialization:
 *
 * 1. A cooldown-suppressed enqueue still repairs when the live tail shows the
 *    settle gap (the suppression check is deferred one microtask so a settle
 *    tick lost earlier in the same event frame is visible).
 * 2. A completed materialization whose page could not repair the gap (e.g.
 *    stale-dropped against live SSE) reconciles once from authority.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

const { fetchPageMock } = vi.hoisted(() => ({ fetchPageMock: vi.fn() }))

vi.mock("./transcript-repository-production", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcript-repository-production")>()
  return {
    ...actual,
    fetchProductionTranscriptTransportPage: fetchPageMock,
  }
})

import { handleEvent, setActiveSession } from "./sync-context"
import {
  bindTranscriptRepositoryInstance,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import type { TranscriptRepository, TranscriptScope } from "./transcript-repository"
import type { ChildStoreManager } from "./child-store"

const DIRECTORY = "/proj"
const SESSION = "ses_settle"

type RoutingIndex = Parameters<typeof handleEvent>[3]

const routingIndex: RoutingIndex = {
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
} as RoutingIndex

const idleEvent: Event = {
  type: "session.idle",
  properties: { sessionID: SESSION },
} as Event

const assistantWith = (extra: Partial<Message>): Message =>
  ({
    id: "msg_a",
    sessionID: SESSION,
    role: "assistant",
    time: { created: 2000 },
    ...extra,
  }) as Message

const gapTail = assistantWith({
  finish: "stop",
  tokens: { input: 1, output: 44, reasoning: 9, cache: { read: 0, write: 0 } },
})
const settledTail = assistantWith({
  finish: "stop",
  tokens: { input: 1, output: 44, reasoning: 9, cache: { read: 0, write: 0 } },
  time: { created: 2000, completed: 21000 },
})

const transcriptFor = (tail: Message) => ({
  sessionID: SESSION,
  messageOrder: ["msg_u", tail.id],
  messagesByID: { msg_u: { id: "msg_u", sessionID: SESSION, role: "user", time: { created: 1000 } } as Message, [tail.id]: tail },
  partsByMessageID: {} as Record<string, readonly Part[]>,
  boundary: { kind: "exhausted", loadedTurns: 1 } as const,
  liveRevision: 3,
})

const createStore = () => {
  const state: Record<string, unknown> = {
    session: [],
    session_status: {},
    session_status_observed_at: {},
    permission: {},
    question: {},
    todo: {},
    session_diff: {},
    lsp: [],
  }
  return {
    getState: () => state,
    setState: (next: Record<string, unknown>) => Object.assign(state, next),
    subscribe: () => () => {},
  }
}

const childStores = {
  getChild: () => createStore(),
  children: new Map(),
  ensureChild: () => undefined,
  mark: () => undefined,
} as unknown as ChildStoreManager

const bindRepository = (tail: Message) => {
  const refreshFromAuthority = vi.fn(async (_scope: TranscriptScope) => transcriptFor(tail))
  const repository = {
    getTranscript: () => transcriptFor(tail),
    apply: () => ({ applied: true, changed: true }),
    refreshFromAuthority,
  } as unknown as TranscriptRepository
  bindTranscriptRepositoryInstance(repository)
  return refreshFromAuthority
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("settle-gap repair around session materialization", () => {
  beforeEach(() => {
    fetchPageMock.mockReset()
    setActiveSession(DIRECTORY, SESSION)
  })

  afterEach(() => {
    setActiveSession("", "")
    unbindTranscriptRepository()
  })

  test("cooldown-suppressed idle enqueue repairs a missing settle tick", async () => {
    const refreshFromAuthority = bindRepository(gapTail)
    fetchPageMock.mockRejectedValue(new Error("offline"))

    // First idle claims the materialization slot (its fetch fails offline);
    // the second lands inside the cooldown window and must still repair.
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)

    await vi.waitFor(() => {
      expect(refreshFromAuthority).toHaveBeenCalledTimes(1)
    })
    const scope = refreshFromAuthority.mock.calls[0]![0] as TranscriptScope
    expect(scope.directory).toBe(DIRECTORY)
    expect(scope.sessionID).toBe(SESSION)
  })

  test("cooldown-suppressed idle enqueue stays quiet without the gap", async () => {
    const refreshFromAuthority = bindRepository(settledTail)
    fetchPageMock.mockRejectedValue(new Error("offline"))

    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    await flushAsync()
    await flushAsync()

    expect(refreshFromAuthority).not.toHaveBeenCalled()
  })

  test("materialize that cannot repair the gap reconciles from authority", async () => {
    const refreshFromAuthority = bindRepository(gapTail)
    fetchPageMock.mockResolvedValue({
      records: [
        { info: { id: "msg_u", sessionID: SESSION, role: "user", time: { created: 1000 } }, parts: [] },
        { info: settledTail, parts: [] },
      ],
      complete: true,
      turnCount: 1,
    })

    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)

    await vi.waitFor(() => {
      expect(refreshFromAuthority).toHaveBeenCalledTimes(1)
    })
  })
})
