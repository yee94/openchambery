import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { createMemoryTranscriptDurableStore } from "./transcript-durable-store"
import {
  countTranscriptAuthoredUserTurns,
  evaluateTranscriptP0Satisfied,
  resolveTranscriptHydrationPhase,
  type TranscriptData,
  type TranscriptTransportPage,
} from "./transcript-repository"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createStoreTranscriptRepository, type TranscriptStoreSurface } from "./transcript-repository-store-adapter"
import {
  bindTranscriptRepositoryInstance,
  getTranscriptHydrationState,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import { readTranscriptHydrationState } from "./transcript-repository-observers"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"
import type { SessionHistoryBoundary } from "./types"

const DIRECTORY = "/repo"
const SESSION = "ses_1"
const TRANSPORT = "runtime-a"
const GENERATION = 1

const scope = {
  directory: DIRECTORY,
  sessionID: SESSION,
  transport: TRANSPORT,
  generation: GENERATION,
}

const user = (id: string, created = 1): Message =>
  ({ id, sessionID: SESSION, role: "user", time: { created } }) as Message

const assistant = (
  id: string,
  created: number,
  extra: { finish?: string; parentID?: string } = {},
): Message =>
  ({
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created },
    ...(extra.finish ? { finish: extra.finish } : {}),
    ...(extra.parentID ? { parentID: extra.parentID } : {}),
  }) as Message

const text = (id: string, messageID: string, value = id): Part =>
  ({ id, messageID, sessionID: SESSION, type: "text", text: value }) as Part

const slimTool = (id: string, messageID: string): Part =>
  ({
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed" },
    slim: true,
  }) as unknown as Part

const fullTool = (id: string, messageID: string, output: string): Part =>
  ({
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed", output },
  }) as unknown as Part

const transcript = (
  rows: Array<{ info: Message; parts?: Part[] }>,
): TranscriptData => {
  const messageOrder = rows.map((row) => row.info.id)
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  for (const row of rows) {
    messagesByID[row.info.id] = row.info
    partsByMessageID[row.info.id] = row.parts ?? []
  }
  return {
    sessionID: SESSION,
    messageOrder,
    messagesByID,
    partsByMessageID,
    boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
    liveRevision: 0,
  }
}

const page = (
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean; turnCount?: number } = {},
): TranscriptTransportPage => ({
  records: records.map((record) => ({ info: record.info, parts: record.parts ?? [] })),
  cursor: options.cursor,
  complete: options.complete ?? !options.cursor,
  turnCount: options.turnCount ?? records.filter((record) => record.info.role === "user").length,
})

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeout = 800) => {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for hydration")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("evaluateTranscriptP0Satisfied", () => {
  test("a user-only tail stays unsatisfied", () => {
    expect(evaluateTranscriptP0Satisfied(transcript([
      { info: user("u1"), parts: [text("p1", "u1", "hello")] },
    ]))).toBe(false)
  })

  test("a settled assistant with parts satisfies P0", () => {
    expect(evaluateTranscriptP0Satisfied(transcript([
      { info: user("u1"), parts: [text("p1", "u1", "hello")] },
      { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1", "done")] },
    ]))).toBe(true)
  })

  test("an in-progress assistant row is enough for the Activity shell", () => {
    expect(evaluateTranscriptP0Satisfied(transcript([
      { info: user("u1"), parts: [text("p1", "u1")] },
      { info: assistant("a1", 2, { parentID: "u1" }), parts: [] },
    ]))).toBe(true)
  })

  test("a settled assistant without parts is not displayable", () => {
    expect(evaluateTranscriptP0Satisfied(transcript([
      { info: user("u1"), parts: [text("p1", "u1")] },
      { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [] },
    ]))).toBe(false)
  })

  test("counts earlier authored turns for P1 satisfaction", () => {
    const data = transcript([
      { info: user("u0", 1), parts: [text("p0", "u0")] },
      { info: assistant("a0", 2, { finish: "stop", parentID: "u0" }), parts: [text("pa0", "a0")] },
      { info: user("u1", 3), parts: [text("p1", "u1")] },
      { info: assistant("a1", 4, { finish: "stop", parentID: "u1" }), parts: [text("pa1", "a1")] },
    ])
    expect(countTranscriptAuthoredUserTurns(data)).toBe(2)
    expect(resolveTranscriptHydrationPhase({
      p0Satisfied: true,
      earlierHistoryLoaded: true,
    })).toBe("p1")
  })

  test("active materialize wins over loaded history", () => {
    expect(resolveTranscriptHydrationPhase({
      p0Satisfied: true,
      earlierHistoryLoaded: true,
      materializeActive: true,
    })).toBe("p2")
  })
})

describe("Query repository hydration phases", () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 } } })

  test("durable seed that satisfies P0 latches p0 before the authority tail returns", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(scope, user("u1"), [text("p1", "u1", "hello")])
    await inner.upsertSettled(
      scope,
      assistant("a1", 2, { finish: "stop", parentID: "u1" }),
      [text("p2", "a1", "cached")],
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => {
        await gate
        return page([
          { info: user("u1"), parts: [text("p1", "u1", "hello")] },
          { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1", "live")] },
        ], { complete: true, turnCount: 1 })
      },
      probe: { getTransport: () => TRANSPORT, getGeneration: () => GENERATION },
    })
    const pending = repo.ensureInitial(scope)
    await waitUntil(() => repo.getHydrationState(scope).p0Satisfied)
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    release()
    await pending
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    repo.destroy()
  })

  test("authority HTTP that satisfies P0 enters p0", async () => {
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      fetcher: async () => page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1", "ok")] },
      ], { complete: true, turnCount: 1 }),
      probe: { getTransport: () => TRANSPORT, getGeneration: () => GENERATION },
    })
    await repo.ensureInitial(scope)
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    repo.destroy()
  })

  test("a busy assistant row satisfies P0 as an Activity shell", () => {
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { parentID: "u1" }), parts: [] },
      ], { complete: true, turnCount: 1 }),
    })
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    repo.destroy()
  })

  test("prepend active is p1 and stays p1 after earlier history lands", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      fetcher: async (input) => {
        fetches += 1
        if (input.before) {
          await gate
          return page([
            { info: user("u0", 1), parts: [text("p0", "u0", "older")] },
            { info: assistant("a0", 2, { finish: "stop", parentID: "u0" }), parts: [text("pa0", "a0")] },
          ], { complete: true, turnCount: 1 })
        }
        return page([
          { info: user("u1", 3), parts: [text("p1", "u1")] },
          { info: assistant("a1", 4, { finish: "stop", parentID: "u1" }), parts: [text("pa1", "a1")] },
        ], { cursor: "u1", complete: false, turnCount: 1 })
      },
      probe: { getTransport: () => TRANSPORT, getGeneration: () => GENERATION },
    })
    await repo.ensureInitial(scope)
    expect(repo.getHydrationState(scope).phase).toBe("p0")
    const pending = repo.fetchPreviousPage(scope)
    await waitUntil(() => repo.getHydrationState(scope).phase === "p1")
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    release()
    await pending
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "p1",
      p0Satisfied: true,
    })
    expect(fetches).toBeGreaterThan(1)
    repo.destroy()
  })

  test("per-message materialize active is p2 then returns to p0", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => {
        await gate
        return {
          info: assistant("a1", 2, { finish: "stop", parentID: "u1" }),
          parts: [fullTool("t1", "a1", "body")],
        }
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [slimTool("t1", "a1")] },
      ], { complete: true, turnCount: 1 }),
    })
    expect(repo.getHydrationState(scope).phase).toBe("p0")
    const pending = repo.materializeMessage(scope, "a1")
    await waitUntil(() => repo.getHydrationState(scope).phase === "p2")
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    release()
    await pending
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    repo.destroy()
  })

  test("a later empty authority failure keeps the latched P0", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(scope, user("u1"), [text("p1", "u1")])
    await inner.upsertSettled(
      scope,
      assistant("a1", 2, { finish: "stop", parentID: "u1" }),
      [text("p2", "a1", "cached")],
    )
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => {
        throw new Error("authority_unavailable")
      },
      probe: { getTransport: () => TRANSPORT, getGeneration: () => GENERATION },
    })
    await repo.ensureInitial(scope).catch(() => undefined)
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    expect(repo.getHydrationState(scope).phase).toBe("p0")
    repo.apply(scope, { type: "reset" })
    expect(repo.getTranscript(scope).messageOrder).toEqual([])
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    repo.destroy()
  })

  test("runtime generation switch resets hydration to idle", () => {
    const repo = createQueryTranscriptRepository({
      client: client(),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: { getTransport: () => TRANSPORT, getGeneration: () => GENERATION },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1")] },
      ], { complete: true, turnCount: 1 }),
    })
    expect(repo.getHydrationState(scope).p0Satisfied).toBe(true)
    repo.purgeGeneration(TRANSPORT, GENERATION)
    expect(repo.getHydrationState(scope)).toEqual({
      sessionID: SESSION,
      phase: "idle",
      p0Satisfied: false,
    })
    repo.destroy()
  })
})

describe("hydration facades", () => {
  test("unbound runtime reports idle; bound Query forwards the snapshot", () => {
    unbindTranscriptRepository()
    expect(getTranscriptHydrationState(DIRECTORY, SESSION)).toEqual({
      sessionID: SESSION,
      phase: "idle",
      p0Satisfied: false,
    })

    const repo = createQueryTranscriptRepository({
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      transport: TRANSPORT,
      generation: GENERATION,
    })
    bindTranscriptRepositoryInstance(repo)
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1")] },
      ], { complete: true, turnCount: 1 }),
    })
    expect(getTranscriptHydrationState(DIRECTORY, SESSION)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    unbindTranscriptRepository()
    repo.destroy()
  })

  test("store adapter and observer read the same live P0 snapshot", () => {
    unbindTranscriptRepository()
    let state: {
      message: Record<string, Message[]>
      part: Record<string, Part[]>
      session_history_boundary: Record<string, SessionHistoryBoundary>
    } = {
      message: {},
      part: {},
      session_history_boundary: {},
    }
    const listeners = new Set<(next: typeof state, prev: typeof state) => void>()
    const store: TranscriptStoreSurface = {
      getState: () => state as never,
      setState: (partial) => {
        const prev = state
        const next = typeof partial === "function" ? partial(state as never) : partial
        state = { ...state, ...next } as typeof state
        for (const listener of listeners) listener(state, prev)
      },
      subscribe: (listener) => {
        const wrapped = (next: typeof state, prev: typeof state) => listener(next as never, prev as never)
        listeners.add(wrapped)
        return () => {
          listeners.delete(wrapped)
        }
      },
    }
    const repo = createStoreTranscriptRepository({ getStore: () => store })
    repo.apply({ directory: DIRECTORY, sessionID: SESSION }, {
      type: "http-page",
      purpose: "initial",
      page: page([
        { info: user("u1"), parts: [text("p1", "u1")] },
        { info: assistant("a1", 2, { finish: "stop", parentID: "u1" }), parts: [text("p2", "a1")] },
      ], { complete: true, turnCount: 1 }),
    })
    expect(repo.getHydrationState?.({ directory: DIRECTORY, sessionID: SESSION })).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
    expect(readTranscriptHydrationState(DIRECTORY, SESSION, store as never)).toEqual({
      sessionID: SESSION,
      phase: "p0",
      p0Satisfied: true,
    })
  })
})
